import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecEnv } from "../env/types.js";

export const CONVENTIONS_FILE = "AGENTS.md";
export const CONVENTIONS_MAX = 100_000;

// Server 级全局约定：数据目录下的 AGENTS.md，经 API 读写。
export class GlobalConventions {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, CONVENTIONS_FILE);
  }

  read(): string {
    try {
      return readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  write(content: string): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, content, "utf8");
  }
}

// workspace 里的 AGENTS.md，经环境读原语读取（本机与 ssh 同一路径）。
// 不存在、不是文件或超过上限都读作没有：约定缺失不应挡住会话创建。
export async function readProjectConventions(
  env: ExecEnv,
  cwd: string,
): Promise<string | null> {
  const join = env.os === "windows" ? path.win32.join : path.posix.join;
  const file = join(cwd, CONVENTIONS_FILE);
  try {
    const st = await env.stat(file);
    if (!st?.isFile || st.size > CONVENTIONS_MAX) return null;
    return (await env.readFile(file)).toString("utf8");
  } catch {
    return null;
  }
}
