// 目标（goal）的纯逻辑：状态转移与 notice 形状。无 I/O、不读时钟——id 与时间由调用方传入。

import type { Goal, GoalReason } from "../store/session-state.js";
import type { AttachmentRef } from "./attachments.js";

export const GOAL_MAX = 4000;
/** 本次启动的轮数上限缺省值；设置里可以改成不限。 */
export const GOAL_ROUND_LIMIT_DEFAULT = 50;
/** 连续这么多轮没有任何工具调用就判定受阻。 */
export const GOAL_IDLE_ROUNDS = 3;
/** 模型宣布受阻前必须已经跑过的目标轮数。 */
export const GOAL_BLOCK_MIN_ROUNDS = 3;
/** 原因里的 detail 与目标文本一样有界。 */
export const GOAL_DETAIL_MAX = 500;

/** 对话流里的一张目标卡片；实时事件与历史接口共用。 */
export interface GoalNotice {
  event:
    | "round"
    | "set"
    | "edited"
    | "paused"
    | "resumed"
    | "cleared"
    | "complete"
    | "blocked";
  goalId: string;
  /** 变更后的版本号：界面靠它把同一张卡片去重（实时与历史两条路径对得上）。 */
  revision: number;
  /** set / edited：谁做的。 */
  by?: "user" | "model";
  /** round：第几轮。 */
  round?: number;
  /** round 总是带；edited 里仅在上限被改时带（null = 改成不限）。 */
  maxRounds?: number | null;
  /** set / edited：目标原文（edited 仅在文本被改时带）。 */
  text?: string;
  /** set / edited：附件名；（edited 仅在附件被改时带，空数组 = 改成没有）。 */
  files?: string[];
  /** paused / blocked：原因。 */
  reason?: GoalReason;
}

export class GoalError extends Error {
  constructor(
    readonly code: "conflict" | "bad_request",
    message: string,
  ) {
    super(message);
  }
}

const trimText = (raw: string): string => {
  const t = raw.trim();
  if (t === "") throw new GoalError("bad_request", "目标文本不能为空");
  if (t.length > GOAL_MAX)
    throw new GoalError("bad_request", `目标文本不能超过 ${GOAL_MAX} 个字符`);
  return t;
};

const cutDetail = (d: string): string =>
  d.length <= GOAL_DETAIL_MAX ? d : d.slice(0, GOAL_DETAIL_MAX);

const boundedReason = (reason: GoalReason): GoalReason => ({
  code: reason.code,
  ...(reason.detail === undefined ? {} : { detail: cutDetail(reason.detail) }),
});

const bump = (g: Goal, patch: Partial<Goal>, now: string): Goal => ({
  ...g,
  ...patch,
  revision: g.revision + 1,
  updatedAt: now,
});

export function createGoal(
  text: string,
  by: Goal["by"],
  maxRounds: number | null,
  id: string,
  now: string,
  attachments?: AttachmentRef[],
): Goal {
  return {
    id,
    revision: 1,
    text: trimText(text),
    by,
    state: "active",
    maxRounds,
    rounds: 0,
    since: now,
    updatedAt: now,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

/** 模型改文本时轮数上限与附件都不能动；用户改文本会把目标归到自己名下。 */
export function editGoal(
  g: Goal,
  patch: {
    text?: string;
    maxRounds?: number | null;
    attachments?: AttachmentRef[];
  },
  by: Goal["by"],
  now: string,
): Goal {
  if (g.state === "complete")
    throw new GoalError("conflict", "已完成的目标不能修改");
  if (
    patch.text === undefined &&
    patch.maxRounds === undefined &&
    patch.attachments === undefined
  )
    throw new GoalError("bad_request", "至少要改一项：文本、轮数上限或附件");
  const next: Partial<Goal> = {};
  if (patch.text !== undefined) {
    const text = trimText(patch.text);
    next.text = text;
    // 用户一改文本，目标就归到用户名下（防模型再改回去）。
    if (by === "user" && text !== g.text) next.by = "user";
  }
  if (patch.maxRounds !== undefined) {
    if (by !== "user") throw new GoalError("conflict", "只有用户能改轮数上限");
    next.maxRounds = patch.maxRounds;
  }
  if (patch.attachments !== undefined) {
    if (by !== "user") throw new GoalError("conflict", "只有用户能改目标附件");
    // 给了就整体替换；空数组 = 改成没有（缺省就是没有），下面把字段删掉。
    next.attachments = patch.attachments;
  }
  const out = bump(g, next, now);
  if (next.attachments !== undefined && next.attachments.length === 0)
    delete out.attachments;
  return out;
}

/** active → paused；其余状态返回 null（不动，也不报错）。 */
export function pause(g: Goal, reason: GoalReason, now: string): Goal | null {
  if (g.state !== "active") return null;
  return bump(g, { state: "paused", reason: boundedReason(reason) }, now);
}

/** paused / blocked → active；轮数从零开始。 */
export function resume(g: Goal, now: string): Goal {
  if (g.state !== "paused" && g.state !== "blocked")
    throw new GoalError("conflict", `目标当前是 ${g.state}，不能继续`);
  const { reason: _r, ...rest } = g;
  return bump({ ...rest, state: "active" }, { rounds: 0 }, now);
}

/** active → blocked。 */
export function block(g: Goal, reason: GoalReason, now: string): Goal {
  if (g.state !== "active")
    throw new GoalError("conflict", `目标当前是 ${g.state}，不能置为受阻`);
  return bump(g, { state: "blocked", reason: boundedReason(reason) }, now);
}

/** active → complete。 */
export function complete(g: Goal, now: string): Goal {
  if (g.state !== "active")
    throw new GoalError("conflict", `目标当前是 ${g.state}，不能置为完成`);
  return bump(g, { state: "complete" }, now);
}

/** 续跑计一轮：只对 active 有效，落库与广播由调用方做。 */
export function advance(g: Goal, now: string): Goal {
  if (g.state !== "active")
    throw new GoalError("conflict", "只有进行中的目标才续跑");
  return bump(g, { rounds: g.rounds + 1 }, now);
}
