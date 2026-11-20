// 分发达标度：读环境上技能副本的同步清单，与库里的哈希对比（对账判据与 sync.ts 相同：清单哈希）。
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";
import type { SkillRecord } from "../store/skills.js";
import { readEnvSkillDir } from "./env.js";
import { hashFiles, SKILL_FILE } from "./spec.js";
import { readManifest } from "./sync.js";

// 每台环境一项：in-sync 与库一致；behind 有副本但与库不同；missing 没有副本（探测不到时也是 missing，并带 error）。
export interface DistItem {
  hostId: string;
  version: string | null;
  hash: string | null;
  state: "in-sync" | "behind" | "missing";
  error?: string;
}

export const missing = (hostId: string, error?: string): DistItem => ({
  hostId,
  version: null,
  hash: null,
  state: "missing",
  ...(error ? { error } : {}),
});

export function timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}超时`)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

// 探测失败的环境短时间内不再重试，免得一台掉线的主机拖慢每次列表。
const DOWN_TTL_MS = 30_000;

export class HostGuard {
  private readonly down = new Map<string, { until: number; message: string }>();

  async run<T>(hostId: string, ms: number, job: () => Promise<T>): Promise<T> {
    const d = this.down.get(hostId);
    if (d && d.until > Date.now()) throw new Error(d.message);
    try {
      const v = await timed(job(), ms, "连接环境");
      this.down.delete(hostId);
      return v;
    } catch (e) {
      this.down.set(hostId, {
        until: Date.now() + DOWN_TTL_MS,
        message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}

// 某台环境上这个技能的副本状态；dirs 是应有副本的目录（全局技能一个，项目级技能每个被分配的 directory 一个）。
export async function probeCopies(
  e: ExecEnv,
  hostId: string,
  rec: SkillRecord,
  dirs: string[],
): Promise<DistItem> {
  const o = rec.origin;
  // observed 的原件就是它所在环境上的那一份。
  if (o?.kind === "observed" && o.hostId === hostId) {
    const ok = (await e.stat(pathOf(e).join(o.path, SKILL_FILE)))?.isFile;
    return ok
      ? { hostId, version: null, hash: rec.hash, state: "in-sync" }
      : missing(hostId, "原件已不存在");
  }
  let found = 0;
  let stale: { hash: string | null; version: string | null } | null = null;
  for (const dir of dirs) {
    if (!(await e.lstat(dir))) continue;
    found++;
    let m = await readManifest(e, dir);
    // 不是同步产物的同名目录：按内容算哈希对比。
    if (!m) {
      try {
        m = { hash: hashFiles(await readEnvSkillDir(e, dir)), version: null };
      } catch {
        m = { hash: "", version: null };
      }
    }
    if (m.hash !== rec.hash && !stale)
      stale = { hash: m.hash || null, version: m.version };
  }
  if (found === 0) return missing(hostId);
  // 项目级技能只在部分 directory 里有副本：算落后。
  if (!stale && found < dirs.length) stale = { hash: null, version: null };
  return stale
    ? { hostId, version: stale.version, hash: stale.hash, state: "behind" }
    : { hostId, version: rec.version, hash: rec.hash, state: "in-sync" };
}
