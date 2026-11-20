// 远端 stdio 传输：进程经 SSH 长连接通道起在会话「逻辑 local」目录所在的主机上。
// 继承 pi 的 StdioTransport 只为一处：pi 在连接失败与断线时只认这个类型、取它的 stderr 拼进错误；
// 其余实现全部重写，这里不碰基类的 child / 缓冲区字段。
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type JsonRpcMessage,
  McpConnectionClosedError,
  parseJsonRpcMessage,
  StdioTransport,
} from "@earendil-works/pi-mcp";
import type { ExecEnv, StdioChannel } from "../env/types.js";
import { PGID_MARKER, remoteLaunch } from "./remote-launch.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_GRACE_MS = 500;
const DEFAULT_KILL_MS = 2000;
const CLOSE_WAIT_MS = 1000;

export type RemoteHost = ExecEnv & Required<Pick<ExecEnv, "openStdio">>;

// 通道开不出来多半是撞了 sshd 的每连接会话数上限（MaxSessions，默认 10），错误本身看不出来
const withLimitHint = (err: unknown): unknown =>
  err instanceof Error && /Channel open failure/.test(err.message)
    ? new Error(
        `${err.message} (the host may have reached its per-connection session limit; sshd MaxSessions defaults to 10, and every running MCP server and tool call holds one)`,
      )
    : err;

export interface RemoteStdioOptions {
  env: RemoteHost;
  command: string;
  args: readonly string[];
  /** 远端绝对路径 */
  cwd: string;
  vars: Readonly<Record<string, string>>;
  /** stdin EOF 之后等进程自己退出的时间，默认 500；之后再给 TERM 到 KILL 的时间默认 2000 */
  graceMs?: number;
  killMs?: number;
}

export class RemoteStdioTransport extends StdioTransport {
  private readonly o: RemoteStdioOptions;
  private rc: StdioChannel | null = null;
  private rOut = Buffer.alloc(0);
  private rErr = "";
  private rStarted = false;
  private rClosed = false;
  private rChanClosed = false;
  private pgid: number | null = null;
  /** 通道关闭时 resolve，供 close() 的各段等待。 */
  private rExit: Promise<void> = Promise.resolve();

  constructor(o: RemoteStdioOptions) {
    super({ command: o.command, args: [...o.args] });
    this.o = o;
  }

  get stderr(): string {
    return this.rErr;
  }

  async start(): Promise<void> {
    if (this.rStarted || this.rClosed) throw new McpConnectionClosedError();
    if (this.o.env.os === "windows")
      throw new Error("MCP stdio servers are not supported on Windows hosts");
    this.rStarted = true;
    // 登录环境在前、服务自己登记的变量在后：登记的 PATH 等明确覆盖登录环境
    const login = (await this.o.env.loginEnv?.().catch(() => ({}))) ?? {};
    const launch = remoteLaunch({
      command: this.o.command,
      args: this.o.args,
      cwd: this.o.cwd,
      vars: { ...login, ...this.o.vars },
      nonce: randomBytes(6).toString("hex"),
    });
    try {
      const w = await this.o.env.writeStream(launch.scriptPath, {
        mode: 0o600,
        exclusive: true,
      });
      // sftp 写流结束时只发 close（不发 finish），等 close 才是真正落盘
      await new Promise<void>((ok, fail) => {
        w.once("error", fail);
        w.once("close", () => ok());
        w.end(launch.script);
      });
      const rc = await this.o.env.openStdio(launch.shellCommand);
      this.rc = rc;
      this.wire(rc);
    } catch (err) {
      // 脚本里有密钥：写失败或起不来就尽量删掉
      await this.o.env.remove(launch.scriptPath).catch(() => {});
      throw withLimitHint(err);
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const rc = this.rc;
    if (!this.rStarted || this.rClosed || !rc || this.rChanClosed)
      throw new McpConnectionClosedError();
    await rc.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.rClosed) return;
    this.rClosed = true;
    const rc = this.rc;
    if (!rc) {
      this.emitClose();
      return;
    }
    // 按 MCP 规范收尾：关 stdin 让服务自己退，再 TERM 整组，最后 KILL 整组
    rc.end();
    if (await this.waitClose(this.o.graceMs ?? DEFAULT_GRACE_MS)) return;
    // 只在通道还开着时发整组 kill：进程已退出的话进程组号可能已被复用，会误杀别人
    if (this.pgid !== null) this.groupKill("TERM");
    rc.signal("TERM");
    if (await this.waitClose(this.o.killMs ?? DEFAULT_KILL_MS)) return;
    if (this.pgid !== null) this.groupKill("KILL");
    rc.signal("KILL");
    rc.close();
    await this.waitClose(CLOSE_WAIT_MS);
  }

  /** 等通道关闭，返回是否真的关了。 */
  private async waitClose(ms: number): Promise<boolean> {
    return Promise.race([
      this.rExit.then(() => true),
      sleep(ms).then(() => false),
    ]);
  }

  /** 经另一条 exec 通道杀远端整组（含 npx 起的孙进程）；连接断了就算了。 */
  private groupKill(signal: "TERM" | "KILL"): void {
    void this.o.env
      .exec(`kill -${signal} -- -${this.pgid}`, "/", {
        onData: () => {},
        timeout: 5,
      })
      .catch(() => {});
  }

  private wire(rc: StdioChannel): void {
    this.rExit = new Promise<void>((ok) => {
      rc.onClose(() => {
        this.rChanClosed = true;
        if (this.rOut.toString("utf8").trim())
          this.emitError(
            new Error(
              "MCP stdio server closed with an incomplete JSON-RPC message",
            ),
          );
        this.rOut = Buffer.alloc(0);
        ok();
        this.emitClose();
      });
    });
    rc.onStdout((chunk) => this.readStdout(chunk));
    rc.onStderr((chunk) => this.readStderr(chunk));
  }

  private readStdout(chunk: Buffer): void {
    this.rOut = Buffer.concat([this.rOut, chunk]);
    while (true) {
      const nl = this.rOut.indexOf(0x0a);
      if (nl < 0) {
        if (this.rOut.length > MAX_LINE_BYTES) {
          this.rOut = Buffer.alloc(0);
          this.emitError(
            new Error(`MCP stdio message exceeds ${MAX_LINE_BYTES} bytes`),
          );
        }
        return;
      }
      const line = this.rOut.subarray(0, nl);
      this.rOut = this.rOut.subarray(nl + 1);
      if (line.length > MAX_LINE_BYTES) {
        this.emitError(
          new Error(`MCP stdio message exceeds ${MAX_LINE_BYTES} bytes`),
        );
        continue;
      }
      const text = line.toString("utf8").replace(/\r$/, "");
      if (!text.trim()) continue;
      try {
        this.emitMessage(parseJsonRpcMessage(JSON.parse(text)));
      } catch {
        this.emitError(
          new Error(
            `MCP server wrote a non-JSON-RPC line on stdout: ${text.slice(0, 200)}`,
          ),
        );
      }
    }
  }

  private readStderr(chunk: Buffer): void {
    this.rErr += chunk.toString("utf8");
    // 只留最后 64 KiB（按字节算，多字节字符不会把上限撑大）
    if (Buffer.byteLength(this.rErr) > MAX_STDERR_BYTES)
      this.rErr = Buffer.from(this.rErr)
        .subarray(-MAX_STDERR_BYTES)
        .toString("utf8");
    // 登录 shell 可能先吐别的东西，所以整段缓冲里找进程组标记，找到后从 stderr 里去掉
    if (this.pgid === null) {
      const m = new RegExp(`${PGID_MARKER}(\\d+)\\n`).exec(this.rErr);
      const id = m?.[1];
      if (m && id !== undefined) {
        this.pgid = Number(id);
        this.rErr = this.rErr.replace(m[0], "");
      }
    }
  }
}
