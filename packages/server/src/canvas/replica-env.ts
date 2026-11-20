// 画布用的环境：`<项目>/.canvas/` 之内的路径落到 Server 本机的副本，之外的（项目文件、别处的引用）照旧走远端。
// 对 CanvasRepo、接口与缩略图完全透明——它们仍然拿着远端的绝对路径说话。副本里的 git 命令也在本机跑：
// 命令里的 `.canvas` 路径（git.ts 一律经 quote 拼进命令）换成本机路径，cwd 同理。写完通知镜像去推。
import nodePath from "node:path";
import type { Writable } from "node:stream";
import type { ExecEnv, ExecOptions, WriteOptions } from "../env/types.js";
import { quote } from "../git/status.js";
import { isInside, pathOf } from "../permission/paths.js";
import type { CanvasMirror } from "./mirror.js";

export interface ReplicaEnvOptions {
  remote: ExecEnv;
  /** 本机，要能 exec */
  local: ExecEnv;
  /** 远端 `<项目>/.canvas` */
  remoteRoot: string;
  /** 副本的 `.canvas` */
  localRoot: string;
  mirror: Pick<CanvasMirror, "ready" | "touch">;
}

export class ReplicaEnv implements ExecEnv {
  readonly id: string;
  readonly kind: ExecEnv["kind"];
  readonly os: ExecEnv["os"];
  readonly openStdio?: ExecEnv["openStdio"];
  readonly openShell?: ExecEnv["openShell"];
  readonly loginEnv?: ExecEnv["loginEnv"];
  readonly refreshLoginEnv?: ExecEnv["refreshLoginEnv"];
  private readonly rp: ReturnType<typeof pathOf>;

  constructor(private readonly o: ReplicaEnvOptions) {
    const { remote } = o;
    this.id = remote.id;
    this.kind = remote.kind;
    this.os = remote.os;
    this.rp = pathOf(remote);
    if (remote.openStdio) this.openStdio = remote.openStdio.bind(remote);
    if (remote.openShell) this.openShell = remote.openShell.bind(remote);
    if (remote.loginEnv) this.loginEnv = remote.loginEnv.bind(remote);
    if (remote.refreshLoginEnv)
      this.refreshLoginEnv = remote.refreshLoginEnv.bind(remote);
  }

  homedir = () => this.o.remote.homedir();

  stat = (p: string) => this.read(p, (e, q) => e.stat(q));
  lstat = (p: string) => this.read(p, (e, q) => e.lstat(q));
  readdir = (p: string) => this.read(p, (e, q) => e.readdir(q));
  readlink = (p: string) => this.read(p, (e, q) => e.readlink(q));
  readFile = (p: string) => this.read(p, (e, q) => e.readFile(q));
  readStream = (p: string, range?: { start: number; end: number }) =>
    this.read(p, (e, q) => e.readStream(q, range));

  /** 副本里的路径是本机的真实路径，换算回远端的写法给调用方 */
  async realpath(p: string): Promise<string | null> {
    const r = await this.route(p);
    if (!r.inside) return r.env.realpath(p);
    return (await r.env.stat(r.path)) === null ? null : this.rp.normalize(p);
  }

  writeFile = (p: string, data: Buffer | string) =>
    this.change(p, (e, q) => e.writeFile(q, data));
  mkdirp = (p: string, mode?: number) =>
    this.change(p, (e, q) => e.mkdirp(q, mode));
  remove = (p: string, recursive?: boolean) =>
    this.change(p, (e, q) => e.remove(q, recursive));

  async writeStream(p: string, opts?: WriteOptions): Promise<Writable> {
    const r = await this.route(p);
    const s = await r.env.writeStream(r.path, opts);
    if (r.inside) s.once("close", () => this.o.mirror.touch());
    return s;
  }

  async rename(from: string, to: string): Promise<void> {
    const a = await this.route(from);
    const b = await this.route(to);
    if (a.inside !== b.inside)
      throw new Error("不能把文件在 .canvas 内外之间改名");
    try {
      await a.env.rename(a.path, b.path);
    } finally {
      if (a.inside) this.o.mirror.touch();
    }
  }

  async exec(
    command: string,
    cwd: string,
    opts: ExecOptions,
  ): Promise<{ exitCode: number }> {
    const r = await this.route(cwd);
    if (!r.inside) return r.env.exec(command, cwd, opts);
    const { remoteRoot, localRoot } = this.o;
    try {
      return await r.env.exec(
        command.split(quote(remoteRoot)).join(quote(localRoot)),
        r.path,
        opts,
      );
    } finally {
      this.o.mirror.touch();
    }
  }

  /** 路径落在哪边；落在副本里的先等副本可用（第一次要从远端接入）。 */
  private async route(
    p: string,
  ): Promise<{ env: ExecEnv; path: string; inside: boolean }> {
    const { remote, local, remoteRoot, localRoot, mirror } = this.o;
    if (!isInside(remoteRoot, p, this.rp))
      return { env: remote, path: p, inside: false };
    await mirror.ready();
    const rel = this.rp.relative(remoteRoot, p);
    return {
      env: local,
      path:
        rel === "" ? localRoot : nodePath.join(localRoot, ...rel.split("/")),
      inside: true,
    };
  }

  private async read<T>(
    p: string,
    f: (env: ExecEnv, path: string) => Promise<T>,
  ): Promise<T> {
    const r = await this.route(p);
    return f(r.env, r.path);
  }

  private async change<T>(
    p: string,
    f: (env: ExecEnv, path: string) => Promise<T>,
  ): Promise<T> {
    const r = await this.route(p);
    try {
      return await f(r.env, r.path);
    } finally {
      if (r.inside) this.o.mirror.touch();
    }
  }
}
