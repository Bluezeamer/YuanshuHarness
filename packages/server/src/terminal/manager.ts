import type { ExecEnv } from "../env/types.js";
import { uuidv7 } from "../id.js";
import { HttpError } from "../lib/http-error.js";
import type { AuditLog } from "../store/audit.js";
import {
  fromChannel,
  openLocal,
  type PtyBackend,
  SpawnError,
} from "./backends.js";

export type CloseReason = "user" | "exit" | "shutdown";

type TerminalErrorCode =
  | "too_many_terminals"
  | "pty_unavailable"
  | "spawn_failed";

const TERMINAL_STATUS: Record<TerminalErrorCode, number> = {
  too_many_terminals: 429,
  pty_unavailable: 501,
  spawn_failed: 502,
};

export class TerminalError extends HttpError {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
  ) {
    super(code, message, TERMINAL_STATUS[code]);
  }
}

// 订阅终端输出的一端（一条 WebSocket）。send 抛错表示该端已不可用，会被摘除。
export interface TerminalClient {
  send(chunk: Buffer): void;
  /** 终端结束时调用；exitCode 仅在 reason 为 exit 时有意义。 */
  end(reason: CloseReason, exitCode: number | null): void;
}

export interface TerminalInfo {
  id: string;
  environmentId: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  /** 归属的工作区；从会话页以外（或旧客户端）创建时没有。 */
  workspaceId: string | null;
}

/** 列表与详情的单项：创建信息加上随时变化的运行状态。 */
export interface TerminalStatus extends TerminalInfo {
  attached: number;
  /** pty 读取是否被流控暂停。 */
  paused: boolean;
  /** 前台是否有 shell 之外的进程；ssh 环境无法判断为 null。 */
  busy: boolean | null;
}

export interface TerminalOptions {
  /** 终端数量的安全阀；终端只在显式关闭、shell 退出或 Server 停止时结束。 */
  max: number;
  /** 回放缓冲上限（字节），也是无人查看时允许累积的未读输出上限。 */
  scrollbackBytes: number;
}

export const TERMINAL_DEFAULTS: TerminalOptions = {
  max: 32,
  scrollbackBytes: 256 * 1024,
};

export class Terminal {
  private readonly clients = new Set<TerminalClient>();
  // 输出积压超过高水位的客户端；任一端积压就暂停 pty。
  private readonly congested = new Set<TerminalClient>();
  private chunks: Buffer[] = [];
  private bytes = 0;
  // 无人附着期间累计、还没有任何客户端看过的输出字节数。
  private unseen = 0;
  private paused = false;
  private ended = false;

  constructor(
    readonly info: TerminalInfo,
    private readonly backend: PtyBackend,
    private readonly cfg: TerminalOptions,
    private readonly onEnded: (
      t: Terminal,
      r: CloseReason,
      code: number | null,
    ) => void,
  ) {
    backend.onData((d) => this.output(d));
    backend.onExit((code) => this.end("exit", code));
  }

  get attached(): number {
    return this.clients.size;
  }

  status(): TerminalStatus {
    return {
      ...this.info,
      attached: this.clients.size,
      paused: this.paused,
      busy: this.ended ? null : this.backend.busy(),
    };
  }

  private output(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.cfg.scrollbackBytes && this.chunks.length > 1)
      this.bytes -= (this.chunks.shift() as Buffer).length;
    const first = this.chunks[0] as Buffer;
    if (this.bytes > this.cfg.scrollbackBytes) {
      // 单块就超限：只留尾部。
      this.chunks[0] = first.subarray(first.length - this.cfg.scrollbackBytes);
      this.bytes = this.cfg.scrollbackBytes;
    }
    for (const c of this.clients) {
      try {
        c.send(chunk);
      } catch {
        this.detach(c);
      }
    }
    // 没人收到这块输出：只留回放缓冲，积压够多就停止读取，让子进程阻塞而不是无限产出。
    if (this.clients.size === 0) this.unseen += chunk.length;
    this.syncFlow();
  }

  // 返回回放内容；调用方须同步发给该端，之后的输出才不会与回放错序。
  attach(client: TerminalClient): Buffer {
    this.clients.add(client);
    // 回放已覆盖缓冲里的全部内容，此前无人看过的输出算作已交付。
    this.unseen = 0;
    this.syncFlow();
    const all = Buffer.concat(this.chunks);
    // 截断可能落在多字节字符中间，跳过开头的续字节。
    let skip = 0;
    while (
      skip < 3 &&
      skip < all.length &&
      ((all[skip] as number) & 0xc0) === 0x80
    )
      skip++;
    return all.subarray(skip);
  }

  detach(client: TerminalClient): void {
    this.clients.delete(client);
    this.congested.delete(client);
    this.syncFlow();
  }

  /** 客户端报告自己的发送积压是否越过高水位（降到低水位才报 false，滞回由调用方负责）。 */
  congest(client: TerminalClient, on: boolean): void {
    if (!this.clients.has(client)) return;
    if (on) this.congested.add(client);
    else this.congested.delete(client);
    this.syncFlow();
  }

  input(data: string): void {
    if (!this.ended) this.backend.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ended) return;
    this.backend.resize(cols, rows);
    this.info.cols = cols;
    this.info.rows = rows;
  }

  end(reason: CloseReason, exitCode: number | null = null): void {
    if (this.ended) return;
    this.ended = true;
    if (reason !== "exit") this.backend.kill();
    for (const c of this.clients) {
      try {
        c.end(reason, exitCode);
      } catch {
        // 连接已断，无需通知。
      }
    }
    this.clients.clear();
    this.onEnded(this, reason, exitCode);
  }

  // 暂停只停止读取，不会杀 shell；条件解除（有人附着且追上）后恢复。
  private syncFlow(): void {
    if (this.ended) return;
    const want =
      this.congested.size > 0 ||
      (this.clients.size === 0 && this.unseen > this.cfg.scrollbackBytes);
    if (want === this.paused) return;
    this.paused = want;
    if (want) this.backend.pause();
    else this.backend.resume();
  }
}

// 终端是用户在 WebUI 里的交互 shell，不受 agent 权限档位约束；开关写审计，输入输出不记。
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  // 已通过上限检查、尚在建立中的终端数；否则并发创建会冲过上限。
  private opening = 0;
  private readonly cfg: TerminalOptions;

  constructor(
    private readonly audit?: AuditLog,
    over: Partial<TerminalOptions> = {},
  ) {
    this.cfg = { ...TERMINAL_DEFAULTS, ...over };
  }

  get(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  /** 全部存活的终端，按创建先后。 */
  list(): Terminal[] {
    return [...this.terminals.values()];
  }

  async create(
    env: ExecEnv,
    req: {
      cwd?: string;
      cols: number;
      rows: number;
      /** 终端是从哪个会话页打开的；只用于审计归属。 */
      sessionId?: string | null;
      /** 终端属于哪个工作区；删工作区时要能找到并关掉它。 */
      workspaceId?: string | null;
    },
  ): Promise<Terminal> {
    if (this.terminals.size + this.opening >= this.cfg.max)
      throw new TerminalError(
        "too_many_terminals",
        `终端数量已达上限 ${this.cfg.max}，可先关闭不用的终端`,
      );
    this.opening++;
    const t0 = Date.now();
    try {
      const cwd = req.cwd ?? (await env.homedir());
      const backend = await this.open(env, req);
      const t = new Terminal(
        {
          id: uuidv7(),
          environmentId: env.id,
          cwd,
          cols: req.cols,
          rows: req.rows,
          createdAt: new Date().toISOString(),
          workspaceId: req.workspaceId ?? null,
        },
        backend,
        this.cfg,
        (term, reason, code) =>
          this.ended(term, reason, code, req.sessionId ?? null),
      );
      this.terminals.set(t.info.id, t);
      this.audit?.record({
        sessionId: req.sessionId ?? null,
        actor: "user",
        kind: "terminal",
        environmentId: env.id,
        summary: `open ${cwd}`,
        detail: {
          op: "open",
          target: cwd,
          result: "ok",
          durationMs: Date.now() - t0,
          terminalId: t.info.id,
          cols: req.cols,
          rows: req.rows,
        },
      });
      return t;
    } catch (err) {
      if (err instanceof SpawnError || err instanceof TerminalError)
        throw new TerminalError(err.code, err.message);
      throw new TerminalError(
        "spawn_failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.opening--;
    }
  }

  private async open(
    env: ExecEnv,
    req: { cwd?: string; cols: number; rows: number },
  ): Promise<PtyBackend> {
    const size = { cols: req.cols, rows: req.rows };
    const cwd = req.cwd === undefined ? {} : { cwd: req.cwd };
    // ssh 环境开 shell 通道（虚拟 ~/.pi 那层只改文件原语，shell 原样透传）。
    if (env.openShell)
      return fromChannel(await env.openShell({ ...size, ...cwd }));
    return openLocal({ ...size, ...cwd });
  }

  destroy(id: string, reason: CloseReason = "user"): boolean {
    const t = this.terminals.get(id);
    t?.end(reason);
    return t !== undefined;
  }

  /** 关闭某个工作区的全部终端，返回关闭数。 */
  destroyWorkspace(workspaceId: string): number {
    const hit = this.list().filter((t) => t.info.workspaceId === workspaceId);
    for (const t of hit) t.end("user");
    return hit.length;
  }

  closeAll(): void {
    for (const t of [...this.terminals.values()]) t.end("shutdown");
  }

  private ended(
    t: Terminal,
    reason: CloseReason,
    exitCode: number | null,
    sessionId: string | null,
  ): void {
    this.terminals.delete(t.info.id);
    this.audit?.record({
      sessionId,
      actor: reason === "user" ? "user" : "system",
      kind: "terminal",
      environmentId: t.info.environmentId,
      summary: `close ${reason}`,
      detail: {
        op: "close",
        target: t.info.cwd,
        result: "ok",
        terminalId: t.info.id,
        reason,
        durationMs: Date.now() - Date.parse(t.info.createdAt),
        ...(reason === "exit" ? { exitCode } : {}),
      },
    });
  }
}
