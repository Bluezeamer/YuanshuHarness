import { constants as osConstants } from "node:os";
import type { SshConnection } from "../ssh/connection.js";
import type { OsType } from "../store/environments.js";
import type {
  DirEntry,
  EnvStatus,
  ExecEnv,
  ExecOptions,
  FileStat,
} from "./types.js";

/** POSIX shell 单引号转义。 */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// ssh 环境：首次使用与掉线后的下一次使用时自动（重）连；原语失败时如实抛错，不静默重试。
export class SshEnv implements ExecEnv {
  readonly kind = "ssh" as const;
  private connecting: Promise<void> | null = null;
  private home: string | null = null;
  private lastError: string | null = null;

  constructor(
    readonly id: string,
    readonly os: OsType,
    private readonly conn: SshConnection,
  ) {}

  status(): EnvStatus {
    if (this.conn.isConnected()) return { id: this.id, state: "connected" };
    return this.lastError
      ? { id: this.id, state: "error", error: this.lastError }
      : { id: this.id, state: "disconnected" };
  }

  /** 主动连接（用于“测试连接”）；失败抛错并记录原因。 */
  async connect(): Promise<void> {
    if (this.conn.isConnected()) return;
    this.connecting ??= this.conn
      .connect()
      .then(() => {
        this.lastError = null;
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        this.connecting = null;
      });
    await this.connecting;
  }

  close(): void {
    this.conn.close();
    this.home = null;
  }

  private async c(): Promise<SshConnection> {
    await this.connect();
    return this.conn;
  }

  async homedir(): Promise<string> {
    this.home ??= (await (await this.c()).canonical(".")) ?? "/";
    return this.home;
  }

  async stat(p: string): Promise<FileStat | null> {
    return (await this.c()).stat(p);
  }

  async lstat(p: string): Promise<FileStat | null> {
    return (await this.c()).lstat(p);
  }

  // 存在且链接未悬空/循环时才规范化；服务端 realpath 对不存在的末段可能放行，所以先自行确认。
  async realpath(p: string): Promise<string | null> {
    const conn = await this.c();
    if ((await conn.lstat(p)) === null || (await conn.stat(p)) === null)
      return null;
    return conn.canonical(p);
  }

  async readdir(p: string): Promise<DirEntry[]> {
    return (await this.c()).readdirEntries(p);
  }

  async readFile(p: string): Promise<Buffer> {
    return (await this.c()).readFile(p);
  }

  async writeFile(p: string, data: Buffer | string): Promise<void> {
    await (await this.c()).writeFile(p, data);
  }

  async mkdirp(p: string): Promise<void> {
    await (await this.c()).mkdirp(p);
  }

  async readStream(p: string) {
    return (await this.c()).readStream(p);
  }

  async writeStream(p: string) {
    return (await this.c()).writeStream(p);
  }

  async exec(command: string, cwd: string, opts: ExecOptions) {
    const conn = await this.c();
    const exports = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${shq(v)};`)
      .join(" ");
    // 命令原样放进花括号组：换行保证末尾注释、heredoc、& 都不会吞掉右括号。
    const script = `${exports} cd ${shq(cwd)} && {\n${command}\n}`;
    const r = await conn.execStream(script, {
      onData: opts.onData,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeout ? { timeoutMs: opts.timeout * 1000 } : {}),
    });
    if (r.aborted) throw new Error("aborted");
    if (r.timedOut) throw new Error(`timeout:${opts.timeout}`);
    if (r.exitCode !== null) return { exitCode: r.exitCode };
    const n = r.signal
      ? (osConstants.signals[
          `SIG${r.signal}` as keyof typeof osConstants.signals
        ] ?? 0)
      : 0;
    return { exitCode: n ? 128 + n : 1 };
  }
}
