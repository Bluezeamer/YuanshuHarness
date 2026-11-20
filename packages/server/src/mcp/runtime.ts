import type { Policy } from "../permission/tool-matrix.js";
import type { AuditLog } from "../store/audit.js";
import type { CapabilityStore } from "../store/capabilities.js";
import { auditSkipped } from "../store/capability-refs.js";
import type {
  McpConfig,
  McpEntry,
  McpHandshake,
  McpServerMeta,
  McpStore,
  McpToolInfo,
} from "../store/mcp.js";
import type { SecretStore } from "../store/secrets.js";
import {
  type CheckSteps,
  isAuthError,
  McpConnection,
  type ResolvedMcp,
  reason,
} from "./connection.js";
import { type McpContextItem, mcpContextItem } from "./context.js";
import {
  compareVersionsDesc,
  defaultResolver,
  type McpSource,
  type PkgRuntime,
  parseSource,
  ResolveError,
  type ResolveFailure,
  VERSION_RE,
  type VersionResolver,
  withVersion,
} from "./pin.js";
import { expandVars, type Reveal, resolveEntries } from "./resolve.js";
import { buildToolDefs, type McpToolDef } from "./tools.js";

export interface McpStatus {
  state: "ok" | "error";
  error?: string;
  at: string;
}

export type McpRefresh =
  | { ok: true; tools: McpToolInfo[]; ms: number }
  | { ok: false; error: string; ms: number };

export interface McpCheck {
  name: string;
  ok: boolean;
  ms: number;
  tools: number;
  steps: CheckSteps;
  handshake: McpHandshake;
}

export type PinFailure =
  | "not_pinnable"
  | "invalid_version"
  | ResolveFailure
  | "run_failed";

export type PinResult =
  | {
      ok: true;
      name: string;
      version: string;
      latestVersion: string;
      resolveMs: number;
      check: McpCheck;
    }
  | {
      ok: false;
      name: string;
      error: PinFailure;
      message: string;
      /** 试装那一次的三步结果；解析阶段就失败时没有。 */
      steps?: CheckSteps;
    };

export interface McpVersions {
  name: string;
  runtime: PkgRuntime;
  pkg: string;
  /** 命令里写死的版本；null = 浮动。 */
  current: string | null;
  latest: string;
  versions: { version: string; current: boolean; latest: boolean }[];
}

// 候选列表只给最近这些版本；当前版本不在其中时补进去。
const VERSION_CANDIDATES = 30;
// 试装要现下载包，给得比日常连接宽。
const TRIAL_TIMEOUT_MS = 120_000;

// 某会话应生效的 MCP server：全局在前、agent 级其次、workspace 级在后，按名字去重；已不在登记库的单列。
export function resolveMcp(
  library: McpServerMeta[],
  agentNames: string[],
  workspaceNames: string[],
): { servers: McpServerMeta[]; missing: string[] } {
  const byName = new Map(library.map((s) => [s.name, s]));
  const globalNames = library.filter((s) => s.global).map((s) => s.name);
  const servers: McpServerMeta[] = [];
  const missing: string[] = [];
  for (const n of new Set([...globalNames, ...agentNames, ...workspaceNames])) {
    const s = byName.get(n);
    if (s) servers.push(s);
    else missing.push(n);
  }
  return { servers, missing };
}

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
      audit?: AuditLog;
      /** 版本解析（访问外网）；缺省走 npm view / PyPI，测试里换成桩。 */
      resolver?: VersionResolver;
    },
  ) {}

  private readonly reveal: Reveal = (id) => this.deps.secrets.reveal(id);

  status(name: string): McpStatus | undefined {
    return this.statuses.get(name);
  }

  /** 某个 MCP 服务当前的审批档；服务已不在库里返回 undefined。 */
  approvalOf(name: string): Policy | undefined {
    return this.deps.mcp.get(name)?.approval;
  }

  /** 会话可见的 MCP 服务（全局 ∪ agent 引用 ∪ workspace 分配）及当前状态；不发起任何连接。 */
  contextOf(
    workspaceId: string | null,
    agentNames: string[] = [],
  ): McpContextItem[] {
    const { servers } = resolveMcp(
      this.deps.mcp.list(),
      agentNames,
      workspaceId === null
        ? []
        : this.deps.capabilities.list(workspaceId, "mcp"),
    );
    return servers.map((s) => mcpContextItem(s, this.status(s.name)));
  }

  private resolveFrom(c: McpConfig, timeout: number | null): ResolvedMcp {
    const timeoutMs = timeout === null ? undefined : timeout * 1000;
    return c.transport === "stdio"
      ? {
          transport: "stdio",
          command: c.command,
          args: c.args,
          env: resolveEntries(c.env, this.reveal),
          ...(c.cwd ? { cwd: c.cwd } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        }
      : {
          transport: "http",
          url: expandVars("url", c.url),
          headers: resolveEntries(c.headers, this.reveal),
          ...(timeoutMs ? { timeoutMs } : {}),
        };
  }

  private resolveConfig(name: string): ResolvedMcp {
    const meta = this.deps.mcp.get(name);
    if (!meta) throw new Error("MCP server 已被删除");
    // 我们自己的检测连接惰性重建时，已禁用的服务到这里被挡住（会话里的连接由 pi 管，禁用靠 servers() 过滤）
    if (!meta.enabled) throw new Error("MCP server 已被禁用");
    return this.resolveFrom(meta.config, meta.timeout);
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

  // 连上 server、重新列出工具并写回缓存；同时记下这次握手的耗时与结果。
  async refresh(name: string): Promise<McpRefresh> {
    const conn = this.conn(name);
    const t0 = Date.now();
    try {
      const tools = await conn.listTools();
      const ms = Date.now() - t0;
      this.deps.mcp.setTools(name, tools);
      this.deps.mcp.setHandshake(
        name,
        { ok: true, tools: tools.length, ms, at: new Date().toISOString() },
        conn.serverInfo?.description,
      );
      this.mark(name);
      return { ok: true, tools, ms };
    } catch (err) {
      const ms = Date.now() - t0;
      const error = reason(err);
      this.deps.mcp.setHandshake(name, {
        ok: false,
        tools: 0,
        ms,
        at: new Date().toISOString(),
        error,
        ...(isAuthError(err) ? { authFailed: true as const } : {}),
      });
      this.mark(name, err);
      return { ok: false, error, ms };
    }
  }

  // 检测：丢掉旧连接重走 启动 → 握手 → 列工具，逐步报告；成功时刷新工具缓存。
  async check(name: string): Promise<McpCheck> {
    const conn = this.conn(name);
    const r = await conn.check();
    const failed = Object.values(r.steps).find((x) => x.state === "error");
    const handshake: McpHandshake = {
      ok: r.tools !== null,
      tools: r.tools?.length ?? 0,
      ms: r.ms,
      at: new Date().toISOString(),
      ...(failed?.error ? { error: failed.error } : {}),
      ...(failed?.auth ? { authFailed: true as const } : {}),
    };
    if (r.tools) this.deps.mcp.setTools(name, r.tools);
    this.deps.mcp.setHandshake(name, handshake, conn.serverInfo?.description);
    if (r.tools) this.mark(name);
    else this.mark(name, failed?.error ?? "检测失败");
    return {
      name,
      ok: handshake.ok,
      ms: r.ms,
      tools: handshake.tools,
      steps: r.steps,
      handshake,
    };
  }

  // 只测已启用的，逐个串行。
  async checkAll(): Promise<{
    total: number;
    ready: number;
    results: McpCheck[];
  }> {
    const results: McpCheck[] = [];
    for (const s of this.deps.mcp.list())
      if (s.enabled) results.push(await this.check(s.name));
    return {
      total: results.length,
      ready: results.filter((r) => r.ok).length,
      results,
    };
  }

  private get resolver(): VersionResolver {
    return this.deps.resolver ?? defaultResolver;
  }

  // 候选版本：最近若干个版本，标出当前与最新；查到的最新版顺带记下，列表上的「可更新」就靠它。
  async versions(
    name: string,
  ): Promise<McpVersions | (PinResult & { ok: false })> {
    const meta = this.deps.mcp.get(name);
    const source = meta && parseSource(meta.config);
    if (!meta || !source) return this.notPinnable(name);
    let info: Awaited<ReturnType<VersionResolver["resolve"]>>;
    try {
      info = await this.resolver.resolve(source.runtime, source.pkg);
    } catch (err) {
      return this.resolveFailed(name, err);
    }
    this.deps.mcp.setLatest(name, info.latest);
    const all = [...new Set([info.latest, ...info.versions])]
      .filter((v) => VERSION_RE.test(v))
      .sort(compareVersionsDesc);
    const shown = all.slice(0, VERSION_CANDIDATES);
    if (source.version && !shown.includes(source.version))
      shown.push(source.version);
    return {
      name,
      runtime: source.runtime,
      pkg: source.pkg,
      current: source.version,
      latest: info.latest,
      versions: shown.map((version) => ({
        version,
        current: version === source.version,
        latest: version === info.latest,
      })),
    };
  }

  private notPinnable(name: string): PinResult & { ok: false } {
    return {
      ok: false,
      name,
      error: "not_pinnable",
      message: "只有用 npx 或 uvx 启动的包可以固定版本",
    };
  }

  private resolveFailed(name: string, err: unknown): PinResult & { ok: false } {
    return {
      ok: false,
      name,
      error: err instanceof ResolveError ? err.code : "resolve_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 试装并固定：解析版本 → 在本机装一次并跑 启动/握手/列工具 → 成功才把 pkg@版本 写回命令。
  // 任何一步失败都不写，仍是浮动。version 缺省取解析到的最新版；指定旧版即回退并锁定。
  async tryPin(name: string, version?: string): Promise<PinResult> {
    const meta = this.deps.mcp.get(name);
    const source: McpSource | null = meta ? parseSource(meta.config) : null;
    if (!meta || !source) return this.notPinnable(name);
    if (version !== undefined && !VERSION_RE.test(version))
      return {
        ok: false,
        name,
        error: "invalid_version",
        message: "版本形如 x.y.z",
      };
    const t0 = Date.now();
    let info: Awaited<ReturnType<VersionResolver["resolve"]>>;
    try {
      info = await this.resolver.resolve(source.runtime, source.pkg);
    } catch (err) {
      return this.resolveFailed(name, err);
    }
    const resolveMs = Date.now() - t0;
    const target = version ?? info.latest;
    const candidate = withVersion(meta.config, source, target);
    // 试装用一次性连接，不碰这个服务正在用的共享连接。
    const trial = new McpConnection(() =>
      this.resolveFrom(candidate, meta.timeout ?? TRIAL_TIMEOUT_MS / 1000),
    );
    const r = await trial.check();
    const description = trial.serverInfo?.description ?? info.description;
    await trial.close();
    const failed = Object.values(r.steps).find((x) => x.state === "error");
    if (!r.tools)
      return {
        ok: false,
        name,
        error: "run_failed",
        message: `${source.pkg}@${target} 试装失败：${failed?.error ?? "未知原因"}`,
        steps: r.steps,
      };
    const handshake: McpHandshake = {
      ok: true,
      tools: r.tools.length,
      ms: r.ms,
      at: new Date().toISOString(),
    };
    this.deps.mcp.pin(
      name,
      candidate,
      info.latest,
      r.tools,
      handshake,
      description,
    );
    await this.forget(name);
    return {
      ok: true,
      name,
      version: target,
      latestVersion: info.latest,
      resolveMs,
      check: {
        name,
        ok: true,
        ms: r.ms,
        tools: r.tools.length,
        steps: r.steps,
        handshake,
      },
    };
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

  // 会话创建或恢复时调用：解析生效的 server（全局 ∪ agent 引用 ∪ workspace 分配），
  // 没缓存过工具的先连一次，返回该会话可达的工具（白名单与审批映射用，注册给模型的是 pi 的 MCP 扩展）。库里不存在的引用跳过并记审计。
  async prepare(
    sessionId: string,
    workspaceId: string | null,
    agentNames: string[] = [],
  ): Promise<McpToolDef[]> {
    const { servers, missing } = resolveMcp(
      this.deps.mcp.list(),
      agentNames,
      workspaceId === null
        ? []
        : this.deps.capabilities.list(workspaceId, "mcp"),
    );
    auditSkipped(this.deps.audit, sessionId, "mcp", missing);
    // 已禁用的服务不带工具。
    const live = servers.filter((s) => s.enabled);
    if (live.length === 0) return [];
    await Promise.all(
      live.filter((s) => s.tools === null).map((s) => this.refresh(s.name)),
    );
    return buildToolDefs(
      live.flatMap((s) => {
        const fresh = this.deps.mcp.get(s.name);
        // hidden（含按工具覆盖）= 已登记但不可达：不进可达名单。
        const tools = fresh?.tools?.filter(
          (t) => (fresh.toolExposure[t.name] ?? fresh.exposure) !== "hidden",
        );
        return tools ? [{ name: s.name, tools }] : [];
      }),
    );
  }

  // 该会话生效的 server 登记（不含连接）：交给 pi 的 MCP 扩展去连并注册工具。
  // 失效引用的审计由 prepare() 负责，这里不重复记。
  servers(
    workspaceId: string | null,
    agentNames: string[] = [],
  ): McpServerMeta[] {
    return resolveMcp(
      this.deps.mcp.list(),
      agentNames,
      workspaceId === null
        ? []
        : this.deps.capabilities.list(workspaceId, "mcp"),
    ).servers.filter((s) => s.enabled);
  }

  async close(): Promise<void> {
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(all.map((c) => c.close()));
  }
}
