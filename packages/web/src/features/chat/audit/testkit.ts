// 审计页测试共用夹具（只被 *.test.* 引用，不进产物）：调用记录构造与按服务端语义分页的假接口。
import type {
  CallCompaction,
  CallRecord,
  CallSummary,
  CallsPage,
  CallTokens,
  CallTrigger,
  SubCallsPage,
} from "../../../api/calls";

export const ok = <T>(data: T) => ({ ok: true as const, data });
export const bad = (kind: string) => ({ ok: false as const, kind });

export const tokens = (over: Partial<CallTokens> = {}): CallTokens => ({
  system: 100,
  tools: 50,
  history: 200,
  current: 30,
  out: 40,
  cacheRead: 0,
  cacheWrite: 0,
  estimated: false,
  ...over,
});

export interface Spec {
  seq: number;
  turn: number | null;
  trigger: CallTrigger;
  toolName?: string | null;
  calledTools?: string[];
  summary?: string;
  tokens?: Partial<CallTokens>;
  durationMs?: number;
  request?: unknown;
  response?: unknown;
  /** 请求里非 system 对话项的条数；默认按 Anthropic 夹具的 3 条 */
  msgCount?: number;
  /** 0 = 当前段；1..N = 第几段压缩历史 */
  segment?: number;
  /** 本事件在 request 消息项里的范围；null = 不标范围 */
  range?: { from: number; to: number } | null;
  snapshot?: boolean;
}

// Anthropic 风格：system 块（末块带 cache_control）、tools、messages（含 tool_use / tool_result）。
export const anthropicRequest = (seq: number): unknown => ({
  model: "claude-x",
  max_tokens: 4096,
  system: [
    { type: "text", text: "你是元枢的编码助手。" },
    { type: "text", text: "会话约定：中文回复。" },
    {
      type: "text",
      text: "AGENTS.md：先读后改。",
      cache_control: { type: "ephemeral" },
    },
  ],
  tools: [
    { name: "read_file", description: "读取文件", input_schema: {} },
    { name: "edit_file", description: "修改文件", input_schema: {} },
  ],
  messages: [
    { role: "user", content: `请处理第 ${seq} 步` },
    {
      role: "assistant",
      content: [
        { type: "text", text: "先读一下。" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "export const a = 1;",
        },
      ],
    },
  ],
});

export const piResponse = (
  text: string,
  stopReason = "toolUse",
  tools: string[] = ["edit_file"],
): unknown => ({
  content: [
    { type: "text", text },
    ...tools.map((name, i) => ({
      type: "toolCall",
      id: `c${i + 1}`,
      name,
      arguments: { path: "a.ts" },
    })),
  ],
  stopReason,
  usage: { input: 380, output: 40, cacheRead: 0, cacheWrite: 0 },
});

export function makeCall(sessionId: string, s: Spec): CallRecord {
  const segment = s.segment ?? 0;
  const base: CallSummary = {
    id: `${sessionId}-c${s.seq}`,
    runId: s.turn === null ? null : `run-${s.turn}`,
    seq: s.seq,
    turn: s.turn,
    trigger: s.trigger,
    toolName: s.toolName ?? null,
    durationMs: s.durationMs ?? 1500,
    summary: s.summary ?? `摘要 ${s.seq}`,
    calledTools: s.calledTools ?? [],
    stopReason: (s.calledTools ?? []).length ? "toolUse" : "stop",
    model: "claude-x",
    window: 200000,
    tokens: tokens(s.tokens),
    createdAt: `2026-10-25T08:${String(10 + s.seq).padStart(2, "0")}:05.000Z`,
    msgCount: s.msgCount ?? 3,
    segment,
  };
  return {
    ...base,
    sessionId,
    request: s.request ?? anthropicRequest(s.seq),
    response:
      s.response ??
      piResponse(`回复 ${s.seq}`, base.stopReason, s.calledTools ?? []),
    snapshot: s.snapshot ?? segment > 0,
    range: s.range ?? null,
  };
}

// 12 条记录，两轮：本会话自己的 11 次（2 用户 + 9 工具返回，发起了工具的 8 条）+ 子代理的 1 次（seq 12）。
// 子代理那条在真实服务里记在子会话名下，不在本会话的 /calls 里，见 fakeServer。
export function sample(sessionId = "s1"): CallRecord[] {
  const specs: Spec[] = [
    {
      seq: 1,
      turn: 1,
      trigger: "user",
      calledTools: ["read_file"],
      summary: "修一下重试逻辑",
    },
    {
      seq: 2,
      turn: 1,
      trigger: "tool_result",
      toolName: "read_file",
      calledTools: ["edit_file"],
      summary: "export function retry()",
    },
    {
      seq: 3,
      turn: 1,
      trigger: "tool_result",
      toolName: "edit_file",
      calledTools: ["run_tests"],
      summary: "edited",
    },
    {
      seq: 4,
      turn: 1,
      trigger: "tool_result",
      toolName: "run_tests",
      summary: "12 passed",
    },
    {
      seq: 5,
      turn: 2,
      trigger: "user",
      calledTools: ["dispatch_subagent"],
      summary: "再查一下鉴权",
    },
    {
      seq: 6,
      turn: 2,
      trigger: "tool_result",
      toolName: "read_file",
      calledTools: ["read_file"],
      summary: "export const login",
    },
    {
      seq: 7,
      turn: 2,
      trigger: "tool_result",
      toolName: "read_file",
      calledTools: ["grep"],
      summary: "export const auth",
    },
    {
      seq: 8,
      turn: 2,
      trigger: "tool_result",
      toolName: "grep",
      calledTools: ["read_file"],
      summary: "3 matches",
    },
    {
      seq: 9,
      turn: 2,
      trigger: "tool_result",
      toolName: "read_file",
      calledTools: ["write_file"],
      summary: "export const token",
    },
    {
      seq: 10,
      turn: 2,
      trigger: "tool_result",
      toolName: "write_file",
      summary: "written",
    },
    {
      seq: 11,
      turn: 2,
      trigger: "tool_result",
      toolName: "dispatch_subagent",
      summary: "子代理结论：无问题",
    },
    {
      seq: 12,
      turn: 2,
      trigger: "subagent",
      calledTools: ["read_file"],
      summary: "子任务：读取 auth.ts",
    },
  ];
  return specs.map((s) => makeCall(sessionId, s));
}

export const summaryOf = (r: CallRecord): CallSummary => {
  const {
    sessionId: _s,
    request: _q,
    response: _r,
    snapshot: _snap,
    range: _range,
    ...rest
  } = r;
  return rest;
};

/** 压缩历史夹具：默认第 seq 段、压缩前 8000 tok、有 2 条消息、调用 seq 区间由调用方给。 */
export function compaction(
  seq: number,
  over: Partial<CallCompaction> = {},
): CallCompaction {
  return {
    seq,
    createdAt: `2026-10-25T09:${String(seq).padStart(2, "0")}:00.000Z`,
    summary: `压缩摘要 ${seq}`,
    tokensBefore: 8000,
    callSeqFrom: null,
    callSeqTo: null,
    messageCount: 2,
    ...over,
  };
}

/** 假服务里，store[sid] 中 trigger=subagent 的调用视为 sid 派出的子会话 `${sid}-sub` 名下的调用。 */
export const SUB_NAME = "只读检索";
export const subOf = (sid: string) => `${sid}-sub`;

/**
 * 按服务端语义实现的假列表 / 详情接口：
 * list 是本会话自己的调用（seq 倒序、before 游标、limit 默认 50），不含子代理调用；
 * listSubs 是子代理的调用（id 游标，带来源标记）；get 按调用所属的会话取，子代理的调用要用子会话 id。
 */
export function fakeServer(store: () => Record<string, CallRecord[]>) {
  return {
    listSubs: async (
      _token: string | null,
      sid: string,
      q: { before?: string; limit?: number } = {},
    ) => {
      const all = (store()[sid] ?? [])
        .filter((c) => c.trigger === "subagent")
        .sort((a, b) => b.seq - a.seq);
      const start = q.before ? all.findIndex((c) => c.id === q.before) + 1 : 0;
      const limit = q.limit ?? 50;
      const page = all.slice(start, start + limit).map((c) => ({
        ...summaryOf(c),
        subagent: { sessionId: subOf(sid), name: SUB_NAME },
      }));
      const out: SubCallsPage = {
        calls: page,
        nextBefore:
          start + limit < all.length ? (page.at(-1)?.id ?? null) : null,
        total: all.length,
      };
      return ok(out);
    },
    list: async (
      _token: string | null,
      sid: string,
      q: { before?: number; limit?: number } = {},
    ) => {
      const all = (store()[sid] ?? [])
        .filter(
          (c) =>
            c.trigger !== "subagent" &&
            c.seq < (q.before ?? Number.MAX_SAFE_INTEGER),
        )
        .sort((a, b) => b.seq - a.seq);
      const limit = q.limit ?? 50;
      const page = all.slice(0, limit).map(summaryOf);
      const out: CallsPage = {
        calls: page,
        nextBefore: all.length > limit ? (page.at(-1)?.seq ?? null) : null,
      };
      return ok(out);
    },
    get: async (_token: string | null, sid: string, id: string) => {
      const [parent, child] = sid.endsWith("-sub")
        ? [sid.slice(0, -4), true]
        : [sid, false];
      const r = (store()[parent] ?? []).find(
        (c) => c.id === id && (c.trigger === "subagent") === child,
      );
      return r ? ok(r) : bad("not_found");
    },
  };
}
