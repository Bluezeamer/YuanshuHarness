// 远程主机的虚拟 ~/.pi（docs/model/plugin.md §5）：包与插件在主机上读写 ~/.pi 时，
// 文件原语改落在 Server 数据目录里按主机区分的镜像目录，不往用户的远程机器写任何文件。
// exec 不重定向：远程 bash 里的 cat ~/.pi/x 看到的仍是远端真实目录。
import path from "node:path";
import { LocalFs } from "./local.js";
import type { ExecEnv, ExecOptions } from "./types.js";

const posix = path.posix;

/**
 * 包在别的 ExecEnv 外面，只把 `<remoteHome>/.pi` 下的文件原语换成本机镜像目录。
 * remoteHome 建连后才知道（homedir() 是异步的），所以传一个惰性取值函数，首次用到再解析并缓存；
 * 取不到（null）时整层直通。
 */
export class VirtualPiEnv implements ExecEnv {
  readonly id: string;
  readonly kind: ExecEnv["kind"];
  readonly os: ExecEnv["os"];
  // 镜像目录只有本机的文件系统语义，本机那份实现复用 LocalFs。
  private readonly local = new LocalFs();
  // 解析出来的 `<remoteHome>/.pi`；取不到家目录时留 undefined，下次再试。
  private root: string | undefined;

  // 可选能力跟着 inner 走：inner 没实现就不冒充实现（MCP 远程启动靠 openStdio 是否存在来分流）。
  openStdio?: ExecEnv["openStdio"];
  loginEnv?: ExecEnv["loginEnv"];
  refreshLoginEnv?: ExecEnv["refreshLoginEnv"];
  openShell?: ExecEnv["openShell"];
  openTcp?: ExecEnv["openTcp"];

  constructor(
    private readonly inner: ExecEnv,
    /** Server 本机存放「远端 ~/.pi 镜像」的根目录，如 `<dataDir>/virtual-pi/<envId>` */
    private readonly localRoot: string,
    /** 远端环境的家目录；建连前不知道时给取值函数 */
    private readonly remoteHome: () => Promise<string | null>,
  ) {
    this.id = inner.id;
    this.kind = inner.kind;
    this.os = inner.os;
    const { openStdio, loginEnv, refreshLoginEnv, openShell, openTcp } = inner;
    if (openStdio) this.openStdio = (c) => openStdio.call(inner, c);
    if (loginEnv) this.loginEnv = () => loginEnv.call(inner);
    if (refreshLoginEnv)
      this.refreshLoginEnv = () => refreshLoginEnv.call(inner);
    if (openShell) this.openShell = (o) => openShell.call(inner, o);
    if (openTcp) this.openTcp = (p) => openTcp.call(inner, p);
  }

  /** `<remoteHome>/.pi` 的远端路径；家目录还取不到（null）时为 null。取不到不缓存，下次再试。 */
  private async piRoot(): Promise<string | null> {
    if (this.root === undefined) {
      const home = await this.remoteHome();
      if (home === null) return null;
      this.root = posix.join(home, ".pi");
    }
    return this.root;
  }

  /** `.pi` 目录对应的本地镜像路径；不在 `<remoteHome>/.pi` 下时为 null。 */
  private async mirror(p: string): Promise<string | null> {
    const root = await this.piRoot();
    if (root === null) return null;
    const at = posix.normalize(p);
    if (at !== root && !at.startsWith(`${root}/`)) return null;
    return path.join(this.localRoot, at.slice(root.length).replace(/^\//, ""));
  }

  homedir(): Promise<string> {
    return this.inner.homedir();
  }

  async stat(p: string) {
    const m = await this.mirror(p);
    return m === null ? this.inner.stat(p) : this.local.stat(m);
  }

  async lstat(p: string) {
    const m = await this.mirror(p);
    return m === null ? this.inner.lstat(p) : this.local.lstat(m);
  }

  async realpath(p: string) {
    const m = await this.mirror(p);
    return m === null ? this.inner.realpath(p) : this.local.realpath(m);
  }

  async readdir(p: string) {
    const m = await this.mirror(p);
    return m === null ? this.inner.readdir(p) : this.local.readdir(m);
  }

  readlink(p: string) {
    return this.inner.readlink(p);
  }

  async readFile(p: string) {
    const m = await this.mirror(p);
    return m === null ? this.inner.readFile(p) : this.local.readFile(m);
  }

  async writeFile(p: string, data: Buffer | string) {
    const m = await this.mirror(p);
    if (m === null) return this.inner.writeFile(p, data);
    await this.local.mkdirp(path.dirname(m));
    return this.local.writeFile(m, data);
  }

  async mkdirp(p: string, mode?: number) {
    const m = await this.mirror(p);
    return m === null ? this.inner.mkdirp(p, mode) : this.local.mkdirp(m, mode);
  }

  async rename(from: string, to: string) {
    const a = await this.mirror(from);
    const b = await this.mirror(to);
    // 一端在镜像里、另一端不在的改名没法跨两套文件系统做，交回原环境（会如实失败）。
    return a !== null && b !== null
      ? this.local.rename(a, b)
      : this.inner.rename(from, to);
  }

  async remove(p: string, recursive?: boolean) {
    const m = await this.mirror(p);
    return m === null
      ? this.inner.remove(p, recursive)
      : this.local.remove(m, recursive);
  }

  async readStream(p: string, range?: { start: number; end: number }) {
    const m = await this.mirror(p);
    return m === null
      ? this.inner.readStream(p, range)
      : this.local.readStream(m, range);
  }

  async writeStream(p: string, opts?: Parameters<ExecEnv["writeStream"]>[1]) {
    const m = await this.mirror(p);
    if (m === null) return this.inner.writeStream(p, opts);
    // 镜像目录首次写入时建出来（LocalFs.mkdirp 是递归的）。
    await this.local.mkdirp(path.dirname(m));
    return this.local.writeStream(m, opts);
  }

  exec(command: string, cwd: string, opts: ExecOptions) {
    return this.inner.exec(command, cwd, opts);
  }
}
