import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { Client, type ClientChannel, type SFTPWrapper, type Stats } from "ssh2";
import type { DirEntry, FileStat } from "../env/types.js";
import type { SecretStore } from "../store/secrets.js";

const toFileStat = (st: Stats): FileStat => ({
  isDirectory: st.isDirectory(),
  isFile: st.isFile(),
  isSymlink: st.isSymbolicLink(),
  size: st.size,
  mtimeMs: st.mtime * 1000,
});

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  secretId: string | null;
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

  constructor(
    private readonly config: SshConfig,
    private readonly secrets: SecretStore,
  ) {}

  async connect(): Promise<void> {
    if (this.client) return;
    const auth: { privateKey?: string; password?: string } = {};
    if (this.config.secretId !== null) {
      const meta = this.secrets.get(this.config.secretId);
      const value = this.secrets.reveal(this.config.secretId);
      if (!meta || value === null) throw new Error("环境引用的密码不存在");
      if (meta.kind === "ssh_key") auth.privateKey = value;
      else auth.password = value;
    }
    const client = new Client();
    await new Promise<void>((ok, fail) => {
      client
        .once("ready", ok)
        .once("error", fail)
        .connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          ...auth,
          readyTimeout: 15000,
          keepaliveInterval: 20000,
        });
    });
    client.on("close", () => {
      if (this.client === client) this.reset();
    });
    this.client = client;
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

  async writeStream(remotePath: string): Promise<Writable> {
    return (await this.sftp()).createWriteStream(remotePath);
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

  // 递归创建目录，已存在不报错。
  async mkdirp(remotePath: string): Promise<void> {
    const s = await this.sftp();
    const parts = remotePath.split("/").filter(Boolean);
    let cur = remotePath.startsWith("/") ? "" : ".";
    for (const part of parts) {
      cur = `${cur}/${part}`;
      if (await this.exists(cur)) continue;
      await new Promise<void>((ok, fail) =>
        s.mkdir(cur, (e) => (e ? fail(e) : ok())),
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
      /** 写入标准输入后立即关闭；给 `eval "$(cat)"` 这类远端命令行不含内容的用法。 */
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
        if (opts.stdin !== undefined) stream.end(opts.stdin);
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
