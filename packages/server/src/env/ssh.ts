import { constants as osConstants } from "node:os";
import type { SshConnection } from "../ssh/connection.js";
import type { OsType } from "../store/environments.js";
import type {
  DirEntry,
  EnvStatus,
  ExecEnv,
  ExecOptions,
  FileStat,
  WriteOptions,
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

  async readlink(p: string): Promise<string | null> {
    return (await this.c()).readlink(p);
  }

  async rename(from: string, to: string): Promise<void> {
    await (await this.c()).rename(from, to);
  }

  async remove(p: string, recursive = false): Promise<void> {
    await (await this.c()).remove(p, recursive);
  }

  async readFile(p: string): Promise<Buffer> {
    return (await this.c()).readFile(p);
  }

  async writeFile(p: string, data: Buffer | string): Promise<void> {
    await (await this.c()).writeFile(p, data);
  }

  async mkdirp(p: string, mode?: number): Promise<void> {
    await (await this.c()).mkdirp(p, mode);
  }

  async readStream(p: string, range?: { start: number; end: number }) {
    return (await this.c()).readStream(p, range);
  }

  async writeStream(p: string, opts?: WriteOptions) {
    return (await this.c()).writeStream(p, opts);
  }

  // 交互 shell（终端用）。给了 cwd 就先进入目录再换成登录 shell；Windows 的 Git Bash 分支未验证。
  async shell(opts: { cols: number; rows: number; cwd?: string }) {
    const conn = await this.c();
    const sh = this.os === "windows" ? "bash" : `"\${SHELL:-/bin/sh}"`;
    return conn.openShell({
      cols: opts.cols,
      rows: opts.rows,
      ...(opts.cwd === undefined
        ? {}
        : { command: `cd ${shq(opts.cwd)} && exec ${sh} -l` }),
    });
  }

  async exec(command: string, cwd: string, opts: ExecOptions) {
    const conn = await this.c();
    const env = opts.env ?? {};
    const hasEnv = Object.keys(env).length > 0;
    const script = `cd ${shq(cwd)} && {\n${command}\n}`;
    // 有环境变量时喂 stdin（远端 ps 看不到），无则命令行直接拼（兼容现有测试与隐私变量前的场景）。
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shq(v)}`)
      .join("\n");
    const r = await conn.execStream(hasEnv ? 'eval "$(cat)"' : script, {
      onData: opts.onData,
      ...(hasEnv ? { stdin: `${exports}\n${script}` } : {}),
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
