// 对话流里「不在消息历史里」的事件：压缩回执、审批 / 提问卡的落定结果。
// 数据层只给当前快照（compact / prompts），没有事件史；这里观察快照的变化，
// 把变化记成按「当时已有多少条消息」锚定的条目（at），刷新后只能从当前快照重建一份基线。
// 目标的变化不在这里：服务端把它们记成会话里的卡片（GoalNotice，见 notices.ts）。
// 纯函数，不依赖 React。

import type { CompactInfo, Prompt } from "../model/conversation";
import { fmtClock } from "./format";

export type ReceiptKind = "compact";

export interface Receipt {
  seq: number;
  at: number;
  kind: ReceiptKind;
  badge: string;
  text: string;
  time: string;
}

export interface PromptAnswer {
  optionId?: string;
  text?: string;
  /** 答复的展示文字（选项文案或输入内容） */
  label: string;
  time: string;
}

export interface PromptEntry {
  seq: number;
  at: number;
  prompt: Prompt;
  /** pending 等待答复；answered 本端答复并已落定；gone 被其他端答复、超时或撤销 */
  status: "pending" | "answered" | "gone";
  /** 本端已点选（等服务端确认落定） */
  answer?: PromptAnswer;
  /** 落定时间 */
  time?: string;
}

export interface FlowLog {
  seeded: boolean;
  seq: number;
  receipts: Receipt[];
  prompts: PromptEntry[];
  prev: { compact: CompactInfo | null };
}

export const emptyLog: FlowLog = {
  seeded: false,
  seq: 0,
  receipts: [],
  prompts: [],
  prev: { compact: null },
};

export interface Observed {
  open: boolean;
  /** 已有多少条窗口消息，用作锚点 */
  count: number;
  compact: CompactInfo | null;
  prompts: Prompt[];
}

const BADGE: Record<ReceiptKind, string> = {
  compact: "/compact",
};

const clockOf = (v: string | undefined): string => (v ? fmtClock(v) : "");

const sameCompact = (a: CompactInfo | null, b: CompactInfo | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.summary === b.summary &&
    a.savedPct === b.savedPct);

const compactText = (c: CompactInfo): string =>
  `上下文已压缩${c.savedPct > 0 ? ` · 节省 ${Math.round(c.savedPct)}%` : ""}`;

function push(
  log: FlowLog,
  at: number,
  kind: ReceiptKind,
  text: string,
  time: string,
): FlowLog {
  const seq = log.seq + 1;
  const r: Receipt = {
    seq,
    at,
    kind,
    badge: BADGE[kind],
    text,
    time,
  };
  return { ...log, seq, receipts: [...log.receipts, r] };
}

// 一次观察：把快照的变化记成条目。连接还没就绪时什么都不记；第一次就绪时只建基线（已有的压缩算一条回执）。
export function observe(log: FlowLog, o: Observed, at: Date): FlowLog {
  if (!o.open && !log.seeded) return log;
  const now = fmtClock(at);
  let next = log;

  if (!log.seeded) {
    next = { ...next, seeded: true };
    if (o.compact)
      next = push(
        next,
        o.count,
        "compact",
        compactText(o.compact),
        clockOf(o.compact.at),
      );
  } else if (o.compact && !sameCompact(o.compact, log.prev.compact)) {
    next = push(next, o.count, "compact", compactText(o.compact), now);
  }

  // 弹窗：新出现的记为 pending，消失的落定。
  const live = new Set(o.prompts.map((p) => p.promptId));
  let seq = next.seq;
  const prompts = next.prompts.map((e): PromptEntry => {
    if (e.status !== "pending" || live.has(e.prompt.promptId)) return e;
    return { ...e, status: e.answer ? "answered" : "gone", time: now };
  });
  for (const p of o.prompts) {
    if (prompts.some((e) => e.prompt.promptId === p.promptId)) continue;
    seq += 1;
    prompts.push({ seq, at: o.count, prompt: p, status: "pending" });
  }
  return {
    ...next,
    seq,
    prompts,
    prev: { compact: o.compact },
  };
}

const mapPrompt = (
  log: FlowLog,
  promptId: string,
  f: (e: PromptEntry) => PromptEntry,
): FlowLog => ({
  ...log,
  prompts: log.prompts.map((e) => (e.prompt.promptId === promptId ? f(e) : e)),
});

/** 本端点选了答案：卡片进入「已提交」，等服务端确认落定 */
export function markAnswered(
  log: FlowLog,
  promptId: string,
  answer: Omit<PromptAnswer, "time">,
  at: Date,
): FlowLog {
  return mapPrompt(log, promptId, (e) =>
    e.status === "pending" && !e.answer
      ? { ...e, answer: { ...answer, time: fmtClock(at) } }
      : e,
  );
}

/** 答复被拒（已被其他端答复、无效……）：撤回本端的点选 */
export function clearAnswer(log: FlowLog, promptId: string): FlowLog {
  return mapPrompt(log, promptId, (e) => {
    const { answer: _drop, ...rest } = e;
    return rest;
  });
}
