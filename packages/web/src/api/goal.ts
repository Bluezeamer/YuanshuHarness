// 目标（goal.md）：会话状态里的目标与对话流里的目标卡片
import type { MessageAttachment } from "./sessions";

export type GoalState = "active" | "paused" | "blocked" | "complete";

export type GoalReasonCode =
  | "user-paused"
  | "user-stopped"
  | "request-failed"
  | "server-restart"
  | "no-tool-calls"
  | "round-limit"
  | "model-blocked";

export interface GoalReason {
  code: GoalReasonCode;
  /** 出错信息或模型写的阻塞说明 */
  detail?: string;
}

/** 会话的目标；时间是服务端给的 ISO 串。 */
export interface Goal {
  id: string;
  revision: number;
  text: string;
  /** 用户设目标时附的文件（在会话附件区）；没有则缺省 */
  attachments?: MessageAttachment[];
  by: "user" | "model";
  state: GoalState;
  reason?: GoalReason;
  /** null = 不限 */
  maxRounds: number | null;
  /** 本次启动已用轮数；点「继续」归零 */
  rounds: number;
  since: string;
  updatedAt: string;
}

export type GoalEvent =
  | "round"
  | "set"
  | "edited"
  | "paused"
  | "resumed"
  | "cleared"
  | "complete"
  | "blocked";

/** 对话流里的一张目标卡片：目标每变一次、每续一轮出一张。 */
export interface GoalNotice {
  event: GoalEvent;
  goalId: string;
  /** 目标改动后的版本号：与 goalId、event 一起认出「同一张卡」 */
  revision: number;
  by?: "user" | "model";
  round?: number;
  maxRounds?: number | null;
  text?: string;
  /** 附件名：set 带全部，edited 只在附件被改时带（空数组 = 改成没有） */
  files?: string[];
  reason?: GoalReason;
}

/** 实时到达的与历史里读到的卡片靠它认出是同一张。 */
export const goalNoticeKey = (n: GoalNotice): string =>
  `goal:${n.goalId}:${n.event}:${n.revision}`;
