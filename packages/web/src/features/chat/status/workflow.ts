// 右侧状态里的工作流块（纯函数）：只画阶段与计数，没有总数也没有进度条（引擎事前数不出总数）。

import type { WorkflowPhase, WorkflowRun } from "../../../api/flows";
import { agoText, FOLD_MIN } from "./subTree";

/** 在跑的运行，加上结束不满 FOLD_MIN 分钟的；更早的不再占右栏（历史在对话流的工具行里） */
export function visibleRuns(
  runs: readonly WorkflowRun[],
  now: number,
): WorkflowRun[] {
  return runs.filter((r) => {
    if (r.state === "run") return true;
    const t = r.ended ? Date.parse(r.ended) : Number.NaN;
    return !Number.isFinite(t) || now - t < FOLD_MIN * 60_000;
  });
}

/** 这一阶段还有 agent 在跑或在排队 */
export const phaseLive = (p: WorkflowPhase): boolean =>
  p.run > 0 || p.queued > 0;

/** 「已完成 3」「运行中 1」「排队 2」，为 0 的不写；失败另算，界面里用红字单独写 */
export function phaseCounts(p: WorkflowPhase): string[] {
  const parts: string[] = [];
  if (p.done > 0) parts.push(`已完成 ${p.done}`);
  if (p.run > 0) parts.push(`运行中 ${p.run}`);
  if (p.queued > 0) parts.push(`排队 ${p.queued}`);
  return parts;
}

const ENDED = {
  ok: "",
  failed: "失败 · ",
  stopped: "已停止 · ",
  interrupted: "已中断 · ",
};

/** 运行头右边的字：在跑不写；结束了写「3 分钟前」，不成功的前面带结局 */
export function runEndText(r: WorkflowRun, now: number): string {
  if (r.state === "run") return "";
  const t = r.ended ? Date.parse(r.ended) : Number.NaN;
  return `${ENDED[r.state]}${Number.isFinite(t) ? agoText(now - t) : ""}`.replace(
    / · $/,
    "",
  );
}
