import type { Db } from "./db.js";

// env / headers 的一项：明文值与密码库引用二选一；引用可带前缀（如 "Bearer "）。
export interface McpEntry {
  key: string;
  value?: string;
  secretId?: string;
  prefix?: string;
}

export type McpConfig =
  | { transport: "stdio"; command: string; args: string[]; env: McpEntry[] }
  | { transport: "http"; url: string; headers: McpEntry[] };

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerMeta {
  name: string;
  config: McpConfig;
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
};
const toMeta = (r: Row): McpServerMeta => ({
  name: r.name,
  config: JSON.parse(r.config) as McpConfig,
  tools: r.tools === null ? null : (JSON.parse(r.tools) as McpToolInfo[]),
  toolsAt: r.tools_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
    return { transport: "stdio", command, args: args as string[], env };
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

// MCP 登记库（ADR-0056）。名字即引用 id，也是工具名前缀，登记后不可改名。
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

  // 名字已存在返回 null。
  create(name: string, config: McpConfig): McpServerMeta | null {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          "INSERT INTO mcp_servers (name, config, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(name, JSON.stringify(config), now, now);
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY")
        return null;
      throw err;
    }
    return this.get(name) as McpServerMeta;
  }

  // 配置变了，旧的工具缓存随之作废。
  update(name: string, config: McpConfig): McpServerMeta | undefined {
    const r = this.db
      .prepare(
        "UPDATE mcp_servers SET config = ?, tools = NULL, tools_at = NULL, updated_at = ? WHERE name = ?",
      )
      .run(JSON.stringify(config), new Date().toISOString(), name);
    return r.changes > 0 ? this.get(name) : undefined;
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
