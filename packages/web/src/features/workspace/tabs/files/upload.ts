// 本机文件拖入文件浏览器：把一次拖放的相对路径变成「先建目录、再逐文件写」的计划并执行。
// 同名检查按父目录各列一次（不是逐文件 stat）：一次拖入几十个文件也只会多出几个请求。
import { listFiles, makeDir, uploadFile } from "../../../../api/files";
import type { CallFailure, RawFailure } from "../../../../api/http";
import { baseName, freeName, joinPath, parentOf } from "./paths";
import { failText } from "./useListing";

/** 拖入的一项：file 是内容，path 是相对目标目录的路径（含拖进来的目录名） */
export interface UploadItem {
  file: File;
  path: string;
}

/** 同名时的处理方式：覆盖 / 跳过 / 自动加 (n) 后缀 */
export type ConflictChoice = "overwrite" | "skip" | "rename";

/** 目标目录里已存在的名字，key 是父目录的绝对路径 */
export type TakenMap = Map<string, Set<string>>;

export const absOf = (dir: string, rel: string): string => joinPath(dir, rel);

/** 写失败的说法：共用文案是按「读目录」写的，落到上传上要说「写入」，否则用户以为只是读不了 */
export const uploadFailText = (
  kind: CallFailure["kind"] | RawFailure,
): string => {
  // 单次上传超过服务端体积上限只有 raw 这一路会给出
  if (kind === "too_large") return "文件太大，服务端拒绝写入";
  if (kind === "forbidden") return "没有权限写入这个目录";
  return failText(kind);
};

/** 需要新建的相对目录：父目录先于子目录（建子目录前必须先有父目录） */
export function dirsOf(items: readonly UploadItem[]): string[] {
  const all = new Set<string>();
  for (const it of items) {
    const parts = it.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1)
      all.add(parts.slice(0, i).join("/"));
  }
  // 深度相同的按名字排，保证同一批上传的建目录顺序稳定
  return [...all].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
}

/** 这些目录的现状；读不到且是「不存在」时当作空（目录本就要新建） */
async function takenIn(
  token: string | null,
  env: string,
  dirs: readonly string[],
): Promise<
  { ok: true; taken: TakenMap } | { ok: false; kind: CallFailure["kind"] }
> {
  const taken: TakenMap = new Map();
  for (const dir of dirs) {
    const r = await listFiles(token, env, dir, true);
    if (!r.ok) {
      // 目录不存在 → 没有同名；其余（无权限、断线）必须上报，不能当成「没有同名」继续冒进
      if (r.kind === "not_found") {
        taken.set(dir, new Set());
        continue;
      }
      return { ok: false, kind: r.kind };
    }
    taken.set(dir, new Set(r.data.entries.map((e) => e.name)));
  }
  return { ok: true, taken };
}

export interface Conflict {
  /** 相对路径，用于弹窗里告诉用户是哪个文件 */
  rel: string;
  abs: string;
}

export type Scan =
  | { ok: true; taken: TakenMap; conflicts: Conflict[] }
  | { ok: false; kind: CallFailure["kind"] };

/** 扫一遍目标目录，找出会被覆盖的文件；读不了目录时返回失败原因 */
export async function findConflicts(
  token: string | null,
  env: string,
  dir: string,
  items: readonly UploadItem[],
): Promise<Scan> {
  const parents = [
    ...new Set(items.map((it) => parentOf(absOf(dir, it.path)))),
  ];
  const r = await takenIn(token, env, parents);
  if (!r.ok) return r;
  const conflicts = items
    .map((it) => ({ rel: it.path, abs: absOf(dir, it.path) }))
    .filter((c) => r.taken.get(parentOf(c.abs))?.has(baseName(c.abs)));
  return { ok: true, taken: r.taken, conflicts };
}

export interface UploadOutcome {
  /** 成功写入的文件数 */
  done: number;
  skipped: number;
  renamed: number;
  failed: { rel: string; reason: string }[];
}

export interface RunArgs {
  token: string | null;
  env: string;
  dir: string;
  sessionId: string | null;
  items: readonly UploadItem[];
  /** findConflicts 给出的现状；改名时会把新名字也记进去，避免同名文件各自取到同一个 (2) */
  taken: TakenMap;
  choice: ConflictChoice;
  /** 每完成一个文件回调一次（进度提示用） */
  onProgress?(done: number, total: number): void;
}

/** 并发上传数：太高会压服务器与连接池，4 在实测里吞吐与稳定性的折中 */
const UPLOAD_CONCURRENCY = 4;

/** 已分配好的上传任务：路径与是否覆盖在并发前就定死，避免并发下改名撞车 */
interface Planned {
  item: UploadItem;
  to: string;
  overwrite: boolean;
}

/** 该文件的某个父目录建失败了就返回失败原因，避免逐个文件重复报同一个错 */
function blockedBy(rel: string, dirErr: ReadonlyMap<string, string>) {
  const parts = rel.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i += 1) {
    const err = dirErr.get(parts.slice(0, i).join("/"));
    if (err) return err;
  }
  return null;
}

/**
 * 执行一批上传：先递归建目录，再并发写文件；失败逐条汇总，不中断整批。
 * 路径分配（含重名改名）必须串行做完再并发上传，否则同批两个同名文件会各自
 * 取到同一个「重命名」结果，落到同一个路径上互相覆盖。
 */
export async function runUpload(a: RunArgs): Promise<UploadOutcome> {
  const out: UploadOutcome = { done: 0, skipped: 0, renamed: 0, failed: [] };
  const dirErr = new Map<string, string>();
  for (const rel of dirsOf(a.items)) {
    const r = await makeDir(a.token, a.env, joinPath(a.dir, rel), a.sessionId);
    // 目录已存在（合并进已有目录）不算失败
    if (!r.ok && r.kind !== "conflict") dirErr.set(rel, uploadFailText(r.kind));
  }

  // 第一遍：串行分配目标路径（跳过的在这里就剔除）
  const planned: Planned[] = [];
  let processed = 0;
  for (const it of a.items) {
    processed += 1;
    const blocked = blockedBy(it.path, dirErr);
    if (blocked) {
      out.failed.push({ rel: it.path, reason: blocked });
      a.onProgress?.(processed, a.items.length);
      continue;
    }
    const abs = absOf(a.dir, it.path);
    const parent = parentOf(abs);
    const name = baseName(abs);
    let names = a.taken.get(parent);
    if (!names) {
      names = new Set();
      a.taken.set(parent, names);
    }
    if (names.has(name)) {
      if (a.choice === "skip") {
        out.skipped += 1;
        continue;
      }
      if (a.choice === "rename") {
        const freed = freeName(names, name);
        names.add(freed);
        planned.push({
          item: it,
          to: joinPath(parent, freed),
          overwrite: false,
        });
        out.renamed += 1;
        continue;
      }
      planned.push({ item: it, to: abs, overwrite: true });
      continue;
    }
    names.add(name);
    planned.push({ item: it, to: abs, overwrite: false });
  }

  // 第二遍：并发上传，进度按完成数推进
  let done = processed - planned.length;
  a.onProgress?.(done, a.items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < planned.length) {
      const p = planned[cursor];
      cursor += 1;
      if (!p) return;
      const r = await uploadFile(
        a.token,
        a.env,
        p.to,
        p.item.file,
        p.overwrite,
        a.sessionId,
      );
      if (r.ok) out.done += 1;
      else
        out.failed.push({
          rel: p.item.path,
          reason: uploadFailText(r.kind),
        });
      done += 1;
      a.onProgress?.(done, a.items.length);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, planned.length) },
      worker,
    ),
  );
  return out;
}
