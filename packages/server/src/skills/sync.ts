// 把库里的 skill 同步到环境的约定目录（ADR-0055）：哈希一致跳过，库更新则覆盖，重名手写 skill 不覆盖。
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";
import type { SkillMeta, SkillScope } from "../store/skills.js";
import { NAMESPACE, readEnvSkillDir, rootDirs } from "./env.js";
import { hashFiles, SKILL_FILE, type SkillFile } from "./spec.js";

// 写在 skill 目录里的同步清单；点开头，读库、算哈希时都会被跳过。
const MANIFEST = ".yuanshu-sync.json";

export type SyncStatus =
  | "added"
  | "updated"
  | "unchanged"
  | "conflict"
  | "failed";

export interface SyncItem {
  name: string;
  scope: SkillScope;
  status: SyncStatus;
  // 该 skill 在环境里的目录；conflict、failed 时为空。
  dir: string | null;
  description: string;
  message?: string;
}

export interface SyncInput {
  meta: SkillMeta;
  files: SkillFile[];
}

const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// 全局 skill 放用户目录，项目级 skill 放项目目录；都在 *-agents 根下的元枢命名空间里。
export function targetDir(
  env: ExecEnv,
  home: string,
  workspacePath: string,
  scope: SkillScope,
  name: string,
): string {
  const base = scope === "global" ? home : workspacePath;
  return pathOf(env).join(base, ".agents", "skills", NAMESPACE, name);
}

async function manifestHash(env: ExecEnv, dir: string): Promise<string | null> {
  try {
    const raw = await env.readFile(pathOf(env).join(dir, MANIFEST));
    const h = (JSON.parse(raw.toString("utf8")) as { hash?: unknown }).hash;
    return typeof h === "string" ? h : null;
  } catch {
    return null;
  }
}

// 约定根目录下同名的非元枢 skill（只探测 <根>/<name>，不全树扫描：ssh 下逐目录往返太慢）。
async function findNative(
  env: ExecEnv,
  roots: { dir: string }[],
  name: string,
): Promise<string | null> {
  const p = pathOf(env);
  for (const r of roots) {
    const dir = p.join(r.dir, name);
    if ((await env.stat(p.join(dir, SKILL_FILE)))?.isFile) return dir;
  }
  return null;
}

async function syncOne(
  env: ExecEnv,
  home: string,
  workspacePath: string,
  input: SyncInput,
  native: string | null,
): Promise<Omit<SyncItem, "name" | "scope" | "description">> {
  const p = pathOf(env);
  const { meta, files } = input;
  if (native) {
    // 环境里已有同名的非元枢 skill：内容一致就直接用它，否则不覆盖。
    const same = hashFiles(await readEnvSkillDir(env, native)) === meta.hash;
    return same
      ? { status: "unchanged", dir: native, message: "环境里已有相同内容" }
      : {
          status: "conflict",
          dir: null,
          message: `环境里已有同名 skill：${native}，未覆盖`,
        };
  }
  const dir = targetDir(env, home, workspacePath, meta.scope, meta.name);
  const existing = await env.lstat(dir);
  if (existing) {
    const h = await manifestHash(env, dir);
    if (h === null)
      return {
        status: "conflict",
        dir: null,
        message: `${dir} 已存在且不是元枢同步产物，未覆盖`,
      };
    if (h === meta.hash && (await env.stat(p.join(dir, SKILL_FILE)))?.isFile)
      return { status: "unchanged", dir };
    // 库里删掉的文件也要从环境里清掉，所以整目录重写；目录名已由库名校验，且确认是自己的产物。
    const r = await env.exec(`rm -rf -- ${sq(dir)}`, home, {
      onData: () => {},
    });
    if (r.exitCode !== 0) throw new Error(`无法清理旧目录 ${dir}`);
  }
  await env.mkdirp(dir);
  for (const f of files) {
    const target = p.join(dir, ...f.path.split("/"));
    await env.mkdirp(p.dirname(target));
    await env.writeFile(target, f.content);
  }
  // 清单最后写：中途失败时下次同步会重来。
  await env.writeFile(
    p.join(dir, MANIFEST),
    JSON.stringify({ hash: meta.hash }),
  );
  return { status: existing ? "updated" : "added", dir };
}

// 逐个 skill 独立同步：单个失败不影响其他，也不抛出。
export async function syncSkills(
  env: ExecEnv,
  workspacePath: string,
  inputs: SyncInput[],
): Promise<SyncItem[]> {
  if (inputs.length === 0) return [];
  let home: string;
  let roots: { dir: string }[];
  try {
    home = await env.homedir();
    roots = await rootDirs(env, workspacePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return inputs.map(({ meta }) => ({
      name: meta.name,
      scope: meta.scope,
      description: meta.description,
      status: "failed",
      dir: null,
      message,
    }));
  }
  const out: SyncItem[] = [];
  for (const input of inputs) {
    const { meta } = input;
    const base = {
      name: meta.name,
      scope: meta.scope,
      description: meta.description,
    };
    try {
      const r = await syncOne(
        env,
        home,
        workspacePath,
        input,
        await findNative(env, roots, meta.name),
      );
      out.push({ ...base, ...r });
    } catch (err) {
      out.push({
        ...base,
        status: "failed",
        dir: null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
