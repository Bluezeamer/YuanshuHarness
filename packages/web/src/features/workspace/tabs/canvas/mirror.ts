// 没保存的改动镜像到浏览器本地存储：刷新页面或误关标签后，同一个浏览器里重新打开这块画布还能恢复。
// 没保存的改动本来只在页面内存里（Server 不持有）；这是同一个浏览器内的一道保险，不走网络。
// 每块画布一个键；没有未保存的改动就删键。
import type { CanvasDocJson } from "../../../../api/canvas";
import {
  localKey,
  readLocal,
  removeLocal,
  writeLocal,
} from "../../../../app/localState";

export interface UnsavedCard {
  text: string;
  base: { mtimeMs: number | null; sha256: string | null };
}

export interface Unsaved {
  /** 镜像时服务端那一版文档与它的 sha：恢复时判断磁盘上有没有变过，变了就以它为底三方合并 */
  base: CanvasDocJson;
  baseSha: string;
  /** 用户这边的文档（含新卡片的占位节点）；没改过布局为 null */
  doc: CanvasDocJson | null;
  /** 改过还没保存的卡片正文（含新卡片，键是占位名） */
  edits: Record<string, string>;
  /** 这些卡片开始编辑时服务端的那一版：保存时靠它判断被别处改过没有 */
  known: Record<string, UnsavedCard>;
}

const NS = "canvas.unsaved";
// 太大的不镜像（配额有限，写一次还要序列化整份）
const MAX_CHARS = 2_000_000;

const keyOf = (env: string, dir: string, board: string): string =>
  localKey(NS, env, dir, board);

const parse = (v: unknown): Unsaved | null => {
  const u = v as Partial<Unsaved> | null;
  return u?.base && typeof u.baseSha === "string" && u.edits && u.known
    ? (u as Unsaved)
    : null;
};

export const readUnsaved = (
  env: string,
  dir: string,
  board: string,
): Unsaved | null => readLocal(keyOf(env, dir, board), parse);

export const writeUnsaved = (
  env: string,
  dir: string,
  board: string,
  v: Unsaved,
): void => writeLocal(keyOf(env, dir, board), v, MAX_CHARS);

export const clearUnsaved = (env: string, dir: string, board: string): void =>
  removeLocal(keyOf(env, dir, board));
