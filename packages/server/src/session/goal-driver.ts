// 目标续跑驱动：目标操作（用户侧与模型侧）、续跑判定、运行事件钩子、重启恢复的唯一入口。
import { uuidv7 } from "../id.js";
import type { Goal, GoalReason } from "../store/session-state.js";
import type { AttachmentRef } from "./attachments.js";
import {
  GOAL_BLOCK_MIN_ROUNDS,
  GOAL_IDLE_ROUNDS,
  GoalError,
  type GoalNotice,
} from "./goal.js";
import {
  BLOCK_NEEDS_REASON,
  blockTooEarly,
  CREATE_EXISTS,
  createdText,
  decidedText,
  EDIT_NEEDS_OBJECTIVE,
  editedText,
  goalText,
  NO_GOAL,
  OBJECTIVE_INVALID,
  OUTSIDE_GOAL_ROUND,
  roundMessage,
  STALE_GOAL,
  USER_GOAL_LOCKED,
  wrapUpMessage,
  wrongState,
} from "./goal-messages.js";
import { type SessionStateHolder, StateError } from "./session-state.js";
import type { ImageInput } from "./user-content.js";

/** 驱动需要的会话能力；池里由 SessionEntry 适配，测试用假的。 */
export interface GoalHost {
  /** 会话正在跑（含 send 已接受但 SDK 还没开始的窗口）。 */
  busy(): boolean;
  /** 有排队的用户消息，或有在跑的后台任务 / 子代理。 */
  hasPendingWork(): boolean;
  /** 注入一条目标消息并触发一轮（images 是待带图，收尾时由实现调 onSettled）。 */
  inject(text: string, notice: GoalNotice, images?: ImageInput[]): void;
  /** 只出卡片、不给模型看。 */
  note(notice: GoalNotice): void;
  /** 与 SessionEntry.stop 同。 */
  stop(): Promise<void>;
  /** 轮数上限的默认值（设置里现取）。 */
  defaultMaxRounds(): number | null;
}

/** 目标带来的附件内容：标记行已经合进 text，图片交给注入的第一轮。 */
export interface GoalContent {
  attachments: AttachmentRef[];
  images: ImageInput[];
}

/** 一次运行结束的结论（与 pool 的 RunOutcome 同形）。 */
export interface GoalOutcome {
  aborted: boolean;
  error?: string;
  text: string;
}

/** 模型工具的结果；isError 为真表示被拒，交给模型自己重试。 */
export interface GoalToolResult {
  text: string;
  isError?: boolean;
}

const failure = (text: string): GoalToolResult => ({ text, isError: true });

// 用户侧的错误信息给人看（中文），模型侧的统一在 goal-messages 里（英文）。
const CREATE_EXISTS_USER = "已有未完成的目标：要改用编辑，或先清除再新建";

const now = (): string => new Date().toISOString();

const reason = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// 模型看到的错误统一是英文：纯函数与状态持有者抛的中文信息只给用户。
const modelFailure = (err: unknown, g: Goal | null): GoalToolResult => {
  if (!(err instanceof StateError)) return failure(reason(err));
  return failure(
    err.code === "bad_request" ? OBJECTIVE_INVALID : wrongState(g?.state),
  );
};

export class GoalDriver {
  // 本次运行是不是「目标轮」（由 inject 开始）：只有这种轮次能宣布完成 / 受阻，也才计数。
  private goalRun = false;
  // 本次运行里刚创建的目标 id：创建它的那一轮同样允许宣布完成 / 受阻。
  private createdInRun: string | null = null;
  // 这一次运行里的工具调用次数：用来区分「有在做事的轮」。
  private toolCalls = 0;
  // 连续没有工具调用的目标轮数，只在内存里。
  private idleRounds = 0;
  // 新建 / 改了附件之后待带进下一轮的图片：取走即清空，重启后丢失（标记行还在）。
  private pendingImages: ImageInput[] = [];
  // 已经排了一拍检查：多个事件接连到达时只排一次。
  private scheduled = false;
  // 会话已关闭：不再续跑。
  private stopped = false;

  constructor(
    private readonly host: GoalHost,
    private readonly state: SessionStateHolder,
  ) {}

  get goal(): Goal | null {
    return this.state.goal;
  }

  // ── 用户侧 ──────────────────────────────────────────────────────────

  create(text: string, content?: GoalContent): void {
    if (this.hasOpenGoal())
      throw new StateError("conflict", CREATE_EXISTS_USER);
    const g = this.createNew(text, "user", content?.attachments);
    this.pendingImages = content?.images ?? [];
    this.host.note({
      event: "set",
      goalId: g.id,
      revision: g.revision,
      by: "user",
      text: g.text,
      ...(g.attachments ? { files: g.attachments.map((a) => a.name) } : {}),
    });
    // 用户刚立的目标：空闲就立刻开第一轮。
    this.settled();
  }

  edit(patch: {
    text?: string;
    maxRounds?: number | null;
    content?: GoalContent;
  }): void {
    if (!this.goal) throw new StateError("no_goal", "当前没有长期目标");
    const g = this.state.editGoal(
      {
        ...(patch.text === undefined ? {} : { text: patch.text }),
        ...(patch.maxRounds === undefined
          ? {}
          : { maxRounds: patch.maxRounds }),
        ...(patch.content === undefined
          ? {}
          : { attachments: patch.content.attachments }),
      },
      "user",
      now(),
    );
    // 给了 content 就替换待带图（images 为空则清空），没给不动附件也不动待带图。
    if (patch.content) this.pendingImages = patch.content.images;
    this.host.note({
      event: "edited",
      goalId: g.id,
      revision: g.revision,
      by: "user",
      ...(patch.text === undefined ? {} : { text: g.text }),
      ...(patch.maxRounds === undefined ? {} : { maxRounds: g.maxRounds }),
      ...(patch.content === undefined
        ? {}
        : { files: (g.attachments ?? []).map((a) => a.name) }),
    });
    // 文本或附件改了就按新目标继续；只改上限不动（上限在下一拍判定时才用得上）。
    if (patch.text !== undefined || patch.content !== undefined) this.settled();
  }

  // 用户暂停：正在跑就一并中断本轮（暂停先于 abort）。
  async pause(): Promise<void> {
    const g = this.state.pause({ code: "user-paused" }, now());
    if (!g) return;
    this.host.note({
      event: "paused",
      goalId: g.id,
      revision: g.revision,
      reason: g.reason,
    });
    if (this.host.busy()) await this.host.stop();
  }

  resume(): void {
    const g = this.state.resume(now());
    this.host.note({ event: "resumed", goalId: g.id, revision: g.revision });
    this.idleRounds = 0;
    this.settled();
  }

  clear(): void {
    const g = this.state.goal;
    if (!g) return;
    this.state.clearGoal();
    // 目标没了，待带图也不该偷偷跑到下一个目标的第一轮里。
    this.pendingImages = [];
    // 清除后目标已没了：版本号沿用被清除的那一份。
    this.host.note({ event: "cleared", goalId: g.id, revision: g.revision });
  }

  // ── 模型侧 ──────────────────────────────────────────────────────────

  modelGet(): GoalToolResult {
    const g = this.goal;
    return { text: g ? goalText(g) : NO_GOAL };
  }

  modelCreate(objective: string): GoalToolResult {
    if (this.hasOpenGoal()) return failure(CREATE_EXISTS);
    let g: Goal;
    try {
      g = this.createNew(objective, "model");
    } catch (err) {
      return modelFailure(err, this.goal);
    }
    this.createdInRun = g.id;
    this.host.note({
      event: "set",
      goalId: g.id,
      revision: g.revision,
      by: "model",
      text: g.text,
    });
    return { text: createdText(g) };
  }

  modelUpdate(p: {
    goalId: string;
    revision: number;
    action: "edit" | "complete" | "blocked";
    objective?: string;
    blockedReason?: string;
  }): GoalToolResult {
    const g = this.goal;
    if (!g || g.id !== p.goalId || g.revision !== p.revision)
      return failure(STALE_GOAL);
    try {
      if (p.action === "edit") return this.modelEdit(g, p.objective);
      if (!this.inDecidingRound(g)) return failure(OUTSIDE_GOAL_ROUND);
      return p.action === "complete"
        ? this.modelComplete()
        : this.modelBlock(g, p.blockedReason);
    } catch (err) {
      return modelFailure(err, this.goal);
    }
  }

  private modelEdit(g: Goal, objective?: string): GoalToolResult {
    if (g.by !== "model") return failure(USER_GOAL_LOCKED);
    if (objective === undefined || objective.trim() === "")
      return failure(EDIT_NEEDS_OBJECTIVE);
    const next = this.state.editGoal({ text: objective }, "model", now());
    this.host.note({
      event: "edited",
      goalId: next.id,
      revision: next.revision,
      by: "model",
      text: next.text,
    });
    return { text: editedText(next) };
  }

  private modelComplete(): GoalToolResult {
    const next = this.state.complete(now());
    this.host.note({
      event: "complete",
      goalId: next.id,
      revision: next.revision,
    });
    return { text: decidedText(next) };
  }

  private modelBlock(g: Goal, blockedReason?: string): GoalToolResult {
    if (g.rounds < GOAL_BLOCK_MIN_ROUNDS)
      return failure(blockTooEarly(GOAL_BLOCK_MIN_ROUNDS, g.rounds));
    if (blockedReason === undefined || blockedReason.trim() === "")
      return failure(BLOCK_NEEDS_REASON);
    const next = this.state.block(
      { code: "model-blocked", detail: blockedReason.trim() },
      now(),
    );
    this.host.note({
      event: "blocked",
      goalId: next.id,
      revision: next.revision,
      reason: next.reason,
    });
    return { text: decidedText(next) };
  }

  // 目标轮，或本轮里刚创建了目标的运行：只有它们能宣布完成 / 受阻。
  private inDecidingRound(g: Goal): boolean {
    return this.goalRun || this.createdInRun === g.id;
  }

  // 已有没完成的目标时不能再立：要改用编辑，完成后才能立新的。
  private hasOpenGoal(): boolean {
    const g = this.goal;
    return g !== null && g.state !== "complete";
  }

  // 上限取设置里的默认值现取；模型不能自己指定。
  private createNew(
    text: string,
    by: Goal["by"],
    attachments?: AttachmentRef[],
  ): Goal {
    return this.state.createGoal(
      text,
      by,
      this.host.defaultMaxRounds(),
      uuidv7(),
      now(),
      attachments,
    );
  }

  // ── 事件钩子 ────────────────────────────────────────────────────────

  /** 一轮开始（自动重试不重复触发）：清掉上一轮的目标态与工具计数。 */
  runStarted(): void {
    // goalRun 不动：它标记的是「这一轮由注入开始」，跨过 runStarted 才有效。
    this.createdInRun = null;
    this.toolCalls = 0;
  }

  toolStarted(): void {
    this.toolCalls += 1;
  }

  /** 一轮结束：先按结果判目标，再让 settled 决定要不要续跑。 */
  runEnded(outcome: GoalOutcome): void {
    const wasGoalRound = this.goalRun;
    const tools = this.toolCalls;
    this.goalRun = false;
    const g = this.goal;
    if (g?.state === "active") {
      // 出错优先于空转判定：重试用尽还是失败就先停下等用户，不自动重试。
      if (outcome.error !== undefined) {
        this.pauseByHarness({ code: "request-failed", detail: outcome.error });
        return;
      }
      // 只有注入产生的那一轮参与空转计数：用户亲手发起的一轮不算数，也不清零。
      if (wasGoalRound) {
        if (tools === 0) {
          this.idleRounds += 1;
          if (this.idleRounds >= GOAL_IDLE_ROUNDS) {
            this.blockByHarness(
              { code: "no-tool-calls" },
              wrapUpMessage({
                code: "no-tool-calls",
                rounds: GOAL_IDLE_ROUNDS,
              }),
            );
            return;
          }
        } else {
          this.idleRounds = 0;
        }
      }
    }
    this.settled();
  }

  /** 用户停止会话（在 abort 之前调用）：正在跑的目标转入暂停。 */
  userStopped(): void {
    this.pauseByHarness({ code: "user-stopped" });
  }

  /** 重启恢复：载入时还在跑的目标转为暂停，等用户点继续。 */
  restore(): void {
    this.pauseByHarness({ code: "server-restart" });
  }

  private pauseByHarness(reason: GoalReason): void {
    const g = this.state.goal;
    if (g?.state !== "active") return;
    const next = this.state.pause(reason, now());
    if (next)
      this.host.note({
        event: "paused",
        goalId: next.id,
        revision: next.revision,
        reason: next.reason,
      });
  }

  // harness 判定受阻：收尾消息本身就是那张卡片，不再 note。
  private blockByHarness(reason: GoalReason, wrapUp: string): void {
    const g = this.state.goal;
    if (g?.state !== "active") return;
    const next = this.state.block(reason, now());
    this.idleRounds = 0;
    this.send(wrapUp, {
      event: "blocked",
      goalId: next.id,
      revision: next.revision,
      reason: next.reason,
    });
  }

  // ── 续跑 ────────────────────────────────────────────────────────────

  /** 会话关闭：不再续跑（已经排下的那一拍也不会注入）。 */
  dispose(): void {
    this.stopped = true;
  }

  /** 检查要不要续跑；幂等（同时刻只排一次、只注入一条），用 setImmediate 推迟一拍。 */
  settled(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.maybeInject();
    });
  }

  private maybeInject(): void {
    if (this.stopped) return;
    const g = this.goal;
    if (g?.state !== "active") return;
    if (this.host.busy() || this.host.hasPendingWork()) return;
    this.injectRound(g);
  }

  private injectRound(g: Goal): void {
    if (g.maxRounds !== null && g.rounds >= g.maxRounds) {
      this.blockByHarness(
        { code: "round-limit" },
        wrapUpMessage({ code: "round-limit", max: g.maxRounds }),
      );
      return;
    }
    let next: Goal;
    try {
      next = this.state.advanceRound(now());
    } catch (err) {
      // 期间目标被改动（暂停 / 清除 / 完成）：这一拍不注入。
      if (err instanceof StateError || err instanceof GoalError) return;
      throw err;
    }
    this.send(roundMessage(next, next.rounds), {
      event: "round",
      goalId: next.id,
      revision: next.revision,
      round: next.rounds,
      maxRounds: next.maxRounds,
    });
  }

  private send(text: string, notice: GoalNotice): void {
    // 注入的这一轮从此刻开始：算目标轮，工具调用计数从零起。
    this.goalRun = true;
    this.createdInRun = null;
    this.toolCalls = 0;
    // 待带图取走一次：只有新建 / 改附件后的第一轮带图，之后每轮只带标记行。
    const images = this.pendingImages;
    this.pendingImages = [];
    this.host.inject(text, notice, images.length > 0 ? images : undefined);
  }
}
