// 环境原语（ADR-0034）：工具与权限判定只依赖这组接口，本机、ssh 与虚拟附件环境各一个实现。
import type { Duplex, Readable, Writable } from "node:stream";
import type { ClientChannel } from "ssh2";
import type { OsType } from "../store/environments.js";

export interface FileStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
  /** 完整 st_mode（含文件类型位）；权限位取 `mode & 0o7777`。 */
  mode: number;
}

export interface WriteOptions {
  /** 新建文件的权限位（如 0o600）。 */
  mode?: number;
  /** 排他创建：目标已存在则失败，不截断。 */
  exclusive?: boolean;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  /** 大小与修改时间：列目录时顺带带回来的环境才有（SFTP 的 readdir 本来就返回属性），本机没有 */
  size?: number;
  mtimeMs?: number;
}

/** 远端长连接进程：stdin 可持续写，stdout 与 stderr 分开（`exec` 的 stdout/stderr 是合流的，不能承载协议）。 */
export interface StdioChannel {
  /** 写 stdin，数据交给底层后 resolve */
  write(data: string): Promise<void>;
  /** 关 stdin（EOF）；读 stdin 的进程读到后会自行退出 */
  end(): void;
  onStdout(fn: (chunk: Buffer) => void): void;
  onStderr(fn: (chunk: Buffer) => void): void;
  /** 通道关闭（进程退出或连接断开）；只触发一次，注册时若已关闭则立即触发 */
  onClose(fn: () => void): void;
  /** 向会话的直接进程发信号请求（只对那个 pid 生效） */
  signal(name: "TERM" | "KILL"): void;
  /** 立即关闭通道（不保证杀掉远端进程） */
  close(): void;
}

export interface ExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  /** 秒，与 SDK bash 工具一致；超时抛 `timeout:<秒>`。 */
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecEnv {
  readonly id: string;
  readonly kind: "local" | "ssh" | "virtual";
  readonly os: OsType;
  homedir(): Promise<string>;
  /** 跟随符号链接；不存在或无权访问返回 null。 */
  stat(p: string): Promise<FileStat | null>;
  lstat(p: string): Promise<FileStat | null>;
  /** 完整规范化（含中间目录的符号链接）；不存在、悬空、循环返回 null。 */
  realpath(p: string): Promise<string | null>;
  readdir(p: string): Promise<DirEntry[]>;
  /** 链接目标原文；不是链接或不存在返回 null。 */
  readlink(p: string): Promise<string | null>;
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer | string): Promise<void>;
  /** 递归创建；已存在不报错。给了 mode 时只设置 p 本身（由本次调用新建时），中间目录用默认。 */
  mkdirp(p: string, mode?: number): Promise<void>;
  /** POSIX 语义：目标是已存在的文件时原子替换；目标是非空目录则失败。 */
  rename(from: string, to: string): Promise<void>;
  /** 不跟随符号链接；目录须 recursive，否则只删空目录。不存在抛错。 */
  remove(p: string, recursive?: boolean): Promise<void>;
  /** 流式读写，供传输与文件接口使用，避免大文件整个进内存。range 为闭区间字节偏移。 */
  readStream(
    p: string,
    range?: { start: number; end: number },
  ): Promise<Readable>;
  /**
   * 返回时文件已打开：exclusive（O_EXCL）时目标已存在会在此抛错，调用方据此知道文件是自己建的。
   * mode 为新建文件的权限位，不受 umask 收窄。
   */
  writeStream(p: string, opts?: WriteOptions): Promise<Writable>;
  /** 命令原样执行；stdout 与 stderr 合并交给 onData。被信号终止报 128+n。 */
  exec(
    command: string,
    cwd: string,
    opts: ExecOptions,
  ): Promise<{ exitCode: number }>;
  /** 开一条长连接命令通道（仅 ssh 环境实现）。 */
  openStdio?(command: string): Promise<StdioChannel>;
  /** 交互 shell，给终端用（仅 ssh 环境实现；包装层原样透传）。 */
  openShell?(opts: {
    cols: number;
    rows: number;
    cwd?: string;
  }): Promise<ClientChannel>;
  /**
   * 主机上交互登录 shell 的环境，相对 exec 默认环境多出来或改了值的变量（PATH、NVM_* 等）。
   * exec 与 MCP 远端启动都会带上，让命令像直接 ssh 登录那样找得到 ~/.local/bin 里的东西。仅 ssh 环境实现。
   */
  loginEnv?(): Promise<Record<string, string>>;
  /** 丢掉缓存重抓（用户在主机上装好依赖后重载时用）。 */
  refreshLoginEnv?(): Promise<void>;
  /** 连接该环境回环地址上的 TCP 端口，给浏览器代理转发服务端口用（本机与 ssh 环境实现）。 */
  openTcp?(port: number): Promise<Duplex>;
}

/** 环境连接状态，供 REST 与 WebUI 展示。 */
export interface EnvStatus {
  id: string;
  state: "local" | "virtual" | "connected" | "disconnected" | "error";
  error?: string;
  /** ssh 环境已记录的主机密钥指纹；未连过为 null。 */
  hostKey?: string | null;
}
