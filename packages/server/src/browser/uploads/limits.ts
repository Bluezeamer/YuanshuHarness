// 交给浏览器一次能接收的内容合计上限：agent 上传与用户页上传共用一份定义。
import { formatSize } from "../../session/attachments.js";

/** 浏览器一次能接收的内容合计上限：Playwright 的界限是 `>= 50 MB` 就拒。 */
export const UPLOAD_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** 所有文件合计不能超过浏览器一次能接收的量；写明数字，让模型知道怎么调整。 */
export function checkUploadTotal(sources: { size: number }[]): void {
  const total = sources.reduce((sum, s) => sum + s.size, 0);
  if (total >= UPLOAD_MAX_TOTAL_BYTES)
    throw new Error(
      `这些文件合计 ${formatSize(total)}，超过浏览器一次能接收的 50 MB：少传几个，或先压缩`,
    );
}
