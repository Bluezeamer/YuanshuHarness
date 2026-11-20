import { isObject } from "../lib/validate.js";
import { isTier, type Tier } from "../permission/tier.js";
import type { ModelResolver } from "../provider/resolve.js";
import type { DefaultsStore } from "../store/defaults.js";
import { THINKING_LEVELS } from "../store/providers.js";
import type {
  ConfigBody,
  ConfigModel,
  SessionConfig,
  SessionConfigStore,
} from "../store/session-configs.js";
import { CAPABILITY_UNITS } from "./capabilities.js";
import { TOOL_NAMES } from "./tool-catalog.js";

// 400 带可读 code；409 带服务端当前值；404 会话不存在。
export class ConfigError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly detail?: string,
    readonly current?: SessionConfig,
  ) {
    super(detail ?? code);
  }
}

function bad(code: string, detail?: string): never {
  throw new ConfigError(400, code, detail);
}

const SECTIONS = ["model", "capabilities", "permissionTier"] as const;
export type ConfigSection = (typeof SECTIONS)[number];

// 改了要等会话重新装载才读到的分区：能力决定工具白名单，只能在装载时生效。
// 模型与权限档位是热读取（模型当下一次同步生效，档位每次工具调用都重读）。
const COLD: readonly ConfigSection[] = ["capabilities"];

const LIST_MAX = 200;
const ID_MAX = 200;
const CAP_RE = /^(tool|skills|mcp|unit):/;

const idText = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && v.length <= ID_MAX;

export interface ConfigDeps {
  store: SessionConfigStore;
  resolver: ModelResolver;
  /** 选「模型」档要先配好审批模型。 */
  defaults: DefaultsStore;
}

// 会话配置：存取、校验、合并，以及给运行时读的几个取值函数。
export class SessionConfigService {
  constructor(private readonly deps: ConfigDeps) {}

  stored(sessionId: string): SessionConfig | null {
    return this.deps.store.get(sessionId);
  }

  remove(sessionId: string): void {
    this.deps.store.remove(sessionId);
  }

  // 没有落库的会话（迁移前的旧数据）按最宽松的默认值合成，rev = 0。
  defaults(sessionId: string): SessionConfig {
    return {
      sessionId,
      model: { mode: "follow-default" },
      capabilities: null,
      permissionTier: null,
      rev: 0,
    };
  }

  get(sessionId: string): SessionConfig {
    return this.stored(sessionId) ?? this.defaults(sessionId);
  }

  // 创建会话时的整份配置：base 是预设默认值，raw 是用户在面板上的覆盖。
  parseNew(base: ConfigBody, raw: unknown): ConfigBody {
    if (raw === undefined) return base;
    if (!isObject(raw)) return bad("bad_request", "config 必须是对象");
    return this.merge(base, raw, false).body;
  }

  // 乐观并发修改：baseRev 必须等于当前 rev（未落库为 0）。返回新配置与本次实际变动的分区。
  patch(
    sessionId: string,
    raw: unknown,
  ): { config: SessionConfig; changed: ConfigSection[] } {
    if (!isObject(raw)) return bad("bad_request", "body 必须是对象");
    const { baseRev, patch } = raw;
    if (!Number.isInteger(baseRev) || (baseRev as number) < 0)
      return bad("bad_request", "baseRev 必须是非负整数");
    if (!isObject(patch)) return bad("bad_request", "patch 必须是对象");
    const cur = this.get(sessionId);
    const conflict = (c: SessionConfig) =>
      new ConfigError(409, "conflict", undefined, c);
    if (cur.rev !== baseRev) throw conflict(cur);
    const { body, changed } = this.merge(bodyOf(cur), patch, true);
    const saved = this.deps.store.save(sessionId, body, cur.rev);
    if (!saved) throw conflict(this.get(sessionId));
    return { config: saved, changed };
  }

  insert(sessionId: string, body: ConfigBody): void {
    this.deps.store.save(sessionId, body, 0);
  }

  // 顶层分区整体替换；sessionId 与 rev 由服务端管，传了也忽略。
  private merge(
    base: ConfigBody,
    patch: Record<string, unknown>,
    existing: boolean,
  ): { body: ConfigBody; changed: ConfigSection[] } {
    const body: ConfigBody = structuredClone(base);
    for (const k of Object.keys(patch))
      if (
        k !== "sessionId" &&
        k !== "rev" &&
        !SECTIONS.includes(k as ConfigSection)
      )
        return bad("unknown_field", k);
    const keys = SECTIONS.filter((k) => patch[k] !== undefined);
    if (existing && keys.length === 0)
      return bad("bad_request", "没有可修改的字段");
    for (const k of keys) {
      const v = patch[k];
      if (k === "model") body.model = this.model(v);
      else if (k === "capabilities") body.capabilities = this.capabilities(v);
      else body.permissionTier = this.permissionTier(v);
    }
    const changed = keys.filter(
      (k) => JSON.stringify(body[k]) !== JSON.stringify(base[k]),
    );
    return { body, changed };
  }

  // provider 即模型登记 id，model 即登记条目的模型名。
  private registered(provider: unknown, model: unknown, code: string): void {
    if (!idText(provider) || !idText(model))
      bad("bad_request", "provider 与 model 必须是非空字符串");
    if (!this.deps.resolver.has(provider as string, model as string))
      bad(code, `${provider}/${model}`);
  }

  private model(v: unknown): ConfigModel {
    if (!isObject(v)) return bad("bad_request", "model 必须是对象");
    if (v.mode === "follow-default") return { mode: "follow-default" };
    if (v.mode !== "explicit") return bad("bad_request", "model.mode 非法");
    this.registered(v.provider, v.model, "unknown_model");
    if (!(THINKING_LEVELS as readonly unknown[]).includes(v.reasoning))
      return bad("bad_reasoning", String(v.reasoning));
    return {
      mode: "explicit",
      provider: v.provider as string,
      model: v.model as string,
      reasoning: v.reasoning as string,
    };
  }

  // 能力 id：tool:名字 必须是内置工具；技能与 MCP 允许引用库里暂时不存在的名字（运行时跳过并留审计）。
  private capabilities(v: unknown): string[] | null {
    if (v === null) return null;
    if (!Array.isArray(v) || v.length > LIST_MAX)
      return bad("bad_request", "capabilities 必须是数组或 null");
    const seen = new Set<string>();
    for (const c of v as unknown[]) {
      if (!idText(c) || !CAP_RE.test(c))
        return bad("bad_request", `能力 id 非法：${String(c)}`);
      if (seen.has(c)) return bad("duplicate_capability", c);
      seen.add(c);
      if (c.startsWith("tool:") && !TOOL_NAMES.has(c.slice(5)))
        return bad("unknown_tool", c.slice(5));
      if (c.startsWith("unit:") && !(c in CAPABILITY_UNITS))
        return bad("unknown_unit", c.slice(5));
    }
    return [...seen];
  }

  private permissionTier(v: unknown): Tier | null {
    if (v === null) return null;
    if (!isTier(v))
      return bad("bad_request", "permissionTier 只能是 rules / auto / full");
    if (v === "auto" && this.deps.defaults.reviewModel() === null)
      return bad("review_model_missing", "「模型」档要先在设置里配审批模型");
    return v;
  }

  // 会话自己覆盖的审批档；没覆盖返回 undefined，由调用方跟随全局默认。
  tierOf(sessionId: string): Tier | undefined {
    return this.stored(sessionId)?.permissionTier ?? undefined;
  }

  // 会话创建 / 装载时用的模型与思考级别；follow-default 或没配置返回 null。
  modelOf(
    sessionId: string,
  ): { modelId: string; model: string; thinkingLevel: string } | null {
    return explicitModel(this.stored(sessionId)?.model);
  }
}

export const explicitModel = (
  m: ConfigModel | undefined,
): { modelId: string; model: string; thinkingLevel: string } | null =>
  m?.mode === "explicit"
    ? { modelId: m.provider, model: m.model, thinkingLevel: m.reasoning }
    : null;

export const bodyOf = ({
  sessionId: _s,
  rev: _r,
  ...body
}: SessionConfig): ConfigBody => body;

// 本次变动里有没有热不了的分区：有就要等下一轮（装载）才生效。
export const needsReload = (changed: readonly ConfigSection[]): boolean =>
  changed.some((k) => COLD.includes(k));
