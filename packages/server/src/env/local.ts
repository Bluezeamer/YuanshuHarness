import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { LOCAL_ENV_ID } from "../store/environments.js";
import type { DirEntry, ExecEnv, ExecOptions, FileStat } from "./types.js";

const toStat = (s: Stats): FileStat => ({
  isDirectory: s.isDirectory(),
  isFile: s.isFile(),
  isSymlink: s.isSymbolicLink(),
  size: s.size,
  mtimeMs: s.mtimeMs,
});

const orNull = async <T>(f: () => Promise<T>): Promise<T | null> => {
  try {
    return await f();
  } catch {
    return null;
  }
};

export class LocalEnv implements ExecEnv {
  readonly id = LOCAL_ENV_ID;
  readonly kind = "local" as const;
  readonly os =
    process.platform === "win32" ? ("windows" as const) : ("posix" as const);
  private readonly shell = createLocalBashOperations();

  homedir = async () => homedir();
  stat = (p: string) => orNull(async () => toStat(await stat(p)));
  lstat = (p: string) => orNull(async () => toStat(await lstat(p)));
  realpath = (p: string) => orNull(() => realpath(p));
  readFile = (p: string) => readFile(p);
  writeFile = (p: string, data: Buffer | string) => writeFile(p, data);
  mkdirp = async (p: string) => {
    await mkdir(p, { recursive: true });
  };

  async readdir(p: string): Promise<DirEntry[]> {
    const list = await readdir(p, { withFileTypes: true });
    return list.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  }

  async exec(command: string, cwd: string, opts: ExecOptions) {
    const { exitCode } = await this.shell.exec(command, cwd, opts);
    return { exitCode: exitCode ?? 1 };
  }
}
