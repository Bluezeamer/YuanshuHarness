import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  type CompactState,
  emptyState,
  type Goal,
  type GoalReason,
  type SessionState,
  type SessionStateStore,
  type Todo,
} from "../store/session-state.js";
import type { AttachmentRef } from "./attachments.js";
import { cut } from "./events.js";
import {
  advance,
  block,
  complete,
  createGoal,
  editGoal,
  GoalError,
  pause,
  resume,
} from "./goal.js";

export const TODO_MAX = 50;
export const TODO_CONTENT_MAX = 500;
// 压缩摘要由 SDK 生成，可能很长；落库与快照里只留前面一段，完整内容仍在会话 JSONL 里。
export const SUMMARY_MAX = 16_000;

const TODO_STATUS = new Set<Todo["status"]>([
  "pending",
  "in_progress",
  "completed",
]);

// 压缩前后占用的降幅百分比；SDK 没给出压缩后占用时记 0。
export function savedPct(before: number, after: number | undefined): number {
  if (after === undefined || before <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - after / before) * 100)));
}

// 目标与任务清单的非法请求；api 层把它翻成 ack 的 { code, message }。
export class StateError extends Error {
  constructor(
    readonly code: "bad_request" | "no_goal" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const asStateError = (err: unknown): never => {
  if (err instanceof GoalError) throw new StateError(err.code, err.message);
  throw err;
};

// 目标 / 计划 / 压缩状态的内存副本；每次变更先落库再广播，事件与快照说同一份数据。
// 目标方法都是薄封装：转移交给 session/goal.ts 的纯函数，这里只管保存与广播。
export class SessionStateHolder {
  private s: SessionState;

  constructor(
    private readonly id: string,
    private readonly store: SessionStateStore | undefined,
    private readonly emit: (
      type: string,
      data: Record<string, unknown>,
    ) => void,
  ) {
    this.s = store?.get(id) ?? emptyState();
  }

  get goal(): Goal | null {
    return this.s.goal;
  }

  // GET /state 的形状；snapshot 里按 goal / todos / compact 展开。
  view(): SessionState {
    return { goal: this.s.goal, todo: this.s.todo, compact: this.s.compact };
  }

  private save(): void {
    this.store?.save(this.id, this.s);
  }

  private goalChanged(): void {
    this.save();
    this.emit("goal.updated", { goal: this.s.goal });
  }

  // 换一份目标并落库广播；转移已由纯函数做完。
  private setGoal(g: Goal): void {
    this.s.goal = g;
    this.goalChanged();
  }

  /** 清掉目标；原本就没有时什么都不做。 */
  clearGoal(): void {
    if (!this.s.goal) return;
    this.s.goal = null;
    this.goalChanged();
  }

  createGoal(
    text: string,
    by: Goal["by"],
    maxRounds: number | null,
    id: string,
    now: string,
    attachments?: AttachmentRef[],
  ): Goal {
    return this.transition(() =>
      createGoal(text, by, maxRounds, id, now, attachments),
    );
  }

  editGoal(
    patch: {
      text?: string;
      maxRounds?: number | null;
      attachments?: AttachmentRef[];
    },
    by: Goal["by"],
    now: string,
  ): Goal {
    const g = this.existing();
    return this.transition(() => editGoal(g, patch, by, now));
  }

  // 返回 null 表示状态没变（已不在 active），不落库也不广播。
  pause(reason: GoalReason, now: string): Goal | null {
    const g = this.existing();
    return this.transition(() => pause(g, reason, now));
  }

  resume(now: string): Goal {
    const g = this.existing();
    return this.transition(() => resume(g, now));
  }

  block(reason: GoalReason, now: string): Goal {
    const g = this.existing();
    return this.transition(() => block(g, reason, now));
  }

  complete(now: string): Goal {
    const g = this.existing();
    return this.transition(() => complete(g, now));
  }

  /** 续跑记一轮；返回新目标，非 active 时抛错。 */
  advanceRound(now: string): Goal {
    const g = this.existing();
    return this.transition(() => advance(g, now));
  }

  // 转移与「不为 null 才落库」只写在这一处，纯函数的报错统一翻成 StateError。
  private transition<T extends Goal | null>(fn: () => T): T {
    let next: T;
    try {
      next = fn();
    } catch (err) {
      return asStateError(err);
    }
    if (next !== null) this.setGoal(next);
    return next;
  }

  private existing(): Goal {
    if (!this.s.goal) throw new StateError("no_goal", "当前没有长期目标");
    return this.s.goal;
  }

  // 整份替换；无效项（模型给的参数）直接抛错，让模型看到原因并重试。
  setTodos(raw: unknown): void {
    if (!Array.isArray(raw) || raw.length > TODO_MAX)
      throw new StateError(
        "bad_request",
        `todos 必须是不超过 ${TODO_MAX} 项的数组`,
      );
    this.s.todo = raw.map((r) => {
      const t = r as { content?: unknown; status?: unknown };
      if (
        typeof t?.content !== "string" ||
        t.content.trim() === "" ||
        !TODO_STATUS.has(t.status as Todo["status"])
      )
        throw new StateError(
          "bad_request",
          "每项需要非空的 content 和 status（pending / in_progress / completed）",
        );
      return {
        content: cut(t.content.trim(), TODO_CONTENT_MAX),
        status: t.status as Todo["status"],
      };
    });
    this.save();
    this.emit("plan.updated", { todos: this.s.todo });
  }

  setCompact(summary: string, savedPct: number): void {
    this.s.compact = {
      summary: cut(summary, SUMMARY_MAX),
      at: new Date().toISOString(),
      savedPct,
    } satisfies CompactState;
    this.save();
    this.emit("context.compacted", {
      summary: this.s.compact.summary,
      savedPct,
    });
  }
}

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
});

// 模型维护任务清单的工具：每次调用整份替换；状态条的进度据此显示。
export function todoWriteExtension(
  write: (todos: unknown) => void,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "todo_write",
      label: "更新任务清单",
      description:
        "维护本次工作的任务清单（整份替换）。多步骤任务开始前列出步骤，推进时更新状态；同一时刻只让一项处于 in_progress。",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            maxItems: TODO_MAX,
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  minLength: 1,
                  maxLength: TODO_CONTENT_MAX,
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      } as never,
      async execute(_id, params) {
        const { todos } = params as { todos: unknown };
        write(todos);
        const list = todos as Todo[];
        const done = list.filter((t) => t.status === "completed").length;
        return text(`任务清单已更新：${list.length} 项，${done} 项已完成`);
      },
    });
  };
}
