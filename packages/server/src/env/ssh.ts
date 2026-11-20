import { constants as osConstants } from "node:os";
import type { ConnectOptions, SshConnection } from "../ssh/connection.js";
import type { OsType } from "../store/environments.js";
import { captureLoginEnv } from "./login-env.js";
import type {
  DirEntry,
  EnvStatus,
  ExecEnv,
  ExecOptions,
  FileStat,
  WriteOptions,
} from "./types.js";

// RFC 4254 的通道打开失败码：ssh2 把它放在错误的 reason 上。
const OPEN_ADMIN_PROHIBITED = 1;
const OPEN_CONNECT_FAILED = 2;

// 转发端口失败的两种常见原因翻成人话，浏览器页面上直接看得到；其余原样抛。
function tunnelFailure(err: unknown, port: number): unknown {
  const reason = (err as { reason?: unknown } | null)?.reason;
  if (reason === OPEN_ADMIN_PROHIBITED)
    return new Error(
      "远端 sshd 禁止了端口转发（sshd_config 的 AllowTcpForwarding），访问不了这台机器上的服务",
    );
  if (reason === OPEN_CONNECT_FAILED)
    return new Error(`远端 localhost:${port} 连不上，服务可能没有在监听`);
  return err;
}

/** POSIX shell 单引号转义。 */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// ssh 环境：首次使用与掉线后的下一次使用时自动（重）连；原语失败时如实抛错，不静默重试。
export class SshEnv implements ExecEnv {
  readonly kind = "ssh" as const;
  private connecting: Promise<void> | null = null;
  private home: string | null = null;
  private lastError: string | null = null;
  private login: Promise<Record<string, string>> | null = null;

  constructor(
    readonly id: string,
    readonly os: OsType,
    private readonly conn: SshConnection,
    /** 建连前的闸门：抛错即拒绝（连接被断开暂停时用）。 */
    private readonly gate: () => void = () => {},
  ) {}

  status(): EnvStatus {
    if (this.conn.isConnected()) return { id: this.id, state: "connected" };
    return this.lastError
      ? { id: this.id, state: "error", error: this.lastError }
      : { id: this.id, state: "disconnected" };
  }

  /** 主动连接（用于“测试连接”与激活）；失败抛错并记录原因。opts 的阶段回调只对本次真正发起的连接生效。 */
  async connect(opts?: ConnectOptions): Promise<void> {
    if (this.conn.isConnected()) return;
    this.gate();
    this.connecting ??= this.conn
      .connect(opts)
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
    this.login = null;
  }

  /** 经本环境的连接向 host:port 开通道，给下游连接当跳板用。 */
  async tunnel(host: string, port: number) {
    return (await this.c()).openTunnel(host, port);
  }

  /** 浏览器代理转发服务端口：目标是远端自己的回环，不在本机拨号。 */
  async openTcp(port: number) {
    try {
      return await this.tunnel("localhost", port);
    } catch (err) {
      throw tunnelFailure(err, port);
    }
  }

  /** 激活的「远端探测」：只读，取内核与架构一行。 */
  async probe(): Promise<string> {
    const conn = await this.c();
    const cmd = this.os === "windows" ? "ver" : "uname -sr; uname -m";
    const r = await conn.exec(cmd, { timeoutMs: 8000 });
    if (r.exitCode !== 0)
      throw new Error(`探测命令失败（退出码 ${r.exitCode}）`);
    return r.stdout
      .toString("utf8")
      .trim()
      .replace(/\s*\n\s*/g, " · ");
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
  async openShell(opts: { cols: number; rows: number; cwd?: string }) {
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

  async openStdio(command: string) {
    return (await this.c()).openChannel(command);
  }

  // 每个环境对象抓一次；通道层面失败（没抓完整）不缓存，下次再试。Windows 没有这套 shell，不抓。
  loginEnv(): Promise<Record<string, string>> {
    if (this.os === "windows") return Promise.resolve({});
    if (this.login) return this.login;
    const p: Promise<Record<string, string>> = this.captureLogin().then((r) => {
      if (!r.complete && this.login === p) this.login = null;
      return r.vars;
    });
    this.login = p;
    p.catch(() => {
      if (this.login === p) this.login = null;
    });
    return p;
  }

  private async captureLogin() {
    const conn = await this.c();
    return captureLoginEnv(async (command, timeoutMs) => {
      const chunks: Buffer[] = [];
      await conn.execStream(command, {
        onData: (d) => chunks.push(d),
        timeoutMs,
      });
      return Buffer.concat(chunks);
    });
  }

  async refreshLoginEnv(): Promise<void> {
    this.login = null;
    await this.loginEnv();
  }

  async exec(command: string, cwd: string, opts: ExecOptions) {
    const conn = await this.c();
    const env = { ...(await this.loginEnv()), ...opts.env };
    const hasEnv = Object.keys(env).length > 0;
    const script = `cd ${shq(cwd)} && {\n${command}\n}`;
    // 有环境变量时喂 stdin（远端 ps 看不到），无则命令行直接拼（兼容现有测试与隐私变量前的场景）。
    // 命令行只写读多少字节：stdin 不能关，否则超时 / 中止的 TERM 发不出去（见 execStream）。
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shq(v)}`)
      .join("\n");
    const fed = `${exports}\n${script}`;
    const r = await conn.execStream(
      hasEnv ? `eval "$(head -c ${Buffer.byteLength(fed)})"` : script,
      {
        onData: opts.onData,
        ...(hasEnv ? { stdin: fed } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeout ? { timeoutMs: opts.timeout * 1000 } : {}),
      },
    );
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
