import type { FastifyInstance, FastifyReply } from "fastify";
import { posInt } from "../lib/validate.js";
import { messageCount } from "../session/call-tokens.js";
import type { SessionPool } from "../session/pool.js";
import {
  CALLS_PAGE_MAX,
  type CallStore,
  type SubCallSummary,
  type SubSession,
} from "../store/calls.js";
import {
  type CompactionDetail,
  type CompactionInfo,
  readCompactionDetails,
  readCompactions,
} from "../store/history.js";
import type { SubagentStore } from "../store/subagents.js";

// 子会话在审计里的名字：派发时的任务摘要（口径同右栏执行体的 name）。
const NAME_MAX = 40;
const nameOf = (task: string) => {
  const t = task.replace(/\s+/g, " ").trim();
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX)}…` : t;
};

/** 会话 JSONL 里的压缩条目，以及它的路径（详情重建快照时才再读文件）。 */
type AuditHistory = {
  file: { file: string; dir: string } | null;
  compactions: CompactionInfo[];
};

/**
 * 段号：最后一次压缩之后是尚未压缩的当前段（0）；更早的调用归属压住它那段历史的压缩序号（1..N）。
 * 归属只比 ISO 时间（calls.created_at 与 compaction.createdAt 同一个格式）。
 */
function segmentOf(
  compactions: readonly CompactionInfo[],
  createdAt: string,
): number {
  for (const c of compactions) if (c.createdAt > createdAt) return c.seq;
  return 0;
}

// 会话还没有 JSONL（空会话）时没有压缩；读文件失败按会话加载失败处理。
function historyOf(pool: SessionPool, sessionId: string): AuditHistory {
  const file = pool.sessionFile(sessionId);
  if (!file) return { file: null, compactions: [] };
  return {
    file,
    compactions: readCompactions(file.file, file.dir, sessionId),
  };
}

// 模型调用记录（审计页）与用量聚合（指标行）；与 /audit 的执行审计无关。
export async function callsApi(
  app: FastifyInstance,
  opts: { calls: CallStore; pool: SessionPool; subagents: SubagentStore },
): Promise<void> {
  const { calls, pool, subagents } = opts;

  const historyFailed = (err: unknown, reply: FastifyReply) => {
    app.log.error({ err }, "读取会话压缩记录失败");
    return reply.code(500).send({ error: "session_load_failed" });
  };

  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>("/api/v1/sessions/:id/calls", async (req, reply) => {
    const id = req.params.id;
    if (!pool.info(id)) return reply.code(404).send({ error: "not_found" });
    const { before, limit } = req.query;
    const q: { before?: number; limit?: number } = {};
    if (before !== undefined) {
      const n = posInt(before);
      if (n === null) return reply.code(400).send({ error: "invalid_before" });
      q.before = n;
    }
    if (limit !== undefined) {
      const n = posInt(limit, CALLS_PAGE_MAX);
      if (n === null) return reply.code(400).send({ error: "invalid_limit" });
      q.limit = n;
    }
    let compactions: CompactionInfo[];
    try {
      compactions = historyOf(pool, id).compactions;
    } catch (err) {
      return historyFailed(err, reply);
    }
    const page = calls.list(id, q);
    return {
      ...page,
      calls: page.calls.map((c) => ({
        ...c,
        segment: segmentOf(compactions, c.createdAt),
      })),
    };
  });

  // 该会话派发出的整棵子树（子、孙…）的调用。子代理的调用记在子会话名下，
  // 父会话的审计「子代理」档读这里；单条详情仍按子会话 id 走 /sessions/:childId/calls/:callId。
  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>("/api/v1/sessions/:id/subagent-calls", async (req, reply) => {
    if (!pool.info(req.params.id))
      return reply.code(404).send({ error: "not_found" });
    const { before, limit } = req.query;
    const q: { before?: string; limit?: number } = {};
    if (before !== undefined) {
      if (!/^[0-9a-f-]{36}$/.test(before))
        return reply.code(400).send({ error: "invalid_before" });
      q.before = before;
    }
    if (limit !== undefined) {
      const n = posInt(limit, CALLS_PAGE_MAX);
      if (n === null) return reply.code(400).send({ error: "invalid_limit" });
      q.limit = n;
    }
    const subs: SubSession[] = [];
    const queue = [req.params.id];
    for (let id = queue.shift(); id !== undefined; id = queue.shift())
      for (const c of subagents.children(id)) {
        subs.push({ id: c.childId, name: nameOf(c.task) });
        queue.push(c.childId);
      }
    const page = calls.listSubs(subs, q);
    // 段号是子会话自己的（每个子会话有自己的 JSONL 与压缩历史）。
    const cache = new Map<string, CompactionInfo[]>();
    const compactionsOf = (sessionId: string): CompactionInfo[] => {
      const hit = cache.get(sessionId);
      if (hit) return hit;
      const cs = historyOf(pool, sessionId).compactions;
      cache.set(sessionId, cs);
      return cs;
    };
    let items: Array<SubCallSummary & { segment: number }>;
    try {
      items = page.calls.map((c) => ({
        ...c,
        segment: segmentOf(compactionsOf(c.subagent.sessionId), c.createdAt),
      }));
    } catch (err) {
      return historyFailed(err, reply);
    }
    return { ...page, calls: items };
  });

  app.get<{ Params: { id: string; callId: string } }>(
    "/api/v1/sessions/:id/calls/:callId",
    async (req, reply) => {
      const id = req.params.id;
      if (!pool.info(id)) return reply.code(404).send({ error: "not_found" });
      const call = calls.get(id, req.params.callId);
      if (!call) return reply.code(404).send({ error: "not_found" });

      let history: AuditHistory;
      try {
        history = historyOf(pool, id);
      } catch (err) {
        return historyFailed(err, reply);
      }
      const segment = segmentOf(history.compactions, call.createdAt);
      const timeline = calls.timeline(id);
      const at = timeline.findIndex((p) => p.seq === call.seq);
      const next = at < 0 ? undefined : timeline[at + 1];
      // 区间右端：同段下一次调用的对话项数；本段最后一次到请求末尾。
      const endOf = (total: number) =>
        next !== undefined &&
        segmentOf(history.compactions, next.createdAt) === segment
          ? next.msgCount
          : total;

      let request: unknown = null;
      let snapshot = false;
      let range: { from: number; to: number } | null = null;
      if (segment === 0) {
        // 当前段：最新一次请求体就是这一段所有调用的公共上界。
        request = calls.latestRequest(id);
        if (request !== null) {
          const to = Math.max(call.msgCount, endOf(messageCount(request)));
          range = { from: call.msgCount, to };
        }
      } else if (history.file) {
        // 压缩段：从 JSONL 的压缩条目重建压缩前完整快照。
        let detail: CompactionDetail | undefined;
        try {
          detail = readCompactionDetails(
            history.file.file,
            history.file.dir,
            id,
          )[segment - 1];
        } catch (err) {
          return historyFailed(err, reply);
        }
        if (detail) {
          request = detail.snapshot;
          snapshot = true;
          const to = Math.max(call.msgCount, endOf(detail.messageCount));
          range = { from: call.msgCount, to };
        }
      }
      // 数据异常（历史被改写等）时右端可能落到起点之前，兜底成空区间，别让前端切出负数。
      return { ...call, segment, request, snapshot, range };
    },
  );

  // 压缩历史列表：seq 按时间 1..N；callSeqFrom/To 是这段历史里的调用序号范围。
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/compactions",
    async (req, reply) => {
      const id = req.params.id;
      if (!pool.info(id)) return reply.code(404).send({ error: "not_found" });
      let details: CompactionDetail[];
      const file = pool.sessionFile(id);
      try {
        details = file ? readCompactionDetails(file.file, file.dir, id) : [];
      } catch (err) {
        return historyFailed(err, reply);
      }
      const spans = new Map<number, { from: number; to: number }>();
      for (const p of calls.timeline(id)) {
        const seg = segmentOf(details, p.createdAt);
        if (seg === 0) continue;
        const span = spans.get(seg);
        if (span) span.to = p.seq;
        else spans.set(seg, { from: p.seq, to: p.seq });
      }
      return {
        compactions: details.map((d) => ({
          seq: d.seq,
          createdAt: d.createdAt,
          summary: d.summary,
          tokensBefore: d.tokensBefore,
          callSeqFrom: spans.get(d.seq)?.from ?? null,
          callSeqTo: spans.get(d.seq)?.to ?? null,
          messageCount: d.messageCount,
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/usage",
    async (req, reply) => {
      if (!pool.info(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return calls.usage(req.params.id);
    },
  );
}
