import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpToolInfo } from "../store/mcp.js";

// 密钥引用已展开的连接参数；只在建立连接的瞬间生成，不落库。
// timeoutMs 是条目自己配的超时（秒转毫秒），缺省用下面的常量。
export type ResolvedMcp =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      transport: "http";
      url: string;
      headers: Record<string, string>;
      timeoutMs?: number;
    };

export interface McpCallResult {
  content: unknown[];
  isError: boolean;
}

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const STDERR_TAIL = 2000;

// 失败原因点名：HTTP 状态码带上含义（401 = 令牌无效或已过期），不吞成一句「连接失败」。
export function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown }).code;
  if (code === 401) return `HTTP 401 未授权（令牌无效或已过期）：${msg}`;
  if (code === 403) return `HTTP 403 无权访问：${msg}`;
  if (typeof code === "number" && code >= 400 && code < 600)
    return `HTTP ${code}：${msg}`;
  if (msg === "Unauthorized") return "未授权（令牌无效或已过期）";
  return msg;
}

// 授权类失败（令牌无效 / 过期 / 无权访问）：界面据此提示重新授权，不靠解析报错文字。
export function isAuthError(err: unknown): boolean {
  if (err instanceof McpStepError) return err.auth;
  const code = (err as { code?: unknown }).code;
  return (
    code === 401 ||
    code === 403 ||
    (err instanceof Error && err.message === "Unauthorized")
  );
}

export type CheckStep = "start" | "handshake" | "list";
export interface StepResult {
  state: "ok" | "error" | "skipped";
  ms: number;
  error?: string;
  /** 失败属于授权类（见 isAuthError）。 */
  auth?: true;
}
export type CheckSteps = Record<CheckStep, StepResult>;

export interface ServerInfo {
  name: string;
  version: string;
  description?: string;
}

// 连接失败时带上卡在哪一步与各步耗时，检测据此逐步报告。
export class McpStepError extends Error {
  constructor(
    readonly step: "start" | "handshake",
    message: string,
    readonly startMs: number,
    readonly handshakeMs: number,
    readonly auth = false,
  ) {
    super(message);
  }
}

// 一个 MCP server 的客户端连接：首次使用时连上，断开后下次使用自动重连。
export class McpConnection {
  private client: Client | null = null;
  private opening: Promise<Client> | null = null;
  // 最近一次连接的各步耗时与 serverInfo（握手返回的）。
  timing: { startMs: number; handshakeMs: number } | null = null;
  serverInfo: ServerInfo | null = null;

  constructor(private readonly resolve: () => ResolvedMcp) {}

  private timeoutMs = CALL_TIMEOUT_MS;

  private open(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<Client> {
    const cfg = this.resolve();
    this.timeoutMs = cfg.timeoutMs ?? CALL_TIMEOUT_MS;
    let stderrTail = "";
    let transport: Transport;
    if (cfg.transport === "stdio") {
      const t = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
        stderr: "pipe",
      });
      t.stderr?.on("data", (b: Buffer) => {
        stderrTail = (stderrTail + b.toString()).slice(-STDERR_TAIL);
      });
      transport = t;
    } else {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers: cfg.headers },
      });
    }
    // Client.connect 把「启动传输」与「initialize 握手」合在一起；包一层 start 分开计时。
    const t0 = Date.now();
    let startMs = 0;
    let started = false;
    const start = transport.start.bind(transport);
    transport.start = async () => {
      const s = Date.now();
      try {
        await start();
        started = true;
      } finally {
        startMs = Date.now() - s;
      }
    };
    const client = new Client({ name: "yuanshu", version: "0.0.0" });
    try {
      await client.connect(transport, {
        timeout: cfg.timeoutMs ?? CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      await client.close().catch(() => {});
      const tail = stderrTail.trim();
      throw new McpStepError(
        started ? "handshake" : "start",
        `${reason(err)}${tail ? `；stderr：${tail}` : ""}`,
        startMs,
        Math.max(0, Date.now() - t0 - startMs),
        isAuthError(err),
      );
    }
    this.timing = {
      startMs,
      handshakeMs: Math.max(0, Date.now() - t0 - startMs),
    };
    const info = client.getServerVersion();
    this.serverInfo = info
      ? {
          name: info.name,
          version: info.version,
          ...(info.description?.trim()
            ? { description: info.description.trim() }
            : {}),
        }
      : null;
    client.onclose = () => {
      if (this.client === client) this.client = null;
    };
    this.client = client;
    return client;
  }

  // 检测：丢掉旧连接，重新走一遍 启动 → 握手 → 列工具，逐步给出耗时与失败原因。成功时连接保留。
  async check(): Promise<{
    steps: CheckSteps;
    tools: McpToolInfo[] | null;
    ms: number;
  }> {
    const t0 = Date.now();
    const skipped: StepResult = { state: "skipped", ms: 0 };
    const steps: CheckSteps = {
      start: skipped,
      handshake: skipped,
      list: skipped,
    };
    await this.close();
    try {
      await this.open();
    } catch (err) {
      const e =
        err instanceof McpStepError
          ? err
          : new McpStepError("start", reason(err), 0, 0, isAuthError(err));
      const auth = e.auth ? { auth: true as const } : {};
      steps.start =
        e.step === "start"
          ? { state: "error", ms: e.startMs, error: e.message, ...auth }
          : { state: "ok", ms: e.startMs };
      if (e.step === "handshake")
        steps.handshake = {
          state: "error",
          ms: e.handshakeMs,
          error: e.message,
          ...auth,
        };
      return { steps, tools: null, ms: Date.now() - t0 };
    }
    steps.start = { state: "ok", ms: this.timing?.startMs ?? 0 };
    steps.handshake = { state: "ok", ms: this.timing?.handshakeMs ?? 0 };
    const t1 = Date.now();
    try {
      const tools = await this.listTools();
      steps.list = { state: "ok", ms: Date.now() - t1 };
      return { steps, tools, ms: Date.now() - t0 };
    } catch (err) {
      steps.list = {
        state: "error",
        ms: Date.now() - t1,
        error: reason(err),
        ...(isAuthError(err) ? { auth: true as const } : {}),
      };
      return { steps, tools: null, ms: Date.now() - t0 };
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const client = await this.open();
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools)
        out.push({
          name: t.name,
          description: t.description?.trim() || t.title || "",
          inputSchema: t.inputSchema as Record<string, unknown>,
        });
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const client = await this.open();
    const r = await client.callTool({ name, arguments: args }, undefined, {
      timeout: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return {
      content: Array.isArray(r.content) ? r.content : [],
      isError: r.isError === true,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await (await this.opening?.catch(() => null))?.close().catch(() => {});
    await client?.close().catch(() => {});
  }
}
