import { createHash } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { Client, type ClientChannel, type SFTPWrapper, type Stats } from "ssh2";
import type {
  DirEntry,
  FileStat,
  StdioChannel,
  WriteOptions,
} from "../env/types.js";
import type { SecretStore } from "../store/secrets.js";

const toFileStat = (st: Stats): FileStat => ({
  isDirectory: st.isDirectory(),
  isFile: st.isFile(),
  isSymlink: st.isSymbolicLink(),
  size: st.size,
  mtimeMs: st.mtime * 1000,
  mode: st.mode,
});

/**
 * 主机密钥指纹的存取（默认 accept-new：无记录时接受并写入，有记录时必须一致）。
 * 两个可选钩子供「远程连接」使用：首次是否直接记录，以及校验被拒时把看到的指纹交出去。
 */
export interface HostKeyStore {
  get(): string | null;
  save(fingerprint: string): void;
  /** 返回 false 表示首次见到的指纹不自动记录，阻断等用户核对；缺省视为 true。 */
  acceptUnknown?(): boolean;
  /** 校验被拒（首次需核对，或与记录不符）时回调；known 为 null 表示首次。 */
  onBlocked?(seen: string, known: string | null): void;
}

/** connect 的三个阶段，对应激活六步里的 TCP 连接、主机密钥、认证。 */
export type ConnectStage = "tcp" | "hostkey" | "auth";

export class SshConnectError extends Error {
  constructor(
    readonly stage: ConnectStage,
    readonly code: string,
    message: string,
    /** 主机密钥被阻断时看到的指纹与记录（库内格式）；其他错误为 null。 */
    readonly seen: string | null = null,
    readonly known: string | null = null,
  ) {
    super(message);
    this.name = "SshConnectError";
  }
}

export interface ConnectOptions {
  /** 某阶段完成时回调：tcp（握手前的传输就绪）、hostkey（校验通过）、auth（认证通过）。 */
  onStage?: (stage: ConnectStage) => void;
  signal?: AbortSignal;
}

type ClientError = Error & { code?: string; level?: string };

function classify(stage: ConnectStage, err: ClientError): SshConnectError {
  let code: string;
  if (err.level === "client-timeout")
    code = stage === "tcp" ? "tcp_timeout" : "timeout";
  else if (stage === "tcp") {
    if (err.code === "ECONNREFUSED") code = "tcp_refused";
    else if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN")
      code = "dns_failed";
    else if (err.code === "ETIMEDOUT") code = "tcp_timeout";
    else code = "tcp_failed";
  } else if (stage === "hostkey") code = "handshake_failed";
  else
    code = err.level === "client-authentication" ? "auth_failed" : "auth_error";
  return new SshConnectError(stage, code, err.message);
}

/** 仅进程内记忆；测试与未接入持久化的场景用，保证同一连接对象至少不会换密钥。 */
export const memoryHostKeys = (): HostKeyStore => {
  let fp: string | null = null;
  return { get: () => fp, save: (v) => (fp = v) };
};

/** SSH 线格式公钥 → `算法:sha256 hex`（线格式以长度前缀的算法名开头）。 */
export function hostKeyFingerprint(key: Buffer): string {
  const algo = key.subarray(4, 4 + key.readUInt32BE(0)).toString("ascii");
  return `${algo}:${createHash("sha256").update(key).digest("hex")}`;
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  secretId: string | null;
  /** false 关闭保活心跳；缺省开启。 */
  keepAlive?: boolean;
  /** 已建立的连接被对端或网络断开时回调（主动 close 不触发）；reason 为 ssh2 报的错误，干净关闭时为 null。 */
  onDrop?: (reason: string | null) => void;
}

// exitCode 为 null 表示被信号终止、超时或中止。
export interface ExecResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

// 单个 ssh 连接：exec 走命令通道，文件原语走复用的 sftp 通道。不做连接池与重连。
export class SshConnection {
  private client: Client | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;

  /**
   * tunnel 给了就不直连，而是经它开出的通道走 ssh（跳板）：通道代替 TCP 套接字。
   */
  constructor(
    private readonly config: SshConfig,
    private readonly secrets: SecretStore,
    private readonly hostKeys: HostKeyStore = memoryHostKeys(),
    private readonly tunnel:
      | ((host: string, port: number) => Promise<Duplex>)
      | null = null,
  ) {}

  async connect(opts: ConnectOptions = {}): Promise<void> {
    if (this.client) return;
    const auth: { privateKey?: string; password?: string } = {};
    if (this.config.secretId !== null) {
      const meta = this.secrets.get(this.config.secretId);
      const value = this.secrets.reveal(this.config.secretId);
      if (!meta || value === null) throw new Error("环境引用的密码不存在");
      if (meta.kind === "ssh_key") auth.privateKey = value;
      else auth.password = value;
    }
    let sock: Duplex | undefined;
    if (this.tunnel) {
      try {
        sock = await this.tunnel(this.config.host, this.config.port);
      } catch (err) {
        throw new SshConnectError(
          "tcp",
          "tunnel_failed",
          `经跳板转发失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const client = new Client();
    let stage: ConnectStage = "tcp";
    // 校验被拒时 ssh2 只报笼统的握手错误；这里记下原因，在 error 里换成能看出指纹的提示。
    let blocked: SshConnectError | null = null;
    // 连上之后最近一次链路错误，掉线时作为原因交出去
    let lastError: string | null = null;
    const { signal } = opts;
    let onAbort = () => {};
    await new Promise<void>((ok, fail) => {
      onAbort = () => {
        client.destroy();
        fail(new SshConnectError(stage, "aborted", "已取消"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      client
        .once("connect", () => {
          // TCP 已通：此后到出示主机密钥之前的失败（对端关闭、回非 SSH 内容、握手超时）是握手阶段的问题
          stage = "hostkey";
          opts.onStage?.("tcp");
        })
        .once("ready", () => {
          opts.onStage?.("auth");
          ok();
        })
        // 必须常驻：ssh2 在握手中途断开时会连发两次 error（先报错，socket 关闭时再报
        // "Connection lost before handshake"），连上之后的链路错误也走这里。没有监听者的 error 会让整个 Server 进程崩溃。
        // promise 只会被第一次 error 决定；之后的错误由下面的 close 收尾。
        .on("error", (err: ClientError) => {
          lastError = err.message;
          fail(blocked ?? classify(stage, err));
          client.destroy();
        })
        .connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          ...auth,
          ...(sock ? { sock } : {}),
          hostVerifier: (key: Buffer) => {
            stage = "hostkey";
            const seen = hostKeyFingerprint(key);
            const known = this.hostKeys.get();
            if (known === seen) {
              stage = "auth";
              opts.onStage?.("hostkey");
              return true;
            }
            if (known === null && this.hostKeys.acceptUnknown?.() !== false) {
              this.hostKeys.save(seen);
              stage = "auth";
              opts.onStage?.("hostkey");
              return true;
            }
            blocked =
              known === null
                ? new SshConnectError(
                    "hostkey",
                    "hostkey_unknown",
                    `首次连接，主机密钥待核对（${seen}）`,
                    seen,
                    null,
                  )
                : new SshConnectError(
                    "hostkey",
                    "hostkey_changed",
                    `主机密钥与记录不符（记录 ${known}，实际 ${seen}）。若服务器确已更换密钥，请清除该环境的主机密钥后重连`,
                    seen,
                    known,
                  );
            this.hostKeys.onBlocked?.(seen, known);
            return false;
          },
          readyTimeout: 15000,
          keepaliveInterval: this.config.keepAlive === false ? 0 : 20000,
        });
    }).finally(() => signal?.removeEventListener("abort", onAbort));
    client.on("close", () => {
      // 主动 close() 已先清掉 this.client；走到这里的是对端或网络把连接断了
      if (this.client !== client) return;
      this.reset();
      this.config.onDrop?.(lastError);
    });
    this.client = client;
  }

  /** 经本连接向 host:port 开一条通道，给下游连接当套接字用（跳板）。 */
  openTunnel(host: string, port: number): Promise<ClientChannel> {
    return new Promise((ok, fail) => {
      this.requireClient().forwardOut("127.0.0.1", 0, host, port, (err, ch) =>
        err ? fail(err) : ok(ch),
      );
    });
  }

  close(): void {
    this.client?.end();
    this.reset();
  }

  private reset(): void {
    this.client = null;
    this.sftpPromise = null;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error("ssh 连接未建立或已断开");
    return this.client;
  }

  private sftp(): Promise<SFTPWrapper> {
    const client = this.requireClient();
    this.sftpPromise ??= new Promise((ok, fail) => {
      client.sftp((err, s) => (err ? fail(err) : ok(s)));
    });
    this.sftpPromise.catch(() => {
      this.sftpPromise = null;
    });
    return this.sftpPromise;
  }

  // 执行命令并收集输出。signal 中止或超时都会关闭通道，exitCode 为 null。
  exec(
    command: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    return new Promise((ok, fail) => {
      const client = this.requireClient();
      if (opts.signal?.aborted) {
        ok({
          exitCode: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        });
        return;
      }
      client.exec(command, (err, stream) => {
        if (err) return fail(err);
        const out: Buffer[] = [];
        const errs: Buffer[] = [];
        const stop = () => stream.signal("TERM");
        const timer = opts.timeoutMs
          ? setTimeout(stop, opts.timeoutMs)
          : undefined;
        opts.signal?.addEventListener("abort", stop, { once: true });
        stream.on("data", (d: Buffer) => out.push(d));
        stream.stderr.on("data", (d: Buffer) => errs.push(d));
        stream.once("close", (code: number | null | undefined) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", stop);
          ok({
            exitCode: typeof code === "number" ? code : null,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(errs),
          });
        });
      });
    });
  }

  // 交互终端：申请 pty；给了命令就在 pty 下执行它（用来先进入目录再换成登录 shell）。
  openShell(opts: {
    cols: number;
    rows: number;
    command?: string;
  }): Promise<ClientChannel> {
    return new Promise((ok, fail) => {
      const window = {
        term: "xterm-256color",
        cols: opts.cols,
        rows: opts.rows,
      };
      const done = (err: Error | undefined, ch: ClientChannel) =>
        err ? fail(err) : ok(ch);
      const client = this.requireClient();
      if (opts.command === undefined) client.shell(window, done);
      else client.exec(opts.command, { pty: window }, done);
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const s = await this.sftp();
    return new Promise((ok, fail) =>
      s.readFile(remotePath, (e, d) => (e ? fail(e) : ok(d))),
    );
  }

  async writeFile(remotePath: string, content: Buffer | string): Promise<void> {
    const s = await this.sftp();
    return new Promise((ok, fail) =>
      s.writeFile(remotePath, content, (e) => (e ? fail(e) : ok())),
    );
  }

  async readStream(
    remotePath: string,
    range?: { start: number; end: number },
  ): Promise<Readable> {
    const stream = (await this.sftp()).createReadStream(remotePath, range);
    // 读完后 autoClose 的 close 请求若遇上连接断开，ssh2 会把错误发给已无人监听的流，变成进程级未捕获异常
    stream.on("error", () => {});
    return stream;
  }

  async readlink(remotePath: string): Promise<string | null> {
    const s = await this.sftp();
    return new Promise((ok) =>
      s.readlink(remotePath, (e, t) => ok(e ? null : t)),
    );
  }

  // 优先用 OpenSSH 的 posix-rename（原子替换已存在的目标）；服务端不支持时先删目标文件再改名。
  async rename(from: string, to: string): Promise<void> {
    const s = await this.sftp();
    const plain = () =>
      new Promise<void>((ok, fail) =>
        s.rename(from, to, (e) => (e ? fail(e) : ok())),
      );
    try {
      return await new Promise<void>((ok, fail) =>
        s.ext_openssh_rename(from, to, (e) => (e ? fail(e) : ok())),
      );
    } catch (err) {
      // 不支持扩展时 ssh2 同步抛错；扩展自身失败（目标是非空目录等）如实上抛
      if (!(err instanceof Error) || !/support/i.test(err.message)) throw err;
    }
    const target = await this.lstat(to);
    if (target && !target.isDirectory)
      await new Promise<void>((ok, fail) =>
        s.unlink(to, (e) => (e ? fail(e) : ok())),
      );
    return plain();
  }

  // 不跟随链接；recursive 时自底向上删目录树。
  async remove(remotePath: string, recursive = false): Promise<void> {
    const s = await this.sftp();
    const call = (f: (cb: (e: Error | null | undefined) => void) => void) =>
      new Promise<void>((ok, fail) => f((e) => (e ? fail(e) : ok())));
    const walk = async (p: string): Promise<void> => {
      const st = await this.lstat(p);
      if (!st) throw new Error(`不存在：${p}`);
      if (!st.isDirectory) return call((cb) => s.unlink(p, cb));
      if (recursive)
        for (const name of await this.readdir(p)) await walk(`${p}/${name}`);
      return call((cb) => s.rmdir(p, cb));
    };
    await walk(remotePath);
  }

  // ssh2 的写流在 open 后会 fchmod 到 mode（缺省 0o666），所以 mode 是精确设置而非被 umask 收窄。
  async writeStream(
    remotePath: string,
    opts: WriteOptions = {},
  ): Promise<Writable> {
    const stream = (await this.sftp()).createWriteStream(remotePath, {
      flags: opts.exclusive ? "wx" : "w",
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
    });
    await once(stream, "open");
    return stream;
  }

  async readdir(remotePath: string): Promise<string[]> {
    const s = await this.sftp();
    return new Promise((ok, fail) =>
      s.readdir(remotePath, (e, list) =>
        e ? fail(e) : ok(list.map((x) => x.filename)),
      ),
    );
  }

  async isDirectory(remotePath: string): Promise<boolean> {
    const s = await this.sftp();
    return new Promise((ok, fail) =>
      s.stat(remotePath, (e, st) => (e ? fail(e) : ok(st.isDirectory()))),
    );
  }

  async exists(remotePath: string): Promise<boolean> {
    const s = await this.sftp();
    return new Promise((ok) => s.stat(remotePath, (e) => ok(!e)));
  }

  // 递归创建目录，已存在不报错。mode 只设置最后一级（由本次新建时）；mkdir 受 umask 影响，所以再 chmod。
  async mkdirp(remotePath: string, mode?: number): Promise<void> {
    const s = await this.sftp();
    const parts = remotePath.split("/").filter(Boolean);
    let cur = remotePath.startsWith("/") ? "" : ".";
    for (const [i, part] of parts.entries()) {
      cur = `${cur}/${part}`;
      if (await this.exists(cur)) continue;
      await new Promise<void>((ok, fail) =>
        s.mkdir(cur, (e) => (e ? fail(e) : ok())),
      );
      if (mode !== undefined && i === parts.length - 1)
        await new Promise<void>((ok, fail) =>
          s.chmod(cur, mode, (e) => (e ? fail(e) : ok())),
        );
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  // 流式执行：stdout 与 stderr 按到达顺序交给 onData。中止与超时先发 TERM，2 秒后仍未退出就关闭通道。
  execStream(
    command: string,
    opts: {
      onData: (d: Buffer) => void;
      signal?: AbortSignal;
      timeoutMs?: number;
      /**
       * 写入标准输入，不关闭：通道一旦 end，ssh2 就不再发 signal，超时 / 中止的 TERM 会丢。
       * 远端命令行不含内容时，要按字节数读（`eval "$(head -c N)"`），不能等 EOF。
       */
      stdin?: string;
    },
  ): Promise<{
    exitCode: number | null;
    signal: string | null;
    aborted: boolean;
    timedOut: boolean;
  }> {
    return new Promise((ok, fail) => {
      const client = this.requireClient();
      if (opts.signal?.aborted) {
        ok({ exitCode: null, signal: null, aborted: true, timedOut: false });
        return;
      }
      client.exec(command, (err, stream) => {
        if (err) return fail(err);
        let aborted = false;
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        const stop = () => {
          stream.signal("TERM");
          killTimer ??= setTimeout(() => stream.close(), 2000);
        };
        const onAbort = () => {
          aborted = true;
          stop();
        };
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              stop();
            }, opts.timeoutMs)
          : undefined;
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        stream.on("data", opts.onData);
        stream.stderr.on("data", opts.onData);
        if (opts.stdin !== undefined) stream.write(opts.stdin);
        stream.once(
          "close",
          (code: number | null | undefined, sig: string | null | undefined) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            opts.signal?.removeEventListener("abort", onAbort);
            ok({
              exitCode: typeof code === "number" ? code : null,
              signal: sig ?? null,
              aborted,
              timedOut,
            });
          },
        );
      });
    });
  }

  // 长连接命令通道：stdin 可续写、stdout 与 stderr 分开、关闭只报一次（给 MCP stdio 传输用）。
  openChannel(command: string): Promise<StdioChannel> {
    // 处理函数挂上之前到的输出先攒着：ssh2 可能在同一批包里连着送「命令已接受」与首批输出
    const sink = () => {
      let fn: ((chunk: Buffer) => void) | null = null;
      const held: Buffer[] = [];
      return {
        push: (chunk: Buffer) => (fn ? fn(chunk) : held.push(chunk)),
        attach: (f: (chunk: Buffer) => void) => {
          fn = f;
          for (const chunk of held.splice(0)) f(chunk);
        },
      };
    };
    return new Promise((ok, fail) => {
      this.requireClient().exec(command, (err, stream) => {
        if (err) return fail(err);
        const out = sink();
        const errs = sink();
        let closed = false;
        const closeFns: (() => void)[] = [];
        stream.on("data", out.push);
        stream.stderr.on("data", errs.push);
        stream.once("close", () => {
          closed = true;
          for (const fn of closeFns) fn();
          closeFns.length = 0;
        });
        ok({
          write: (data) =>
            new Promise<void>((done, reject) => {
              if (closed) return reject(new Error("ssh 命令通道已关闭"));
              stream.write(data, (e?: Error | null) =>
                e ? reject(e) : done(),
              );
            }),
          end: () => stream.end(),
          onStdout: out.attach,
          onStderr: errs.attach,
          onClose: (fn) => {
            if (closed) fn();
            else closeFns.push(fn);
          },
          signal: (name) => stream.signal(name),
          close: () => stream.close(),
        });
      });
    });
  }

  private async attrs(
    remotePath: string,
    follow: boolean,
  ): Promise<FileStat | null> {
    const s = await this.sftp();
    return new Promise((ok) => {
      const cb = (e: Error | null | undefined, st?: Stats) =>
        ok(e || !st ? null : toFileStat(st));
      if (follow) s.stat(remotePath, cb);
      else s.lstat(remotePath, cb);
    });
  }

  stat(remotePath: string): Promise<FileStat | null> {
    return this.attrs(remotePath, true);
  }

  lstat(remotePath: string): Promise<FileStat | null> {
    return this.attrs(remotePath, false);
  }

  // 服务端完整规范化（含中间目录的符号链接）；失败返回 null。
  async canonical(remotePath: string): Promise<string | null> {
    const s = await this.sftp();
    return new Promise((ok) =>
      s.realpath(remotePath, (e, p) => ok(e ? null : p)),
    );
  }

  async readdirEntries(remotePath: string): Promise<DirEntry[]> {
    const s = await this.sftp();
    return new Promise((ok, fail) =>
      s.readdir(remotePath, (e, list) =>
        e
          ? fail(e)
          : ok(
              list.map((x) => ({
                name: x.filename,
                isDirectory: x.attrs.isDirectory(),
                isSymlink: x.attrs.isSymbolicLink(),
                size: x.attrs.size,
                mtimeMs: x.attrs.mtime * 1000,
              })),
            ),
      ),
    );
  }

  // 递归解析符号链接(最多40层)；悬空、循环或不存在都返回 null。
  async realpath(remotePath: string): Promise<string | null> {
    const s = await this.sftp();
    const visited = new Set<string>();
    let current = remotePath;
    for (let i = 0; i < 40; i++) {
      if (visited.has(current)) return null;
      visited.add(current);
      const info = await new Promise<{
        exists: boolean;
        link: boolean;
        target?: string;
      }>((ok) =>
        s.lstat(current, (e, st) => {
          if (e) return ok({ exists: false, link: false });
          if (!st.isSymbolicLink()) return ok({ exists: true, link: false });
          s.readlink(current, (e2, t) =>
            ok({ exists: true, link: true, target: e2 || !t ? undefined : t }),
          );
        }),
      );
      if (!info.exists) return null;
      if (!info.link) return current;
      if (info.target === undefined) return null;
      current = path.isAbsolute(info.target)
        ? info.target
        : path.join(path.dirname(current), info.target);
    }
    return null;
  }
}
