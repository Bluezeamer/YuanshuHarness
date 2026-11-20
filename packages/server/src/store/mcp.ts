import { isObject } from "../lib/validate.js";
import { parseSource } from "../mcp/pin.js";
import type { Policy } from "../permission/tool-matrix.js";
import type { Db } from "./db.js";

// exposure 只有两种：direct（直接声明给模型）/ hidden（已登记但不可达）。pi 的 codemode / deferred 不支持。
export const EXPOSURES = ["direct", "hidden"] as const;
export type Exposure = (typeof EXPOSURES)[number];
export const isExposure = (v: unknown): v is Exposure =>
  typeof v === "string" && (EXPOSURES as readonly string[]).includes(v);

// env / headers 的一项：明文值与密码库引用二选一；引用可带前缀（如 "Bearer "）。
export interface McpEntry {
  key: string;
  value?: string;
  secretId?: string;
  prefix?: string;
}

export type McpConfig =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: McpEntry[];
      cwd?: string;
    }
  | { transport: "http"; url: string; headers: McpEntry[] };

// 最近一次握手（启动 + 握手 + 列工具）的结果；失败原因点名，如 401 令牌过期。
export interface McpHandshake {
  ok: boolean;
  tools: number;
  ms: number;
  at: string;
  error?: string;
  /** 失败属于授权类（令牌无效 / 过期 / 无权访问）。 */
  authFailed?: true;
}

// JSON 里与连接无关的那部分条目选项（pi mcpServers 条目的同名字段）。
export interface McpOptions {
  enabled: boolean;
  exposure: Exposure;
  toolExposure: Record<string, Exposure>;
  timeout: number | null;
  oauth: unknown;
}

export const DEFAULT_OPTIONS: McpOptions = {
  enabled: true,
  // direct：工具直接声明给模型（保留字段级 description 与完整 JSON Schema）。
  // 工具多的服务要省 token，用 hidden 加逐工具的 toolExposure: direct 只放行几个。
  exposure: "direct",
  toolExposure: {},
  timeout: null,
  oauth: null,
};

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerMeta extends McpOptions {
  name: string;
  config: McpConfig;
  // 每服务一档，对 mcp__<server>__* 全部工具统一生效，不分 cwd 内外；默认审批。
  approval: Policy;
  // 全局项：每个会话默认带上，不必分给工作区或引用它的预设。
  global: boolean;
  // 来自握手 serverInfo 或包元数据，不接受手填；null = 来源未提供。
  description: string | null;
  handshake: McpHandshake | null;
  // 试装时解析到的最新版（回退到旧版后据此标「低于解析」）。
  latestVersion: string | null;
  // null = 从未成功列出过；列出后缓存，会话创建时不必先连上 server。
  tools: McpToolInfo[] | null;
  toolsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = {
  name: string;
  config: string;
  tools: string | null;
  tools_at: string | null;
  created_at: string;
  updated_at: string;
  approval: string;
  enabled: number;
  exposure: string;
  tool_exposure: string | null;
  timeout: number | null;
  oauth: string | null;
  description: string | null;
  handshake: string | null;
  latest_version: string | null;
  is_global: number;
};
const toMeta = (r: Row): McpServerMeta => ({
  name: r.name,
  config: JSON.parse(r.config) as McpConfig,
  tools: r.tools === null ? null : (JSON.parse(r.tools) as McpToolInfo[]),
  toolsAt: r.tools_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  approval: r.approval as Policy,
  enabled: r.enabled !== 0,
  exposure: r.exposure as Exposure,
  toolExposure:
    r.tool_exposure === null
      ? {}
      : (JSON.parse(r.tool_exposure) as Record<string, Exposure>),
  timeout: r.timeout,
  oauth: r.oauth === null ? null : JSON.parse(r.oauth),
  description: r.description,
  handshake:
    r.handshake === null ? null : (JSON.parse(r.handshake) as McpHandshake),
  latestVersion: r.latest_version,
  global: r.is_global !== 0,
});

// 名字会拼进工具名 mcp__<name>__<tool>，其中 - 会被换成 _，所以 - 与 _ 视为相同、不分大小写。
export const nameKey = (name: string): string =>
  name.toLowerCase().replace(/-/g, "_");

// 同一个包（stdio）：换了包之后「解析到的最新版」不再适用。
const samePackage = (a: McpConfig, b: McpConfig): boolean =>
  parseSource(a)?.pkg === parseSource(b)?.pkg;

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null;

function parseEntries(raw: unknown): McpEntry[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "须为数组";
  const seen = new Set<string>();
  const out: McpEntry[] = [];
  for (const it of raw) {
    if (!isObject(it)) return "每项须为对象";
    const key = text(it.key, 200);
    if (key === null) return "key 须为 1–200 个字符";
    if (seen.has(key)) return `key 重复：${key}`;
    seen.add(key);
    const hasValue = it.value !== undefined;
    const hasSecret = it.secretId !== undefined;
    if (hasValue === hasSecret) return `${key}：value 与 secretId 须二选一`;
    if (hasValue) {
      if (typeof it.value !== "string" || it.value.length > 4096)
        return `${key}：value 须为不超过 4096 字符的字符串`;
      if (it.prefix !== undefined) return `${key}：prefix 只能配合 secretId`;
      out.push({ key, value: it.value });
    } else {
      if (typeof it.secretId !== "string" || it.secretId === "")
        return `${key}：secretId 无效`;
      if (
        it.prefix !== undefined &&
        (typeof it.prefix !== "string" || it.prefix.length > 64)
      )
        return `${key}：prefix 须为不超过 64 字符的字符串`;
      out.push({
        key,
        secretId: it.secretId,
        ...(it.prefix ? { prefix: it.prefix as string } : {}),
      });
    }
  }
  return out;
}

// 解析并校验登记配置；返回错误说明（直接给 REST 的 message）。
export function parseMcpConfig(raw: unknown): McpConfig | string {
  if (!isObject(raw)) return "config 须为对象";
  if (raw.transport === "stdio") {
    const command = text(raw.command, 1024);
    if (command === null) return "command 须为 1–1024 个字符";
    const args = raw.args ?? [];
    if (
      !Array.isArray(args) ||
      args.length > 100 ||
      args.some((a) => typeof a !== "string" || a.length > 4096)
    )
      return "args 须为字符串数组（至多 100 项）";
    const env = parseEntries(raw.env);
    if (typeof env === "string") return `env：${env}`;
    if (raw.cwd !== undefined && text(raw.cwd, 4096) === null)
      return "cwd 须为 1–4096 个字符的字符串";
    return {
      transport: "stdio",
      command,
      args: args as string[],
      env,
      ...(raw.cwd === undefined ? {} : { cwd: raw.cwd as string }),
    };
  }
  if (raw.transport === "http") {
    const url = text(raw.url, 2048);
    let ok = false;
    try {
      ok = url !== null && /^https?:$/.test(new URL(url).protocol);
    } catch {}
    if (url === null || !ok) return "url 须为 http(s) 地址";
    const headers = parseEntries(raw.headers);
    if (typeof headers === "string") return `headers：${headers}`;
    return { transport: "http", url, headers };
  }
  return "transport 须为 stdio 或 http";
}

// MCP 登记库（ADR-0056）。名字即引用 id，也是工具名前缀；改名 = 新增并删除（A10，由 API 层检查引用）。
export class McpStore {
  constructor(private readonly db: Db) {}

  list(): McpServerMeta[] {
    return (
      this.db.prepare("SELECT * FROM mcp_servers ORDER BY name").all() as Row[]
    ).map(toMeta);
  }

  get(name: string): McpServerMeta | undefined {
    const r = this.db
      .prepare("SELECT * FROM mcp_servers WHERE name = ?")
      .get(name) as Row | undefined;
    return r && toMeta(r);
  }

  /** 与 name 重名（- 与 _ 同、不分大小写）的已有条目，exceptName 自己不算。 */
  conflict(name: string, exceptName?: string): string | undefined {
    const key = nameKey(name);
    return this.list().find(
      (s) => s.name !== exceptName && nameKey(s.name) === key,
    )?.name;
  }

  // 名字已存在返回 null。
  create(
    name: string,
    config: McpConfig,
    options: McpOptions = DEFAULT_OPTIONS,
  ): McpServerMeta | null {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO mcp_servers (name, config, created_at, updated_at, enabled, exposure, tool_exposure, timeout, oauth)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          JSON.stringify(config),
          now,
          now,
          options.enabled ? 1 : 0,
          options.exposure,
          JSON.stringify(options.toolExposure),
          options.timeout,
          options.oauth === null || options.oauth === undefined
            ? null
            : JSON.stringify(options.oauth),
        );
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY")
        return null;
      throw err;
    }
    return this.get(name) as McpServerMeta;
  }

  // 配置变了，旧的工具缓存、握手结果与描述随之作废；options 缺省时保留原选项。
  update(
    name: string,
    config: McpConfig,
    options?: McpOptions,
  ): McpServerMeta | undefined {
    const old = this.get(name);
    if (!old) return undefined;
    const o = options ?? old;
    this.db
      .prepare(
        `UPDATE mcp_servers SET config = ?, tools = NULL, tools_at = NULL, handshake = NULL, description = NULL,
           latest_version = ?, enabled = ?, exposure = ?, tool_exposure = ?, timeout = ?, oauth = ?, updated_at = ?
         WHERE name = ?`,
      )
      .run(
        JSON.stringify(config),
        samePackage(old.config, config) ? old.latestVersion : null,
        o.enabled ? 1 : 0,
        o.exposure,
        JSON.stringify(o.toolExposure),
        o.timeout,
        o.oauth === null || o.oauth === undefined
          ? null
          : JSON.stringify(o.oauth),
        new Date().toISOString(),
        name,
      );
    return this.get(name);
  }

  // 审批档、启停与全局标记是行级状态，单独改，不动连接配置也不作废缓存。
  patch(
    name: string,
    p: { approval?: Policy; enabled?: boolean; global?: boolean },
  ): McpServerMeta | undefined {
    const old = this.get(name);
    if (!old) return undefined;
    this.db
      .prepare(
        "UPDATE mcp_servers SET approval = ?, enabled = ?, is_global = ?, updated_at = ? WHERE name = ?",
      )
      .run(
        p.approval ?? old.approval,
        (p.enabled ?? old.enabled) ? 1 : 0,
        (p.global ?? old.global) ? 1 : 0,
        new Date().toISOString(),
        name,
      );
    return this.get(name);
  }

  /** 试装成功后固定：只改命令参数与解析到的最新版，保留握手结果，工具缓存换成试装那一版的。 */
  pin(
    name: string,
    config: McpConfig,
    latestVersion: string,
    tools: McpToolInfo[],
    handshake: McpHandshake,
    description: string | null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mcp_servers SET config = ?, latest_version = ?, tools = ?, tools_at = ?, handshake = ?,
           description = COALESCE(?, description), updated_at = ? WHERE name = ?`,
      )
      .run(
        JSON.stringify(config),
        latestVersion,
        JSON.stringify(tools),
        now,
        JSON.stringify(handshake),
        description,
        now,
        name,
      );
  }

  /** 记最近握手；description 只在拿到非空值时覆盖。 */
  setHandshake(
    name: string,
    handshake: McpHandshake,
    description?: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE mcp_servers SET handshake = ?, description = COALESCE(?, description) WHERE name = ?",
      )
      .run(JSON.stringify(handshake), description || null, name);
  }

  setLatest(name: string, latestVersion: string): void {
    this.db
      .prepare("UPDATE mcp_servers SET latest_version = ? WHERE name = ?")
      .run(latestVersion, name);
  }

  /** 有 server 的 env/headers 引用了这个密码库条目。 */
  referencesSecret(id: string): boolean {
    return this.list().some((s) =>
      (s.config.transport === "stdio" ? s.config.env : s.config.headers).some(
        (e) => e.secretId === id,
      ),
    );
  }

  setTools(name: string, tools: McpToolInfo[]): void {
    this.db
      .prepare("UPDATE mcp_servers SET tools = ?, tools_at = ? WHERE name = ?")
      .run(JSON.stringify(tools), new Date().toISOString(), name);
  }

  // 同时清除 workspace 级分配。
  remove(name: string): boolean {
    return this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM workspace_capabilities WHERE kind = 'mcp' AND name = ?",
        )
        .run(name);
      return (
        this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name)
          .changes > 0
      );
    })();
  }
}
