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
  // 同步只看这几项；version 随清单写到环境里，供分发达标度显示环境副本的版本。
  meta: Pick<SkillMeta, "name" | "description" | "scope" | "hash"> & {
    version?: string | null;
  };
  files: SkillFile[];
}

const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// 全局 skill 放用户目录，项目级 skill 放项目目录；都在 *-agents 根下的元枢命名空间里。
export function targetDir(
  env: ExecEnv,
  home: string,
  directoryPath: string,
  scope: SkillScope,
  name: string,
): string {
  const base = scope === "global" ? home : directoryPath;
  return pathOf(env).join(base, ".agents", "skills", NAMESPACE, name);
}

// 目录里同步清单记录的哈希与版本；不是同步产物（没有清单）返回 null。
export async function readManifest(
  env: ExecEnv,
  dir: string,
): Promise<{ hash: string; version: string | null } | null> {
  try {
    const raw = await env.readFile(pathOf(env).join(dir, MANIFEST));
    const m = JSON.parse(raw.toString("utf8")) as {
      hash?: unknown;
      version?: unknown;
    };
    return typeof m.hash === "string"
      ? {
          hash: m.hash,
          version: typeof m.version === "string" ? m.version : null,
        }
      : null;
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
  directoryPath: string | null,
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
  // 项目级 skill 必须有 directory 路径；只有分发到主机（无 directory）时才会是 null，调用方只传全局 skill。
  if (meta.scope === "project" && directoryPath === null)
    throw new Error("项目级 skill 需要 directory 路径");
  const dir = targetDir(
    env,
    home,
    directoryPath ?? home,
    meta.scope,
    meta.name,
  );
  const existing = await env.lstat(dir);
  if (existing) {
    const h = (await readManifest(env, dir))?.hash ?? null;
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
    JSON.stringify({ hash: meta.hash, version: meta.version ?? null }),
  );
  return { status: existing ? "updated" : "added", dir };
}

// 逐个 skill 独立同步：单个失败不影响其他，也不抛出。
export async function syncSkills(
  env: ExecEnv,
  directoryPath: string | null,
  inputs: SyncInput[],
): Promise<SyncItem[]> {
  if (inputs.length === 0) return [];
  let home: string;
  let roots: { dir: string }[];
  try {
    home = await env.homedir();
    roots = await rootDirs(env, directoryPath);
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
        directoryPath,
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
