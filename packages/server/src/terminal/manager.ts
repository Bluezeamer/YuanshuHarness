import { SshEnv } from "../env/ssh.js";
import type { ExecEnv } from "../env/types.js";
import { uuidv7 } from "../id.js";
import type { AuditLog } from "../store/audit.js";
import {
  fromChannel,
  openLocal,
  type PtyBackend,
  SpawnError,
} from "./backends.js";

export type CloseReason = "user" | "exit" | "idle" | "shutdown";

export class TerminalError extends Error {
  constructor(
    readonly code: "too_many_terminals" | "pty_unavailable" | "spawn_failed",
    message: string,
  ) {
    super(message);
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
}

export interface TerminalOptions {
  max: number;
  /** 无人连接多久后回收。 */
  idleMs: number;
  /** 回放缓冲上限（字节）。 */
  scrollbackBytes: number;
}

export const TERMINAL_DEFAULTS: TerminalOptions = {
  max: 8,
  idleMs: 5 * 60_000,
  scrollbackBytes: 256 * 1024,
};

export class Terminal {
  readonly createdAt = Date.now();
  private readonly clients = new Set<TerminalClient>();
  private chunks: Buffer[] = [];
  private bytes = 0;
  private idle: NodeJS.Timeout | undefined;
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
    this.armIdle();
  }

  get attached(): number {
    return this.clients.size;
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
  }

  // 返回回放内容；调用方须同步发给该端，之后的输出才不会与回放错序。
  attach(client: TerminalClient): Buffer {
    this.clients.add(client);
    clearTimeout(this.idle);
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
    if (this.clients.size === 0) this.armIdle();
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
    clearTimeout(this.idle);
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

  private armIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.end("idle"), this.cfg.idleMs);
    this.idle.unref();
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

  async create(
    env: ExecEnv,
    req: {
      cwd?: string;
      cols: number;
      rows: number;
      /** 终端是从哪个会话页打开的；只用于审计归属。 */
      sessionId?: string | null;
    },
  ): Promise<Terminal> {
    if (this.terminals.size + this.opening >= this.cfg.max)
      throw new TerminalError(
        "too_many_terminals",
        `终端数量已达上限 ${this.cfg.max}`,
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
    if (env instanceof SshEnv)
      return fromChannel(await env.shell({ ...size, ...cwd }));
    return openLocal({ ...size, ...cwd });
  }

  destroy(id: string, reason: CloseReason = "user"): boolean {
    const t = this.terminals.get(id);
    t?.end(reason);
    return t !== undefined;
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
        durationMs: Date.now() - t.createdAt,
        ...(reason === "exit" ? { exitCode } : {}),
      },
    });
  }
}
