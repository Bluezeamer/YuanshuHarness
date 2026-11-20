import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  fchmod,
  type Stats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { LOCAL_ENV_ID } from "../store/environments.js";
import type {
  DirEntry,
  ExecEnv,
  ExecOptions,
  FileStat,
  WriteOptions,
} from "./types.js";

const toStat = (s: Stats): FileStat => ({
  isDirectory: s.isDirectory(),
  isFile: s.isFile(),
  isSymlink: s.isSymbolicLink(),
  size: s.size,
  mtimeMs: s.mtimeMs,
  mode: s.mode,
});

const promisifiedFchmod = promisify(fchmod);

const orNull = async <T>(f: () => Promise<T>): Promise<T | null> => {
  try {
    return await f();
  } catch {
    return null;
  }
};

/**
 * 本机文件系统原语。本机环境与虚拟附件环境（attachment）共用这一份实现：
 * 虚拟环境只是换掉 id/kind/homedir 并禁用命令执行，文件原语照旧落在 Server 本机。
 */
export class LocalFs {
  readonly os =
    process.platform === "win32" ? ("windows" as const) : ("posix" as const);

  homedir = async () => homedir();
  stat = (p: string) => orNull(async () => toStat(await stat(p)));
  lstat = (p: string) => orNull(async () => toStat(await lstat(p)));
  realpath = (p: string) => orNull(() => realpath(p));
  readFile = (p: string) => readFile(p);
  writeFile = (p: string, data: Buffer | string) => writeFile(p, data);
  mkdirp = async (p: string, mode?: number) => {
    // recursive 返回首个新建的目录；有返回值说明 p 是这次建出来的
    const made = await mkdir(p, { recursive: true });
    if (made !== undefined && mode !== undefined) await chmod(p, mode);
  };
  readlink = (p: string) => orNull(() => readlink(p));
  rename = (from: string, to: string) => rename(from, to);
  remove = async (p: string, recursive = false) => {
    if (recursive || !(await lstat(p)).isDirectory())
      await rm(p, { recursive });
    else await rmdir(p);
  };
  readStream = async (p: string, range?: { start: number; end: number }) =>
    createReadStream(p, range);
  writeStream = async (p: string, o: WriteOptions = {}) => {
    const s = createWriteStream(p, {
      flags: o.exclusive ? "wx" : "w",
      ...(o.mode === undefined ? {} : { mode: o.mode }),
    });
    const [fd] = (await once(s, "open")) as [number];
    // open 的 mode 会被 umask 收窄；ssh 一侧是精确设置，这里对齐
    if (o.mode !== undefined)
      await promisifiedFchmod(fd, o.mode).catch((err: unknown) => {
        s.destroy();
        throw err;
      });
    return s;
  };

  async readdir(p: string): Promise<DirEntry[]> {
    const list = await readdir(p, { withFileTypes: true });
    return list.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  }
}

export class LocalEnv extends LocalFs implements ExecEnv {
  readonly id = LOCAL_ENV_ID;
  readonly kind = "local" as const;
  private readonly shell = createLocalBashOperations();

  async exec(command: string, cwd: string, opts: ExecOptions) {
    const { exitCode } = await this.shell.exec(command, cwd, opts);
    return { exitCode: exitCode ?? 1 };
  }

  // 用 localhost 而不是 127.0.0.1：happy eyeballs 会同时试 IPv4 与 IPv6，很多开发服务只监听 ::1
  openTcp(port: number): Promise<net.Socket> {
    return new Promise((ok, fail) => {
      const socket = net.connect({ host: "localhost", port });
      socket.once("connect", () => ok(socket));
      socket.once("error", fail);
    });
  }
}
