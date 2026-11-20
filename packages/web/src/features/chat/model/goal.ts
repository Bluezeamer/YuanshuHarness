// 目标的展示文案：状态与原因（右栏）、对话流里的卡片共用，同一个原因只在这里说一次。

import type { Goal, GoalReason } from "../../../api";

export const GOAL_STATE_TEXT: Record<Goal["state"], string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  complete: "已完成",
};

const REASON_TEXT: Record<GoalReason["code"], string> = {
  "user-paused": "你暂停了目标",
  "user-stopped": "你停止了运行",
  "request-failed": "模型请求出错",
  "server-restart": "服务重启过",
  "no-tool-calls": "连续 3 轮没有调用工具",
  "round-limit": "轮数用完",
  "model-blocked": "模型报告受阻",
};

export const reasonText = (r: GoalReason): string => REASON_TEXT[r.code];

/** 「12 / 50」，不限时只写「12」 */
export const roundsText = (rounds: number, max: number | null): string =>
  max === null ? String(rounds) : `${rounds} / ${max}`;

/** 与服务端 goalMaxRounds 的取值范围一致 */
export const GOAL_ROUNDS_MAX = 10000;

/** 轮数上限输入：空 = 不限（null），1–10000 的整数 = 数字，其余 undefined（不合法） */
export function parseRoundsInput(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= GOAL_ROUNDS_MAX ? n : undefined;
}
