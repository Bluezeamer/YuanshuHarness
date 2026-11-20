// `~/.ys/settings.json`：元枢自己的会话设置（压缩与重试），与 pi 的 `~/.pi/agent/settings.json` 互不相干。
// 文件里没写的键 = 跟随 pi 自己的配置（现状不变）；写了就由会话覆盖读取，改完对运行中的会话立即生效。
// 文件就是普通 JSON，人和 agent 都可以直接改；我们只动自己管的键，别的键原样保留。
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { HttpError } from "../lib/http-error.js";
import { isObject } from "../lib/validate.js";

export interface AgentSettings {
  compaction: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  retry: { enabled?: boolean; maxRetries?: number };
}

/** 写入的补丁：键缺省 = 不动；null = 删掉这一项（回到跟随 pi） */
export interface AgentSettingsPatch {
  compaction?: {
    enabled?: boolean | null;
    reserveTokens?: number | null;
    keepRecentTokens?: number | null;
  };
  retry?: { enabled?: boolean | null; maxRetries?: number | null };
}

export const AGENT_SETTINGS_RANGE = {
  reserveTokens: { min: 4096, max: 65536 },
  keepRecentTokens: { min: 4000, max: 200000 },
  maxRetries: { min: 0, max: 10 },
} as const;

export interface AgentSettingsRead {
  values: AgentSettings;
  problems: string[];
}

/** 原文件坏掉时拒绝写：整体重写会冲掉用户自己放进去的内容。 */
export class AgentSettingsError extends HttpError {
  constructor(message: string) {
    super("bad_request", message, 400);
  }
}

export const AGENT_SETTINGS_GROUPS = ["compaction", "retry"] as const;
type Group = (typeof AGENT_SETTINGS_GROUPS)[number];

/** 我们管的键：校验规则与「读时忽略非法项」共用这一份。 */
const ITEMS: Record<
  Group,
  Record<string, { check: (v: unknown) => boolean; why: string }>
> = {
  compaction: {
    enabled: {
      check: (v) => typeof v === "boolean",
      why: "必须是 true 或 false",
    },
    reserveTokens: {
      check: (v) => inRange(v, AGENT_SETTINGS_RANGE.reserveTokens),
      why: rangeText(AGENT_SETTINGS_RANGE.reserveTokens),
    },
    keepRecentTokens: {
      check: (v) => inRange(v, AGENT_SETTINGS_RANGE.keepRecentTokens),
      why: rangeText(AGENT_SETTINGS_RANGE.keepRecentTokens),
    },
  },
  retry: {
    enabled: {
      check: (v) => typeof v === "boolean",
      why: "必须是 true 或 false",
    },
    maxRetries: {
      check: (v) => inRange(v, AGENT_SETTINGS_RANGE.maxRetries),
      why: rangeText(AGENT_SETTINGS_RANGE.maxRetries),
    },
  },
};

function inRange(v: unknown, r: { min: number; max: number }): boolean {
  return (
    typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max
  );
}

function rangeText(r: { min: number; max: number }): string {
  return `必须是 ${r.min}–${r.max} 的整数`;
}

const BAD_JSON = "settings.json 不是合法的 JSON，已忽略";

const emptyValues = (): AgentSettings => ({ compaction: {}, retry: {} });

/** 解析整份文件；不是 JSON 对象返回 null（读时忽略，写时拒绝）。 */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从 JSON 对象里挑出我们认的值；非法项记一句 problems 并忽略。 */
function pick(raw: Record<string, unknown>): AgentSettingsRead {
  const values = emptyValues();
  const problems: string[] = [];
  for (const group of AGENT_SETTINGS_GROUPS) {
    const section = raw[group];
    if (section === undefined) continue;
    if (!isObject(section)) {
      problems.push(`settings.json 里的 ${group} 不是对象，已忽略`);
      continue;
    }
    for (const [key, item] of Object.entries(ITEMS[group])) {
      const v = section[key];
      if (v === undefined) continue;
      if (!item.check(v)) {
        problems.push(
          `settings.json 里的 ${group}.${key} 无效（${item.why}），已忽略`,
        );
        continue;
      }
      // 类型已由 check 保证
      (values[group] as Record<string, unknown>)[key] = v;
    }
  }
  return { values, problems };
}

/** 先整体校验补丁，再把非 null 的值与删掉的键落到原对象的副本上。 */
function applyPatch(
  current: Record<string, unknown>,
  patch: AgentSettingsPatch,
): Record<string, unknown> {
  const next = structuredClone(current);
  for (const group of AGENT_SETTINGS_GROUPS) {
    const changes = patch[group];
    if (changes === undefined) continue;
    const section = isObject(next[group]) ? next[group] : {};
    for (const [key, value] of Object.entries(changes)) {
      const item = ITEMS[group][key];
      if (item === undefined)
        throw new AgentSettingsError(`未知的设置项：${group}.${key}`);
      if (value === null) {
        delete section[key];
        continue;
      }
      if (!item.check(value))
        throw new AgentSettingsError(`${group}.${key} ${item.why}`);
      section[key] = value;
    }
    if (Object.keys(section).length === 0) delete next[group];
    else next[group] = section;
  }
  return next;
}

interface Cached {
  stamp: string;
  raw: Record<string, unknown>;
  read: AgentSettingsRead;
}

export class AgentSettingsFile {
  // 按 mtime 缓存：这些 getter 每次会话检查都会读，文件不动就不重复解析。
  private cache: Cached | undefined;

  constructor(readonly file: string) {}

  /** 读；文件不存在 = 全空。解析失败不抛，也不动文件。 */
  read(): AgentSettingsRead {
    const stamp = this.stamp();
    if (stamp === undefined) return { values: emptyValues(), problems: [] };
    return (
      this.load(stamp)?.read ?? {
        values: emptyValues(),
        problems: [BAD_JSON],
      }
    );
  }

  /** 合并写入补丁，返回写后的读结果；校验不过或原文件损坏时抛，文件不动。 */
  update(patch: AgentSettingsPatch): AgentSettingsRead {
    const stamp = this.stamp();
    if (stamp === undefined) {
      this.write(applyPatch({}, patch));
      return this.read();
    }
    const loaded = this.load(stamp);
    if (!loaded)
      throw new AgentSettingsError(
        "settings.json 现在不是合法 JSON，先改好再从界面保存",
      );
    this.write(applyPatch(loaded.raw, patch));
    return this.read();
  }

  /** 文件的时间戳（纳秒 + 大小 + inode）；不存在或读不了都是 undefined。
   *  只剩「同一时间戳刻度内等长改写」这一种认不出的情况，手改与我们的写入都碰不到。
   *  （时间戳在部分文件系统上按毫秒级粒度走，所以缓存命中时不重复读文件。） */
  private stamp(): string | undefined {
    try {
      const st = statSync(this.file, { bigint: true });
      return `${st.mtimeNs}:${st.size}:${st.ino}`;
    } catch {
      return undefined;
    }
  }

  private load(stamp: string): Cached | undefined {
    if (this.cache?.stamp === stamp) return this.cache;
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return undefined;
    }
    const raw = parseObject(text);
    if (!raw) return undefined;
    const entry = { stamp, raw, read: pick(raw) };
    this.cache = entry;
    return entry;
  }

  /** 原子写：同目录临时文件 + rename，目录不存在就建。 */
  private write(next: Record<string, unknown>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    // rename 换了 inode，时间戳随之变，缓存自然失效
    renameSync(tmp, this.file);
  }
}

/**
 * 让 settingsManager 优先用我们文件里的值：写了就盖住 pi 的普通设置（连同 pi 配置里按模型的
 * override 一起盖住 —— 这是用户在元枢里明确设的），没写才走 pi 原来的链。
 * 每次调用现读文件，所以运行中的会话改完就生效，不需要重建。
 */
export function overlayAgentSettings(
  settingsManager: SettingsManager,
  file: AgentSettingsFile,
): void {
  const baseCompactionEnabled =
    settingsManager.getCompactionEnabled.bind(settingsManager);
  const baseReserveTokens =
    settingsManager.getCompactionReserveTokens.bind(settingsManager);
  const baseKeepRecentTokens =
    settingsManager.getCompactionKeepRecentTokens.bind(settingsManager);
  const baseRetryEnabled =
    settingsManager.getRetryEnabled.bind(settingsManager);
  const baseRetrySettings =
    settingsManager.getRetrySettings.bind(settingsManager);

  const values = () => file.read().values;
  const reserveTokens = (model?: Parameters<typeof baseReserveTokens>[0]) =>
    values().compaction.reserveTokens ?? baseReserveTokens(model);
  const keepRecentTokens = (
    model?: Parameters<typeof baseKeepRecentTokens>[0],
  ) => values().compaction.keepRecentTokens ?? baseKeepRecentTokens(model);

  const override = (name: string, value: unknown) =>
    Object.defineProperty(settingsManager, name, { value });

  override(
    "getCompactionEnabled",
    () => values().compaction.enabled ?? baseCompactionEnabled(),
  );
  override("getCompactionReserveTokens", reserveTokens);
  override("getCompactionKeepRecentTokens", keepRecentTokens);
  // 会话里读的是这个；三项都在这里合成，保证它们给出同一份答案。
  override(
    "getCompactionSettings",
    (model?: Parameters<typeof baseReserveTokens>[0]) => ({
      enabled: values().compaction.enabled ?? baseCompactionEnabled(),
      reserveTokens: reserveTokens(model),
      keepRecentTokens: keepRecentTokens(model),
    }),
  );
  override(
    "getRetryEnabled",
    () => values().retry.enabled ?? baseRetryEnabled(),
  );
  override("getRetrySettings", () => {
    const retry = values().retry;
    const base = baseRetrySettings();
    return {
      ...base,
      ...(retry.enabled === undefined ? {} : { enabled: retry.enabled }),
      ...(retry.maxRetries === undefined
        ? {}
        : { maxRetries: retry.maxRetries }),
    };
  });
}
