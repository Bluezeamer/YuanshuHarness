// 两份固定文件：全局 `<ysHome>/AGENTS.md`（Server 本机）与项目主目录下的 `AGENTS.md`（经该目录的环境读）。
// 只读，原文送进提示词；没有、读不了、只有空白都当作没有（prompt.md S2）。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path, { posix } from "node:path";
import type { ExecEnv } from "../env/types.js";

export const AGENTS_FILE = "AGENTS.md";

export interface AgentsFiles {
  /** 全局文件的原文（去首尾空白）；没有为 null */
  global: string | null;
  /** 会话主目录下项目文件的原文（去首尾空白）；没有为 null */
  project: string | null;
}

export const NO_AGENTS_FILES: AgentsFiles = { global: null, project: null };

export const globalAgentsPath = (ysHome: string): string =>
  path.join(ysHome, AGENTS_FILE);

// 空白文件等于没有文件
const present = (raw: string): string | null => raw.trim() || null;

/** ysHome 在 Server 本机；primary 是主目录所在环境与根路径（拿不到环境就是 null） */
export async function readAgentsFiles(
  ysHome: string,
  primary: { env: ExecEnv; root: string } | null,
): Promise<AgentsFiles> {
  return {
    global: await readOrNull(() => readFile(globalAgentsPath(ysHome), "utf8")),
    project: primary
      ? await readOrNull(async () =>
          (
            await primary.env.readFile(posix.join(primary.root, AGENTS_FILE))
          ).toString("utf8"),
        )
      : null,
  };
}

async function readOrNull(read: () => Promise<string>): Promise<string | null> {
  try {
    return present(await read());
  } catch {
    // 不存在与读不到都按「没有」处理
    return null;
  }
}

/** 设置页用：文件原文（不去空白）；不存在返回空串 */
export async function readGlobalAgentsMd(ysHome: string): Promise<string> {
  try {
    return await readFile(globalAgentsPath(ysHome), "utf8");
  } catch {
    return "";
  }
}

export async function writeGlobalAgentsMd(
  ysHome: string,
  content: string,
): Promise<void> {
  const file = globalAgentsPath(ysHome);
  await mkdir(path.dirname(file), { recursive: true });
  // 先写同目录临时文件再改名：进程中途退出不会留下半截文件
  const tmp = `${file}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}
