// 文件编辑草稿的本地暂存：编辑到一半切走标签、关掉标签、刷新都不丢。键是（主机，路径），不是标签 id。
// 连同「开始编辑时的磁盘基线」一起存：恢复后磁盘变过，保存时走现有的冲突合并。
// 草稿只在输入它的那个浏览器里有。读写走 app/localState。
import type { SaveBase } from "../../../../api/files";
import {
  localKey,
  localPrefix,
  readLocal,
  removeLocal,
  sweepLocal,
  writeLocalSoon,
} from "../../../../app/localState";

export interface FileDraft {
  text: string;
  /** 开始编辑时磁盘上的那一版 */
  base: SaveBase;
  savedAt: number;
}

const NS = "file.draft";

const keyOf = (env: string, path: string) => localKey(NS, env, path);

const stamp = (v: unknown): v is number | null =>
  v === null || typeof v === "number";

const parse = (v: unknown): FileDraft | null => {
  const d = v as Partial<FileDraft> | null;
  const b = d?.base as Partial<SaveBase> | undefined;
  return typeof d?.text === "string" &&
    typeof d.savedAt === "number" &&
    b !== undefined &&
    stamp(b.mtimeMs) &&
    (b.sha256 === null || typeof b.sha256 === "string")
    ? (d as FileDraft)
    : null;
};

/**
 * 常见的密钥 / 环境文件不落本地：只是顺手排除几个名字，不是安全功能，也不保证覆盖。
 * 想要真正的保护，别在浏览器里编辑这类文件。
 */
const SENSITIVE =
  /(^|\/)(\.env[^/]*|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|key|p12|pfx))$|(^|\/)\.ssh\//;

export const isSensitivePath = (path: string): boolean => SENSITIVE.test(path);

/** 暂存当前编辑内容（防抖）。 */
export function stashFileDraft(
  env: string,
  path: string,
  text: string,
  base: SaveBase,
): void {
  if (isSensitivePath(path)) return;
  writeLocalSoon(keyOf(env, path), {
    text,
    base,
    savedAt: Date.now(),
  } satisfies FileDraft);
}

/** 取这个文件上次没保存的草稿；和磁盘内容一样的没有意义，顺手删掉。 */
export function loadFileDraft(
  env: string,
  path: string,
  diskText: string,
): FileDraft | null {
  const d = readLocal(keyOf(env, path), parse);
  if (d === null) return null;
  if (d.text === diskText) {
    dropFileDraft(env, path);
    return null;
  }
  return d;
}

export const dropFileDraft = (env: string, path: string): void =>
  removeLocal(keyOf(env, path));

const MAX_AGE_MS = 30 * 24 * 3600_000;

/** 启动时清掉超过 30 天没动过的草稿（和坏记录） */
export const sweepStaleFileDrafts = (now = Date.now()): void =>
  sweepLocal(localPrefix(NS), (_key, v) => {
    const d = parse(v);
    return d === null || now - d.savedAt > MAX_AGE_MS;
  });
