// 执行体的展示用纯函数：状态文案、已运行时长、上下文读条文字。

import type { ExecutionBody } from "../../../api/flows";
import { fmtDuration, fmtTokens } from "../model/metrics";

export type ExecTone = "run" | "idle" | "done" | "failed";

export function execStatus(x: ExecutionBody): {
  tone: ExecTone;
  label: string;
} {
  if (x.state === "run") return { tone: "run", label: "运行中" };
  if (x.state === "idle") return { tone: "idle", label: "未激活" };
  if (x.outcome === "failed") return { tone: "failed", label: "失败" };
  if (x.outcome === "interrupted") return { tone: "done", label: "已中断" };
  return { tone: "done", label: "已结束" };
}

/** 已运行时长；服务端不给结束时间，所以已结束的没有 */
export function execElapsed(x: ExecutionBody, now: number): string | null {
  if (x.state === "done") return null;
  const t = Date.parse(x.since);
  if (!Number.isFinite(t)) return null;
  return fmtDuration(Math.max(0, now - t));
}

/** `38k / 200k`；窗口未知时只写已用 */
export const execCtxText = (x: ExecutionBody): string =>
  x.ctx.win
    ? `${fmtTokens(x.ctx.used)} / ${fmtTokens(x.ctx.win)}`
    : fmtTokens(x.ctx.used);
