// 环境原语（ADR-0034）：工具与权限判定只依赖这组接口，本机与 ssh 各一个实现。
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
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer | string): Promise<void>;
  mkdirp(p: string): Promise<void>;
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
