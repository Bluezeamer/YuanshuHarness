import { type CallResult, call, enc } from "./http";

// 模型调用记录（审计页）与用量聚合；与执行审计 `audit.ts` 无关。形状对应服务端 store/calls.ts。

export type CallTrigger = "user" | "tool_result" | "subagent";

/** 一次调用的 token 拆分。四段是按请求体字符数分摊的估算；estimated 表示总量本身也是估的。 */
export interface CallTokens {
  system: number;
  tools: number;
  history: number;
  current: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  estimated: boolean;
}

export interface CallSummary {
  id: string;
  runId: string | null;
  seq: number;
  /** 会话内第几轮（从 1 起）；无 run 归属时为 null。 */
  turn: number | null;
  trigger: CallTrigger;
  /** trigger=tool_result 时，触发这次调用的工具。 */
  toolName: string | null;
  durationMs: number;
  /** 触发这次调用的那条输入的一行文字。 */
  summary: string;
  /** 模型这次回复里发起的工具调用名；非空即「工具调用」。 */
  calledTools: string[];
  stopReason: string;
  model: string;
  window: number | null;
  tokens: CallTokens;
  createdAt: string;
  /** 这次请求里非 system 的对话项条数，用来算事件范围。 */
  msgCount: number;
  /** 0 = 当前未压缩段；1..N = 第几段压缩历史（越大越新）。 */
  segment: number;
  /** 仅父会话审计「子代理」档里的调用才有：它实际属于哪个子会话（seq / turn 是子会话内的序号）。 */
  subagent?: { sessionId: string; name: string };
}

/**
 * request 是原始 provider payload（形状随供应商变化）；response 是归一化后的助手消息。
 * segment > 0 时 request 是压缩前快照 `{system?, messages: [...原始消息]}`，range 是事件在其中的消息项下标。
 */
export interface CallRecord extends CallSummary {
  sessionId: string;
  request: unknown;
  response: unknown;
  /** request 是压缩前快照（不是最新一次请求） */
  snapshot: boolean;
  /** request 消息项里本事件的范围，左闭右开；null = 算不出 / 没有范围。 */
  range: { from: number; to: number } | null;
}

/** 一次上下文压缩：把之前的调用切成一段历史。 */
export interface CallCompaction {
  /** 压缩序号，按时间 1..N 递增 */
  seq: number;
  createdAt: string;
  summary: string;
  tokensBefore: number;
  /** 这一段里的调用 seq 范围；该段没有调用时为 null */
  callSeqFrom: number | null;
  callSeqTo: number | null;
  /** 压缩前上下文里的消息条数 */
  messageCount: number;
}

export interface CallsPage {
  /** seq 倒序 */
  calls: CallSummary[];
  /** 还有更早的调用时为下一页游标（本页最小 seq），否则 null */
  nextBefore: number | null;
}

/** 子代理调用页：按时间倒序，游标是本页最小的调用 id；total 是整棵子树的调用总数。 */
export interface SubCallsPage {
  calls: CallSummary[];
  nextBefore: string | null;
  total: number;
}

export interface CallUsage {
  turns: number;
  steps: number;
  tokensPerSecond: number | null;
  modelMs: number;
  /** 工具执行总耗时（ms）；有记录缺计时数据（升级前的旧记录）时为 null。 */
  toolMs: number | null;
  /** 首 token 平均耗时（ms）；没有测到首 token 的调用时为 null。 */
  ttftMs: number | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cacheHitRate: number | null;
  context: {
    used: number;
    window: number | null;
    system: number;
    tools: number;
    messages: number;
  } | null;
}

export const listCalls = (
  token: string | null,
  sessionId: string,
  q: { before?: number; limit?: number } = {},
): Promise<CallResult<CallsPage>> => {
  const p = new URLSearchParams();
  if (q.before !== undefined) p.set("before", String(q.before));
  if (q.limit !== undefined) p.set("limit", String(q.limit));
  const qs = p.size ? `?${p}` : "";
  return call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/calls${qs}`,
    token,
    undefined,
    (b: CallsPage) => {
      if (!Array.isArray(b.calls)) throw new Error("shape");
      return { calls: b.calls, nextBefore: b.nextBefore ?? null };
    },
  );
};

// 该会话派发出的整棵子树的调用（子代理的调用记在子会话名下，/calls 里没有）。
export const listSubagentCalls = (
  token: string | null,
  sessionId: string,
  q: { before?: string; limit?: number } = {},
): Promise<CallResult<SubCallsPage>> => {
  const p = new URLSearchParams();
  if (q.before !== undefined) p.set("before", q.before);
  if (q.limit !== undefined) p.set("limit", String(q.limit));
  const qs = p.size ? `?${p}` : "";
  return call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/subagent-calls${qs}`,
    token,
    undefined,
    (b: SubCallsPage) => {
      if (!Array.isArray(b.calls) || typeof b.total !== "number")
        throw new Error("shape");
      return {
        calls: b.calls,
        nextBefore: b.nextBefore ?? null,
        total: b.total,
      };
    },
  );
};

// 不存在（或不属于该会话）时得到 not_found。
export const getCall = (
  token: string | null,
  sessionId: string,
  callId: string,
): Promise<CallResult<CallRecord>> =>
  call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/calls/${enc(callId)}`,
    token,
    undefined,
    (b: CallRecord) => {
      if (typeof b.id !== "string") throw new Error("shape");
      return b;
    },
  );

export const getUsage = (
  token: string | null,
  sessionId: string,
): Promise<CallResult<CallUsage>> =>
  call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/usage`,
    token,
    undefined,
    (b: CallUsage) => b,
  );

/** 会话的上下文压缩历史，seq 按时间递增。 */
export const getCompactions = (
  token: string | null,
  sessionId: string,
): Promise<CallResult<CallCompaction[]>> =>
  call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/compactions`,
    token,
    undefined,
    (b: { compactions: CallCompaction[] }) => {
      if (!Array.isArray(b.compactions)) throw new Error("shape");
      return b.compactions;
    },
  );
