// 编辑基线（mtime + 全文 sha256）：文件接口与画布接口共用同一套口径，别各自算一份。
import { createHash } from "node:crypto";
import type { ExecEnv } from "../../env/types.js";

/** 文本预览（无 Range、非下载）最多返回的字节数；同时也是「算不算全文 sha256」的上限。 */
export const TEXT_PREVIEW_MAX = 16 * 1024 * 1024;

// 编辑基线的 mtime 统一取整毫秒：本机是浮点、ssh 是秒 * 1000，取整后两边都可原样回传比较。
export const mtimeOf = (st: { mtimeMs: number }): number =>
  Math.round(st.mtimeMs);

export const sha256Of = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** 冲突校验用的全文 sha256；超过上限的文件不算（契约：超上限只用 mtime 比对）。 */
export async function fileSha256(
  env: ExecEnv,
  p: string,
  size: number,
): Promise<string | null> {
  if (size > TEXT_PREVIEW_MAX) return null;
  return sha256Of(await env.readFile(p));
}

/** 查询参数里的编辑基线：缺失或格式不对都当作没带。 */
export function intParam(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  return Number(v);
}

export const shaParam = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
