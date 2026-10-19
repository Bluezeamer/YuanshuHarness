// 跨环境文件传输：流式复制单个文件或整个目录树（经 Server 中转，不落盘）。
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

export class TransferError extends Error {
  constructor(
    readonly code: "src_missing" | "conflict" | "bad_request" | "copy_failed",
    message: string,
  ) {
    super(message);
  }
}

export const TRANSFER_MAX_ENTRIES = 20000;
const CONFLICT_SHOW = 5;

interface Item {
  from: string;
  to: string;
}

/**
 * src 是文件：dst 若是已存在目录则放进去（保留文件名），否则 dst 即目标文件路径。
 * src 是目录：dst 即目标目录，已存在则合并。
 * 默认不覆盖：先整体扫描，有冲突就一个文件都不写。复制中途失败时已写的文件会留下。
 */
export async function transfer(
  src: TransferEnd,
  dst: TransferEnd,
  opts: { overwrite?: boolean; signal?: AbortSignal } = {},
): Promise<TransferResult> {
  const sp = pathOf(src.env);
  const dp = pathOf(dst.env);
  const st = await src.env.stat(src.path);
  if (!st) throw new TransferError("src_missing", `源不存在：${src.path}`);

  const items: Item[] = [];
  const dirs = new Set<string>();
  let skippedLinks = 0;

  if (st.isFile) {
    const dstStat = await dst.env.stat(dst.path);
    const to = dstStat?.isDirectory
      ? dp.join(dst.path, sp.basename(src.path))
      : dst.path;
    items.push({ from: src.path, to });
    dirs.add(dp.dirname(to));
  } else if (st.isDirectory) {
    const dstStat = await dst.env.stat(dst.path);
    if (dstStat && !dstStat.isDirectory)
      throw new TransferError("conflict", `目标已存在且不是目录：${dst.path}`);
    dirs.add(dst.path);
    const walk = async (from: string, to: string): Promise<void> => {
      for (const e of await src.env.readdir(from)) {
        if (e.isSymlink) {
          skippedLinks++;
          continue;
        }
        const f = sp.join(from, e.name);
        const t = dp.join(to, e.name);
        if (e.isDirectory) {
          dirs.add(t);
          await walk(f, t);
        } else items.push({ from: f, to: t });
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

  if (!opts.overwrite) {
    const clash: string[] = [];
    for (const it of items)
      if ((await dst.env.lstat(it.to)) !== null) clash.push(it.to);
    if (clash.length > 0)
      throw new TransferError(
        "conflict",
        `目标已存在 ${clash.length} 个文件：${clash.slice(0, CONFLICT_SHOW).join("、")}${clash.length > CONFLICT_SHOW ? " 等" : ""}`,
      );
  }

  for (const d of dirs) await dst.env.mkdirp(d);

  let bytes = 0;
  const count = async function* (chunks: AsyncIterable<Buffer>) {
    for await (const c of chunks) {
      bytes += c.length;
      yield c;
    }
  };
  for (const it of items) {
    try {
      await pipeline(
        await src.env.readStream(it.from),
        count,
        await dst.env.writeStream(it.to),
        opts.signal ? { signal: opts.signal } : {},
      );
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new TransferError(
        "copy_failed",
        `复制失败：${it.from} → ${it.to}（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
  }
  return { files: items.length, bytes, skippedLinks };
}
