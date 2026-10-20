// 环境原语（ADR-0034）：工具与权限判定只依赖这组接口，本机与 ssh 各一个实现。
import type { Readable, Writable } from "node:stream";
import type { OsType } from "../store/environments.js";

export interface FileStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
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
  readonly kind: "local" | "ssh";
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
  mkdirp(p: string): Promise<void>;
  /** POSIX 语义：目标是已存在的文件时原子替换；目标是非空目录则失败。 */
  rename(from: string, to: string): Promise<void>;
  /** 不跟随符号链接；目录须 recursive，否则只删空目录。不存在抛错。 */
  remove(p: string, recursive?: boolean): Promise<void>;
  /** 流式读写，供传输与文件接口使用，避免大文件整个进内存。range 为闭区间字节偏移。 */
  readStream(
    p: string,
    range?: { start: number; end: number },
  ): Promise<Readable>;
  writeStream(p: string): Promise<Writable>;
  /** 命令原样执行；stdout 与 stderr 合并交给 onData。被信号终止报 128+n。 */
  exec(
    command: string,
    cwd: string,
    opts: ExecOptions,
  ): Promise<{ exitCode: number }>;
}

/** 环境连接状态，供 REST 与 WebUI 展示。 */
export interface EnvStatus {
  id: string;
  state: "local" | "connected" | "disconnected" | "error";
  error?: string;
}
