import type { AttachmentRef } from "../session/attachments.js";
import type { Db } from "./db.js";

// 长期目标：harness 在 agent 空闲时自动注入一条目标消息继续驱动，直到模型宣布完成或受阻。
export type GoalState = "active" | "paused" | "blocked" | "complete";

export type GoalReasonCode =
  // paused
  | "user-paused"
  | "user-stopped"
  | "request-failed"
  | "server-restart"
  // blocked
  | "no-tool-calls"
  | "round-limit"
  | "model-blocked";

/** 暂停与受阻的原因；detail 是出错信息或模型写的阻塞说明。 */
export interface GoalReason {
  code: GoalReasonCode;
  detail?: string;
}

export interface Goal {
  /** uuidv7；每次新建换一个。 */
  id: string;
  /** 从 1 起，每次修改（文本、状态、上限、原因、轮数）+1。 */
  revision: number;
  /** 目标原文；长度上限见 session/goal.ts 的 GOAL_MAX。 */
  text: string;
  by: "user" | "model";
  state: GoalState;
  /** 仅 paused / blocked 时带。 */
  reason?: GoalReason;
  /** 本次启动的轮数上限；null = 不限。 */
  maxRounds: number | null;
  /** 本次启动已注入的目标轮数；继续时归零。 */
  rounds: number;
  /** 立目标时用户给的附件；缺省 = 没有。 */
  attachments?: AttachmentRef[];
  since: string;
  updatedAt: string;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// 最近一次压缩：savedPct 是占用降低的百分比（0–100，未知时为 0）。
export interface CompactState {
  summary: string;
  at: string;
  savedPct: number;
}

export interface SessionState {
  goal: Goal | null;
  todo: Todo[];
  compact: CompactState | null;
}

export const emptyState = (): SessionState => ({
  goal: null,
  todo: [],
  compact: null,
});

type Row = { goal: string | null; todo: string | null; compact: string | null };

const parse = <T>(v: string | null, fallback: T): T => {
  if (v === null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export class SessionStateStore {
  constructor(private readonly db: Db) {}

  get(sessionId: string): SessionState {
    const r = this.db
      .prepare(
        "SELECT goal, todo, compact FROM session_state WHERE session_id = ?",
      )
      .get(sessionId) as Row | undefined;
    if (!r) return emptyState();
    return {
      goal: parse<Goal | null>(r.goal, null),
      todo: parse<Todo[]>(r.todo, []),
      compact: parse<CompactState | null>(r.compact, null),
    };
  }

  save(sessionId: string, s: SessionState): void {
    this.db
      .prepare(
        `INSERT INTO session_state (session_id, goal, todo, compact, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           goal = excluded.goal, todo = excluded.todo,
           compact = excluded.compact, updated_at = excluded.updated_at`,
      )
      .run(
        sessionId,
        s.goal ? JSON.stringify(s.goal) : null,
        JSON.stringify(s.todo),
        s.compact ? JSON.stringify(s.compact) : null,
        new Date().toISOString(),
      );
  }

  remove(sessionId: string): void {
    this.db
      .prepare("DELETE FROM session_state WHERE session_id = ?")
      .run(sessionId);
  }
}
