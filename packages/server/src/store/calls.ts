import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { uuidv7 } from "../id.js";
import type { CallTokens } from "../session/call-tokens.js";
import type { Db } from "./db.js";

export type CallTrigger = "user" | "tool_result" | "subagent";

/** 列表行要用的小摘要，和 tokens 一起存明文，分页不必解压原文。 */
export interface CallMeta {
  /** 触发这次调用的那条输入的一行文字（用户消息 / 工具返回）。 */
  summary: string;
  /** 模型这次回复里发起的工具调用名；非空即「工具调用」档。 */
  calledTools: string[];
  /**
   * 上一次调用之后实际执行过的工具明细，含其它工具发起的嵌套调用（如 call_tool 转发的）。
   * 取自 pi 的事件信号：嵌套调用不出现在助手消息的 toolCall 块里，只能从事件拿到。
   */
  toolCalls?: {
    toolCallId: string;
    parentToolCallId?: string;
    toolName: string;
    durationMs?: number;
    isError?: boolean;
  }[];
  stopReason: string;
  model: string;
  /** 当时模型的上下文窗口；未知为 null。 */
  window: number | null;
}

/** 服务端旁路测得的耗时。模型提供方不提供这两项，只能由调用捕获自己统计。 */
export interface CallTiming {
  /**
   * 自上一次调用落库以来执行完的工具耗时之和（ms）。工具总在「本次调用发起后、
   * 下一次调用前」执行，所以归到下一次调用记录；会话内求和即工具执行总耗时。
   */
  toolMs: number;
  /** 从发出请求到收到第一个非空流式增量（文本 / 思考）的耗时（ms）；没收到增量时缺省。 */
  ttftMs?: number;
}

export interface NewCall {
  sessionId: string;
  runId: string | null;
  trigger: CallTrigger;
  toolName: string | null;
  durationMs: number;
  tokens: CallTokens;
  meta: CallMeta;
  /** 服务端计时；模型提供方不给这类指标，升级前的旧记录也没有。 */
  timing?: CallTiming;
  /** 本次请求里的对话项数（非 system）；审计按它定位每次调用的新增内容。 */
  msgCount: number;
  /** 发给模型的请求体 JSON 原文；只留作该会话的 latest_request，不逐次存。 */
  requestJson: string;
  responseJson: string;
}

export interface CallSummary extends CallMeta {
  id: string;
  seq: number;
  /** 会话内第几轮（run 的序号，从 1 起）；无 run 归属时为 null。 */
  turn: number | null;
  runId: string | null;
  trigger: CallTrigger;
  toolName: string | null;
  durationMs: number;
  tokens: CallTokens;
  /** 该次请求里的对话项数（非 system）。 */
  msgCount: number;
  createdAt: string;
}

/** 父会话审计里的子代理调用：seq / turn 是子会话内的序号，subagent 标明来自哪个子会话。 */
export interface SubCallSummary extends CallSummary {
  subagent: { sessionId: string; name: string };
}

/** 一个被并入审计的子孙会话；name 是它的任务摘要。 */
export interface SubSession {
  id: string;
  name: string;
}

/** 详情里逐次存的部分；request 由 API 层按段取 latest_request 或从会话 JSONL 重建快照。 */
export interface CallRecord extends CallSummary {
  sessionId: string;
  response: unknown;
}

/** 会话内一条调用的位置：审计算压缩段与区间用。 */
export interface CallPoint {
  seq: number;
  msgCount: number;
  createdAt: string;
}

export interface CallUsage {
  turns: number;
  steps: number;
  /** 累计输出 token / 累计模型用时；没有上报过输出的会话为 null。 */
  tokensPerSecond: number | null;
  modelMs: number;
  /** 工具执行总耗时（各次调用的计时求和，ms）；有记录缺计时数据（升级前的旧记录）时为 null。 */
  toolMs: number | null;
  /** 首 token 平均耗时（ms），只统计收到过首个流式增量的调用；没有数据时为 null。 */
  ttftMs: number | null;
  /** input = 整次请求的输入量（含缓存读写），即每次调用四段之和的累计。 */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** cacheRead / input；还没有输入时为 null。 */
  cacheHitRate: number | null;
  /** 最近一次调用的占用；system / tools 取其精确分段，messages 为余量。 */
  context: {
    used: number;
    window: number | null;
    system: number;
    tools: number;
    messages: number;
  } | null;
}

export const CALLS_PAGE_DEFAULT = 50;
export const CALLS_PAGE_MAX = 200;

type Row = {
  id: string;
  session_id: string;
  run_id: string | null;
  seq: number;
  trigger: string;
  tool_name: string | null;
  duration_ms: number;
  tokens_json: string;
  meta_json: string;
  msg_count: number;
  created_at: string;
};
type FullRow = Row & { response_z: Buffer };

const SUMMARY_COLS =
  "id, session_id, run_id, seq, trigger, tool_name, duration_ms, tokens_json, meta_json, msg_count, created_at";

const pack = (json: string) => zstdCompressSync(Buffer.from(json, "utf8"));
const unpack = (z: Buffer) => zstdDecompressSync(z).toString("utf8");

export class CallStore {
  constructor(private readonly db: Db) {}

  // 只追加：seq 在会话内递增，写入后不再修改。latest_request 与调用记录同一事务更新。
  record(c: NewCall): string {
    const id = uuidv7();
    const insert = this.db.transaction(() => {
      const { n } = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM calls WHERE session_id = ?",
        )
        .get(c.sessionId) as { n: number };
      const at = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO calls (id, session_id, run_id, seq, trigger, tool_name, duration_ms,
             tokens_json, meta_json, msg_count, response_z, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          c.sessionId,
          c.runId,
          n,
          c.trigger,
          c.toolName,
          Math.max(0, Math.round(c.durationMs)),
          JSON.stringify(c.tokens),
          JSON.stringify(
            c.timing === undefined ? c.meta : { ...c.meta, timing: c.timing },
          ),
          Math.max(0, Math.round(c.msgCount)),
          pack(c.responseJson),
          at,
        );
      this.db
        .prepare(
          `INSERT INTO latest_request (session_id, request_z, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET request_z = excluded.request_z,
             updated_at = excluded.updated_at`,
        )
        .run(c.sessionId, pack(c.requestJson), at);
    });
    insert();
    return id;
  }

  // run 按首次出现的顺序编号，作为「第几轮」。
  private turns(sessionId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT run_id FROM calls WHERE session_id = ? AND run_id IS NOT NULL
         GROUP BY run_id ORDER BY MIN(seq)`,
      )
      .all(sessionId) as { run_id: string }[];
    return new Map(rows.map((r, i) => [r.run_id, i + 1]));
  }

  private summary(r: Row, turns: Map<string, number>): CallSummary {
    // timing 只服务 usage() 聚合，不进调用列表 / 详情。
    const meta = JSON.parse(r.meta_json) as CallMeta & { timing?: unknown };
    delete meta.timing;
    return {
      id: r.id,
      seq: r.seq,
      turn: r.run_id ? (turns.get(r.run_id) ?? null) : null,
      runId: r.run_id,
      trigger: r.trigger as CallTrigger,
      toolName: r.tool_name,
      durationMs: r.duration_ms,
      tokens: JSON.parse(r.tokens_json) as CallTokens,
      msgCount: r.msg_count,
      createdAt: r.created_at,
      ...meta,
    };
  }

  /** 按 seq 倒序；还有更早的调用时 nextBefore 是下一页游标（本页最小 seq）。 */
  list(
    sessionId: string,
    q: { before?: number; limit?: number } = {},
  ): { calls: CallSummary[]; nextBefore: number | null } {
    const limit = Math.min(q.limit ?? CALLS_PAGE_DEFAULT, CALLS_PAGE_MAX);
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLS} FROM calls WHERE session_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, q.before ?? Number.MAX_SAFE_INTEGER, limit + 1) as Row[];
    const turns = this.turns(sessionId);
    const page = rows.slice(0, limit).map((r) => this.summary(r, turns));
    return {
      calls: page,
      nextBefore: rows.length > limit ? (page.at(-1)?.seq ?? null) : null,
    };
  }

  /**
   * 一批子孙会话的调用合在一起，按 id（uuidv7，即时间序）倒序；还有更早的调用时 nextBefore 是下一页游标
   * （本页最小 id）。total 是这批会话的调用总数，不受分页影响。
   */
  listSubs(
    subs: readonly SubSession[],
    q: { before?: string; limit?: number } = {},
  ): { calls: SubCallSummary[]; nextBefore: string | null; total: number } {
    if (subs.length === 0) return { calls: [], nextBefore: null, total: 0 };
    const limit = Math.min(q.limit ?? CALLS_PAGE_DEFAULT, CALLS_PAGE_MAX);
    const ids = subs.map((s) => s.id);
    const marks = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLS} FROM calls WHERE session_id IN (${marks}) AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...ids, q.before ?? "\uffff", limit + 1) as Row[];
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM calls WHERE session_id IN (${marks})`)
      .get(...ids) as { n: number };
    const names = new Map(subs.map((s) => [s.id, s.name]));
    const turns = new Map<string, Map<string, number>>();
    const page = rows.slice(0, limit).map((r): SubCallSummary => {
      const t = turns.get(r.session_id) ?? this.turns(r.session_id);
      turns.set(r.session_id, t);
      return {
        ...this.summary(r, t),
        subagent: {
          sessionId: r.session_id,
          name: names.get(r.session_id) ?? "",
        },
      };
    });
    return {
      calls: page,
      nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      total: n,
    };
  }

  /** call 不属于该会话时返回 null；request 不在这里，由 API 层按压缩段取。 */
  get(sessionId: string, callId: string): CallRecord | null {
    const r = this.db
      .prepare(
        `SELECT ${SUMMARY_COLS}, response_z FROM calls WHERE id = ? AND session_id = ?`,
      )
      .get(callId, sessionId) as FullRow | undefined;
    if (!r) return null;
    return {
      ...this.summary(r, this.turns(sessionId)),
      sessionId: r.session_id,
      response: JSON.parse(unpack(r.response_z)),
    };
  }

  /** 该会话最新一次请求体（原始 provider payload）；没有记录时为 null。 */
  latestRequest(sessionId: string): unknown | null {
    const r = this.db
      .prepare("SELECT request_z FROM latest_request WHERE session_id = ?")
      .get(sessionId) as { request_z: Buffer } | undefined;
    return r ? JSON.parse(unpack(r.request_z)) : null;
  }

  /** 该会话全部调用的位置，按 seq 升序；审计按压缩时间归段、算区间用。 */
  timeline(sessionId: string): CallPoint[] {
    const rows = this.db
      .prepare(
        `SELECT seq, msg_count AS msgCount, created_at AS createdAt
         FROM calls WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as CallPoint[];
    return rows;
  }

  usage(sessionId: string): CallUsage {
    const j = (k: string) => `json_extract(tokens_json, '$.${k}')`;
    const t = (k: string) => `json_extract(meta_json, '$.timing.${k}')`;
    const a = this.db
      .prepare(
        `SELECT COUNT(*) AS steps,
                COUNT(DISTINCT run_id) AS turns,
                COALESCE(SUM(duration_ms), 0) AS ms,
                COALESCE(SUM(${j("system")} + ${j("tools")} + ${j("history")} + ${j("current")}), 0) AS input,
                COALESCE(SUM(${j("out")}), 0) AS output,
                COALESCE(SUM(${j("cacheRead")}), 0) AS cache_read,
                COALESCE(SUM(${j("cacheWrite")}), 0) AS cache_write,
                COALESCE(SUM(CASE WHEN ${j("estimated")} = 0 THEN ${j("out")} END), 0) AS real_out,
                COALESCE(SUM(CASE WHEN ${j("estimated")} = 0 THEN duration_ms END), 0) AS real_ms,
                COALESCE(SUM(${t("toolMs")}), 0) AS tool_ms,
                COALESCE(SUM(CASE WHEN ${t("toolMs")} IS NOT NULL THEN 1 ELSE 0 END), 0) AS tool_n,
                COALESCE(SUM(${t("ttftMs")}), 0) AS ttft_sum,
                COALESCE(SUM(CASE WHEN ${t("ttftMs")} IS NOT NULL THEN 1 ELSE 0 END), 0) AS ttft_n
         FROM calls WHERE session_id = ?`,
      )
      .get(sessionId) as {
      steps: number;
      turns: number;
      ms: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      real_out: number;
      real_ms: number;
      tool_ms: number;
      tool_n: number;
      ttft_sum: number;
      ttft_n: number;
    };
    const last = this.db
      .prepare(
        "SELECT tokens_json, meta_json FROM calls WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(sessionId) as { tokens_json: string; meta_json: string } | undefined;
    let context: CallUsage["context"] = null;
    if (last) {
      const t = JSON.parse(last.tokens_json) as CallTokens;
      const used = t.system + t.tools + t.history + t.current + t.out;
      context = {
        used,
        window: (JSON.parse(last.meta_json) as CallMeta).window,
        system: t.system,
        tools: t.tools,
        messages: used - t.system - t.tools,
      };
    }
    return {
      turns: a.turns,
      steps: a.steps,
      tokensPerSecond:
        a.real_out > 0 && a.real_ms > 0
          ? Math.round((a.real_out / a.real_ms) * 1000 * 10) / 10
          : null,
      modelMs: a.ms,
      // 工具耗时是逐次调用累计的求和：只要有一条记录缺计时数据（升级前的旧记录），
      // 总和就不完整，此时返回 null 而不是偏小的数。
      toolMs:
        a.tool_n > 0 && a.tool_n === a.steps ? Math.round(a.tool_ms) : null,
      // TTFT 是平均：只在测到首 token 的调用之间取平均，没测到就是 null。
      ttftMs: a.ttft_n > 0 ? Math.round(a.ttft_sum / a.ttft_n) : null,
      tokens: {
        input: a.input,
        output: a.output,
        cacheRead: a.cache_read,
        cacheWrite: a.cache_write,
      },
      cacheHitRate: a.input > 0 ? a.cache_read / a.input : null,
      context,
    };
  }

  // 一次运行（轮）的累计用量与步数；turns 是会话至今的轮数。口径同 usage()：input 含缓存读写。
  runUsage(
    sessionId: string,
    runId: string,
  ): {
    tokens: CallUsage["tokens"];
    steps: number;
    turns: number;
  } {
    const j = (k: string) => `json_extract(tokens_json, '$.${k}')`;
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS steps,
                COALESCE(SUM(${j("system")} + ${j("tools")} + ${j("history")} + ${j("current")}), 0) AS input,
                COALESCE(SUM(${j("out")}), 0) AS output,
                COALESCE(SUM(${j("cacheRead")}), 0) AS cache_read,
                COALESCE(SUM(${j("cacheWrite")}), 0) AS cache_write
         FROM calls WHERE session_id = ? AND run_id = ?`,
      )
      .get(sessionId, runId) as {
      steps: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
    };
    const { turns } = this.db
      .prepare(
        "SELECT COUNT(DISTINCT run_id) AS turns FROM calls WHERE session_id = ?",
      )
      .get(sessionId) as { turns: number };
    return {
      tokens: {
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheWrite: r.cache_write,
      },
      steps: r.steps,
      turns,
    };
  }

  // 会话被删除时一并清掉它的调用记录与最新请求（记录本身从不修改）。
  removeSession(sessionId: string): void {
    this.db.prepare("DELETE FROM calls WHERE session_id = ?").run(sessionId);
    this.db
      .prepare("DELETE FROM latest_request WHERE session_id = ?")
      .run(sessionId);
  }
}
