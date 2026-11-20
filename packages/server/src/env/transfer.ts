// 跨环境文件传输：流式复制单个文件或整个目录树（经 Server 中转，不落盘）。
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { pathOf } from "../permission/paths.js";
import type { ExecEnv } from "./types.js";

export interface TransferEnd {
  env: ExecEnv;
  path: string;
}

export interface TransferResult {
  files: number;
  bytes: number;
  /** 符号链接不跟随也不复制，只计数。 */
  skippedLinks: number;
}

/** 扫描完成后才有总量；totalBytes 仅在源是单个文件时已知。 */
export interface TransferProgress {
  totalFiles: number;
  totalBytes: number | null;
  files: number;
  bytes: number;
}

export class TransferError extends Error {
  constructor(
    readonly code: "src_missing" | "conflict" | "bad_request" | "copy_failed",
    message: string,
    /** copy_failed 时已完整写入目标的文件路径（不回滚）。 */
    readonly completed: string[] = [],
  ) {
    super(message);
  }
}

export const TRANSFER_MAX_ENTRIES = 20000;
const CONFLICT_SHOW = 5;

interface Item {
  from: string;
  to: string;
  /** 源文件的 st_mode；落地时只取 rwx 九位，不带 setuid/setgid/sticky。 */
  mode: number;
}

// 目录至少保留属主 rwx：源目录是 0500 时，仍要先建出来才能写进去。
const dirMode = (mode: number) => (mode & 0o777) | 0o700;

/**
 * src 是文件：dst 若是已存在目录则放进去（保留文件名），否则 dst 即目标文件路径。
 * src 是目录：dst 即目标目录，已存在则合并。
 * 源与目标根、最终文件是符号链接一律拒绝（不跟随）；权限位随源（文件与新建目录）。
 * 默认不覆盖：先整体扫描，有冲突就一个文件都不写，写入时再排他创建防并发。
 * 覆盖：先写同目录临时文件再 rename，失败时旧文件原样。
 * 复制中途失败不回滚，已写的文件留下，并在错误里列出。
 */
export async function transfer(
  src: TransferEnd,
  dst: TransferEnd,
  opts: {
    overwrite?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: TransferProgress) => void;
  } = {},
): Promise<TransferResult> {
  const sp = pathOf(src.env);
  const dp = pathOf(dst.env);
  // lstat：顶层源与目标根不跟随链接，否则会读/写到链接指向的别处
  const st = await src.env.lstat(src.path);
  if (!st) throw new TransferError("src_missing", `源不存在：${src.path}`);
  if (st.isSymlink)
    throw new TransferError("bad_request", `源是符号链接，不复制：${src.path}`);
  const dstStat = await dst.env.lstat(dst.path);
  if (dstStat?.isSymlink)
    throw new TransferError(
      "conflict",
      `目标是符号链接，拒绝写入：${dst.path}`,
    );

  const items: Item[] = [];
  // 目标目录 → 源目录的 mode（无对应源目录时为 undefined）；插入序保证父先于子
  const dirs = new Map<string, number | undefined>();
  let skippedLinks = 0;

  if (st.isFile) {
    const to = dstStat?.isDirectory
      ? dp.join(dst.path, sp.basename(src.path))
      : dst.path;
    items.push({ from: src.path, to, mode: st.mode });
    dirs.set(dp.dirname(to), undefined);
  } else if (st.isDirectory) {
    if (dstStat && !dstStat.isDirectory)
      throw new TransferError("conflict", `目标已存在且不是目录：${dst.path}`);
    dirs.set(dst.path, st.mode);
    const walk = async (from: string, to: string): Promise<void> => {
      for (const e of await src.env.readdir(from)) {
        if (e.isSymlink) {
          skippedLinks++;
          continue;
        }
        const f = sp.join(from, e.name);
        const t = dp.join(to, e.name);
        const es = await src.env.lstat(f);
        if (!es || es.isSymlink) {
          skippedLinks++; // 列目录后被换掉：按链接处理，不跟随
          continue;
        }
        if (e.isDirectory) {
          dirs.set(t, es.mode);
          await walk(f, t);
        } else items.push({ from: f, to: t, mode: es.mode });
        if (items.length + dirs.size > TRANSFER_MAX_ENTRIES)
          throw new TransferError(
            "bad_request",
            `条目超过 ${TRANSFER_MAX_ENTRIES}，请拆分后传输`,
          );
      }
    };
    await walk(src.path, dst.path);
  } else {
    throw new TransferError("bad_request", `不支持的源类型：${src.path}`);
  }

  const clash: string[] = [];
  for (const it of items) {
    const ex = await dst.env.lstat(it.to);
    if (ex?.isSymlink)
      throw new TransferError("conflict", `目标是符号链接，拒绝写入：${it.to}`);
    if (ex && !opts.overwrite) clash.push(it.to);
  }
  if (clash.length > 0)
    throw new TransferError(
      "conflict",
      `目标已存在 ${clash.length} 个文件：${clash.slice(0, CONFLICT_SHOW).join("、")}${clash.length > CONFLICT_SHOW ? " 等" : ""}`,
    );

  for (const [d, mode] of dirs)
    await dst.env.mkdirp(d, mode === undefined ? undefined : dirMode(mode));

  let bytes = 0;
  const completed: string[] = [];
  const emit = () =>
    opts.onProgress?.({
      totalFiles: items.length,
      totalBytes: st.isFile ? st.size : null,
      files: completed.length,
      bytes,
    });
  const count = async function* (chunks: AsyncIterable<Buffer>) {
    for await (const c of chunks) {
      bytes += c.length;
      emit();
      yield c;
    }
  };

  // 不覆盖：对最终路径排他创建；覆盖：写同目录临时文件再 rename，失败不动旧文件。
  const copyOne = async (it: Item): Promise<void> => {
    const target = opts.overwrite ? tempSibling(dp, it.to) : it.to;
    const out = await dst.env.writeStream(target, {
      mode: it.mode & 0o777,
      exclusive: true,
    });
    let ok = false;
    try {
      await pipeline(
        await src.env.readStream(it.from),
        count,
        out,
        opts.signal ? { signal: opts.signal } : {},
      );
      // sftp 写流在 finish 时句柄可能尚未关闭，等 close 再改名
      if (!out.closed) await once(out, "close");
      if (opts.overwrite) await dst.env.rename(target, it.to);
      ok = true;
    } finally {
      if (!ok) {
        // writeStream 已成功返回，说明 target 是本次排他创建的，可以放心删
        out.destroy();
        await dst.env.remove(target).catch(() => {});
      }
    }
  };

  emit();
  for (const it of items) {
    try {
      await copyOne(it);
      completed.push(it.to);
      emit();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const n = completed.length;
      const shown = completed.slice(0, CONFLICT_SHOW).join("、");
      throw new TransferError(
        "copy_failed",
        `复制失败：${it.from} → ${it.to}（${err instanceof Error ? err.message : String(err)}）。已完成 ${n} 个文件，未回滚${n > 0 ? `：${shown}${n > CONFLICT_SHOW ? " 等" : ""}` : ""}`,
        completed,
      );
    }
  }
  return { files: items.length, bytes, skippedLinks };
}

// 与 files.ts 上传的临时名同形：隐藏、带随机后缀，便于识别残留。
const tempSibling = (pm: ReturnType<typeof pathOf>, p: string) =>
  pm.join(
    pm.dirname(p),
    `.${pm.basename(p)}.${randomBytes(4).toString("hex")}.part`,
  );
