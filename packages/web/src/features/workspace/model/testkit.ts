// 模型层单测共用的小工具（只被 *.test.ts 引用）。

import { type Ctx, idGenFrom } from "./l2";
import type { FailCode, Result } from "./types";

/** 取出成功值，失败则让测试直接报错并带上原因 */
export function val<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.code} ${r.error}`);
  return r.value;
}

/** 断言失败并返回失败详情 */
export function bad<T>(
  r: Result<T>,
  code: FailCode,
): { error: string; hosts?: [string, string] } {
  if (r.ok) throw new Error(`期望失败 ${code}，实际成功`);
  if (r.code !== code)
    throw new Error(`期望 ${code}，实际 ${r.code}：${r.error}`);
  return r.hosts ? { error: r.error, hosts: r.hosts } : { error: r.error };
}

export const mkCtx = (sid = "s1", used: Iterable<string> = []): Ctx => ({
  sid,
  ids: idGenFrom(used),
});

/** 按 1000x700 的盒子取指针位置 */
export const at = (x: number, y: number, width = 1000, height = 700) => ({
  x,
  y,
  width,
  height,
});
