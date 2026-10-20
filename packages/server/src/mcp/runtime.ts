import type { CapabilityStore } from "../store/capabilities.js";
import type {
  McpEntry,
  McpServerMeta,
  McpStore,
  McpToolInfo,
} from "../store/mcp.js";
import type { SecretStore } from "../store/secrets.js";
import { McpConnection, type ResolvedMcp } from "./connection.js";
import { buildToolDefs, type McpToolDef } from "./tools.js";

export interface McpStatus {
  state: "ok" | "error";
  error?: string;
  at: string;
}

export type McpRefresh =
  | { ok: true; tools: McpToolInfo[] }
  | { ok: false; error: string };

// 某会话应生效的 MCP server：agent 级名单在前、workspace 级在后，按名字去重；已不在登记库的单列。
export function resolveMcp(
  library: McpServerMeta[],
  agentNames: string[],
  workspaceNames: string[],
): { servers: McpServerMeta[]; missing: string[] } {
  const byName = new Map(library.map((s) => [s.name, s]));
  const servers: McpServerMeta[] = [];
  const missing: string[] = [];
  for (const n of new Set([...agentNames, ...workspaceNames])) {
    const s = byName.get(n);
    if (s) servers.push(s);
    else missing.push(n);
  }
  return { servers, missing };
}

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// MCP 运行时（ADR-0056）：每个登记的 server 一条共享连接，按需建立、断开自动重连；
// 工具列表缓存在库里，会话创建时不必等 server 在线。
export class McpRuntime {
  private readonly conns = new Map<string, McpConnection>();
  private readonly statuses = new Map<string, McpStatus>();

  constructor(
    private readonly deps: {
      mcp: McpStore;
      secrets: SecretStore;
      capabilities: CapabilityStore;
      // 会话所属 agent 引用的 MCP 名单；agent 定义接入前缺省为空。
      agentMcp?: (sessionId: string) => string[];
    },
  ) {}

  status(name: string): McpStatus | undefined {
    return this.statuses.get(name);
  }

  private entries(list: McpEntry[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of list) {
      if (e.secretId === undefined) {
        out[e.key] = e.value ?? "";
        continue;
      }
      const v = this.deps.secrets.reveal(e.secretId);
      if (v === null) throw new Error(`${e.key}：引用的密码库条目已不存在`);
      out[e.key] = `${e.prefix ?? ""}${v}`;
    }
    return out;
  }

  private resolveConfig(name: string): ResolvedMcp {
    const meta = this.deps.mcp.get(name);
    if (!meta) throw new Error("MCP server 已被删除");
    const c = meta.config;
    return c.transport === "stdio"
      ? {
          transport: "stdio",
          command: c.command,
          args: c.args,
          env: this.entries(c.env),
        }
      : { transport: "http", url: c.url, headers: this.entries(c.headers) };
  }

  private conn(name: string): McpConnection {
    let c = this.conns.get(name);
    if (!c) {
      c = new McpConnection(() => this.resolveConfig(name));
      this.conns.set(name, c);
    }
    return c;
  }

  private mark(name: string, err?: unknown) {
    this.statuses.set(name, {
      state: err === undefined ? "ok" : "error",
      ...(err === undefined ? {} : { error: reason(err) }),
      at: new Date().toISOString(),
    });
  }

  // 连上 server、重新列出工具并写回缓存。
  async refresh(name: string): Promise<McpRefresh> {
    try {
      const tools = await this.conn(name).listTools();
      this.deps.mcp.setTools(name, tools);
      this.mark(name);
      return { ok: true, tools };
    } catch (err) {
      this.mark(name, err);
      return { ok: false, error: reason(err) };
    }
  }

  // 配置变更或删除后丢弃旧连接，下次使用按新配置重连。
  async forget(name: string): Promise<void> {
    const c = this.conns.get(name);
    this.conns.delete(name);
    this.statuses.delete(name);
    await c?.close();
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    try {
      const r = await this.conn(server).callTool(tool, args, signal);
      this.mark(server);
      return r;
    } catch (err) {
      this.mark(server, err);
      throw err;
    }
  }

  // 会话创建或恢复时调用：解析生效的 server，没缓存过工具的先连一次，返回要注册的工具。
  async prepare(sessionId: string, workspaceId: string): Promise<McpToolDef[]> {
    const { servers } = resolveMcp(
      this.deps.mcp.list(),
      this.deps.agentMcp?.(sessionId) ?? [],
      this.deps.capabilities.list(workspaceId, "mcp"),
    );
    if (servers.length === 0) return [];
    await Promise.all(
      servers.filter((s) => s.tools === null).map((s) => this.refresh(s.name)),
    );
    return buildToolDefs(
      servers.flatMap((s) => {
        const tools = this.deps.mcp.get(s.name)?.tools;
        return tools ? [{ name: s.name, tools }] : [];
      }),
    );
  }

  async close(): Promise<void> {
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(all.map((c) => c.close()));
  }
}
