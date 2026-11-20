// 同主机移动（sessionId 一律传 null：拖放动作不归到会话审计时间线）：renameEntry 只会整体搬，且服务端不合并目录、不覆盖文件，
// 所以「重名加 (2)」与「目录按 cp -r 合并」由这里逐层落实。
import {
  type FileEntry,
  listFiles,
  removeEntry,
  renameEntry,
} from "../../../../api/files";
import { loadToken } from "../../../../api/http";
import { baseName, freeName, joinPath } from "./paths";
import { failText } from "./useListing";
import type { DragEntry } from "./verdict";

/** 每项最终落到的路径；中途失败时 moves 是已经搬完的那些，error 是失败原因 */
export interface MoveResult {
  moves: { from: string; to: string }[];
  renamed: number;
  error: string | null;
}

type Names = Map<string, FileEntry["type"]>;

class Abort extends Error {}

interface Ctx {
  env: string;
  /** 目标目录 → 目录里已有的名字；落地后同步更新，避免同批条目互相撞名 */
  names: Map<string, Names>;
  renamed: number;
}

async function listAll(env: string, dir: string): Promise<FileEntry[]> {
  const r = await listFiles(loadToken(), env, dir, true);
  if (!r.ok) throw new Abort(failText(r.kind));
  // 截断时看不全子项，合并后再删源目录会丢数据，直接放弃
  if (r.data.truncated) throw new Abort(`${dir} 里的条目太多，无法合并`);
  return r.data.entries;
}

async function namesOf(c: Ctx, dir: string): Promise<Names> {
  const hit = c.names.get(dir);
  if (hit) return hit;
  const m: Names = new Map(
    (await listAll(c.env, dir)).map((e) => [e.name, e.type]),
  );
  c.names.set(dir, m);
  return m;
}

async function moveInto(
  c: Ctx,
  src: string,
  isDir: boolean,
  dstDir: string,
): Promise<string> {
  const names = await namesOf(c, dstDir);
  const name = baseName(src);
  const existing = names.get(name);

  if (isDir && existing === "dir") {
    // 合并：逐个搬进已有的同名目录，搬空后删掉源目录
    const into = joinPath(dstDir, name);
    for (const child of await listAll(c.env, src))
      await moveInto(c, joinPath(src, child.name), child.type === "dir", into);
    if ((await listAll(c.env, src)).length === 0) {
      const r = await removeEntry(loadToken(), c.env, src, true, null);
      if (!r.ok) throw new Abort(failText(r.kind));
    }
    return into;
  }

  const target = existing ? freeName(new Set(names.keys()), name, isDir) : name;
  if (target !== name) c.renamed++;
  const to = joinPath(dstDir, target);
  const r = await renameEntry(loadToken(), c.env, src, to, null);
  if (!r.ok)
    throw new Abort(
      r.kind === "conflict" ? `${target} 已存在` : failText(r.kind),
    );
  names.set(target, isDir ? "dir" : "file");
  return to;
}

/** 把条目依次移动到同主机的 dstDir；重名文件自动改名，同名目录合并；一项失败就停下，后面的不动 */
export async function moveEntries(
  env: string,
  entries: readonly DragEntry[],
  dstDir: string,
): Promise<MoveResult> {
  const c: Ctx = { env, names: new Map(), renamed: 0 };
  const moves: MoveResult["moves"] = [];
  try {
    for (const e of entries)
      moves.push({
        from: e.path,
        to: await moveInto(c, e.path, e.isDir, dstDir),
      });
  } catch (e) {
    if (e instanceof Abort)
      return { moves, renamed: c.renamed, error: e.message };
    throw e;
  }
  return { moves, renamed: c.renamed, error: null };
}
