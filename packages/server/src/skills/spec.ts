// Agent Skills 规范的校验、相对路径安全检查与内容哈希；规则与 pi 的 skills.js 保持一致。
import { createHash } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const SKILL_FILE = "SKILL.md";
const NAME_MAX = 64;
const DESC_MAX = 1024;
export const FILE_MAX = 1024 * 1024;
export const FILES_MAX = 200;
export const TOTAL_MAX = 8 * 1024 * 1024;

export interface SkillCheck {
  errors: string[];
  warnings: string[];
  description: string | null;
}

export function nameProblems(name: string): string[] {
  const out: string[] = [];
  if (name === "" || name.length > NAME_MAX)
    out.push(`name 长度须为 1–${NAME_MAX} 个字符`);
  if (!/^[a-z0-9-]*$/.test(name))
    out.push("name 只能包含小写字母、数字和连字符");
  if (name.startsWith("-") || name.endsWith("-"))
    out.push("name 不能以连字符开头或结尾");
  if (name.includes("--")) out.push("name 不能包含连续连字符");
  return out;
}

// libraryName 是库里的名字（也是同步目录名）；frontmatter 的 name 与它不一致视为错误。
export function checkSkillMd(libraryName: string, content: string): SkillCheck {
  const errors = nameProblems(libraryName);
  const warnings: string[] = [];
  let fm: Record<string, unknown> = {};
  try {
    fm = parseFrontmatter(content).frontmatter;
  } catch (err) {
    errors.push(
      `frontmatter 无法解析：${err instanceof Error ? err.message : String(err)}`,
    );
    return { errors, warnings, description: null };
  }
  if (!/^\uFEFF?---/.test(content))
    errors.push("SKILL.md 必须以 --- 开头的 frontmatter 起始");
  if (fm.name === undefined)
    warnings.push("frontmatter 缺少 name，将回退为目录名");
  else if (typeof fm.name !== "string" || fm.name !== libraryName)
    errors.push(`frontmatter 的 name 必须与 skill 名称一致（${libraryName}）`);
  const d = fm.description;
  const description = typeof d === "string" && d.trim() !== "" ? d : null;
  if (description === null) errors.push("frontmatter 的 description 必填");
  else if (description.length > DESC_MAX)
    errors.push(`description 超过 ${DESC_MAX} 个字符`);
  return { errors, warnings, description };
}

// skill 内的相对路径：POSIX 风格、不含 .. / 空段 / 反斜杠 / NUL；不合规返回 null。
export function safeRelPath(p: unknown): string | null {
  if (typeof p !== "string" || p === "" || p.length > 512) return null;
  if (p.includes("\0") || p.includes("\\") || p.startsWith("/")) return null;
  const segs = p.split("/");
  return segs.every((s) => s !== "" && s !== "." && s !== "..") ? p : null;
}

export interface SkillFile {
  path: string;
  content: Buffer;
}

// 内容哈希：与目录位置无关，只看（相对路径，内容）集合，本机与环境端用同一算法对比。
export function hashFiles(files: SkillFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update(
      `${f.path}\0${createHash("sha256").update(f.content).digest("hex")}\n`,
    );
  }
  return h.digest("hex");
}

// 文件集合的体量上限：库与同步共用，防止一个异常目录拖垮内存。
export function sizeProblem(files: SkillFile[]): string | null {
  if (files.length > FILES_MAX) return `文件数超过 ${FILES_MAX}`;
  let total = 0;
  for (const f of files) {
    if (f.content.length > FILE_MAX)
      return `${f.path} 超过 ${FILE_MAX / 1024 / 1024} MiB`;
    total += f.content.length;
  }
  return total > TOTAL_MAX ? `总大小超过 ${TOTAL_MAX / 1024 / 1024} MiB` : null;
}
