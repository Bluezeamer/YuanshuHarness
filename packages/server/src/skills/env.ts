// 经 ExecEnv 原语识别环境里的 skill、读出整个 skill 目录（纳入库用）。
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";
import { FILE_MAX, SKILL_FILE, type SkillFile, sizeProblem } from "./spec.js";

// pi 实际扫描的约定目录（skills.md；ancestors 的 .agents/skills 不在识别范围）。
export const ROOTS = [
  "user-pi",
  "user-agents",
  "project-pi",
  "project-agents",
] as const;
export type SkillRoot = (typeof ROOTS)[number];

// 元枢专属命名空间：同步目标，位于上面 *-agents 根目录之下。
export const NAMESPACE = "yuanshu";

export interface EnvSkill {
  name: string;
  description: string;
  dir: string;
  root: SkillRoot;
  // 位于元枢命名空间内（由同步器写入）。
  managed: boolean;
}

const SKIP = new Set(["node_modules", ".git"]);
const MAX_DEPTH = 5;

export async function rootDirs(
  env: ExecEnv,
  workspacePath: string | null,
): Promise<{ root: SkillRoot; dir: string }[]> {
  const p = pathOf(env);
  const home = await env.homedir();
  const out: { root: SkillRoot; dir: string }[] = [
    { root: "user-pi", dir: p.join(home, ".pi", "agent", "skills") },
    { root: "user-agents", dir: p.join(home, ".agents", "skills") },
  ];
  if (workspacePath !== null) {
    out.push(
      { root: "project-pi", dir: p.join(workspacePath, ".pi", "skills") },
      {
        root: "project-agents",
        dir: p.join(workspacePath, ".agents", "skills"),
      },
    );
  }
  return out;
}

async function describe(
  env: ExecEnv,
  dir: string,
  fallbackName: string,
): Promise<{ name: string; description: string }> {
  const p = pathOf(env);
  try {
    const fm = parseFrontmatter(
      (await env.readFile(p.join(dir, SKILL_FILE))).toString("utf8"),
    ).frontmatter;
    return {
      name:
        typeof fm.name === "string" && fm.name !== "" ? fm.name : fallbackName,
      description: typeof fm.description === "string" ? fm.description : "",
    };
  } catch {
    return { name: fallbackName, description: "" };
  }
}

export async function scanEnvSkills(
  env: ExecEnv,
  workspacePath: string | null,
): Promise<EnvSkill[]> {
  const p = pathOf(env);
  const seen = new Set<string>();
  const out: EnvSkill[] = [];
  const walk = async (
    dir: string,
    root: SkillRoot,
    base: string,
    depth: number,
  ) => {
    if (depth > MAX_DEPTH || seen.has(dir)) return;
    seen.add(dir);
    let entries: Awaited<ReturnType<ExecEnv["readdir"]>>;
    try {
      entries = await env.readdir(dir);
    } catch {
      return;
    }
    if (entries.some((e) => e.name === SKILL_FILE && !e.isDirectory)) {
      const d = await describe(env, dir, p.basename(dir));
      const rel = p.relative(base, dir);
      out.push({
        ...d,
        dir,
        root,
        managed: root.endsWith("agents") && rel.split(p.sep)[0] === NAMESPACE,
      });
      return;
    }
    for (const e of entries)
      if (
        e.isDirectory &&
        !e.isSymlink &&
        !e.name.startsWith(".") &&
        !SKIP.has(e.name)
      )
        await walk(p.join(dir, e.name), root, base, depth + 1);
  };
  for (const r of await rootDirs(env, workspacePath))
    await walk(r.dir, r.root, r.dir, 0);
  return out;
}

// 读出 skill 目录的全部文件（跳过符号链接、点开头与 node_modules）；超限抛错。
export async function readEnvSkillDir(
  env: ExecEnv,
  dir: string,
): Promise<SkillFile[]> {
  const p = pathOf(env);
  const out: SkillFile[] = [];
  const walk = async (abs: string, rel: string) => {
    for (const e of await env.readdir(abs)) {
      if (e.isSymlink || e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      const full = p.join(abs, e.name);
      if (e.isDirectory) await walk(full, r);
      else {
        const st = await env.lstat(full);
        if (!st?.isFile) continue;
        if (st.size > FILE_MAX) throw new Error(`${r} 超过单文件大小上限`);
        out.push({ path: r, content: await env.readFile(full) });
        const big = sizeProblem(out);
        if (big) throw new Error(big);
      }
    }
  };
  await walk(dir, "");
  return out;
}
