import type { FastifyInstance } from "fastify";
import {
  AUDIT_PAGE_MAX,
  type AuditLog,
  type AuditQuery,
} from "../store/audit.js";

const posInt = (v: string | undefined, max = Number.MAX_SAFE_INTEGER) =>
  v !== undefined && /^[1-9][0-9]*$/.test(v) && Number(v) <= max
    ? Number(v)
    : null;

// 执行审计的只读查询；写入由各记录点直接调用 AuditLog。
export async function auditApi(
  app: FastifyInstance,
  opts: { audit: AuditLog },
): Promise<void> {
  app.get<{
    Querystring: {
      session?: string;
      kind?: string;
      environment?: string;
      limit?: string;
      before?: string;
    };
  }>("/api/v1/audit", async (req, reply) => {
    const { session, kind, environment, limit, before } = req.query;
    const q: AuditQuery = {};
    if (session !== undefined) q.session = session;
    if (kind !== undefined) q.kind = kind;
    if (environment !== undefined) q.environment = environment;
    if (limit !== undefined) {
      const n = posInt(limit, AUDIT_PAGE_MAX);
      if (n === null) return reply.code(400).send({ error: "invalid_limit" });
      q.limit = n;
    }
    if (before !== undefined) {
      const n = posInt(before);
      if (n === null) return reply.code(400).send({ error: "invalid_before" });
      q.before = n;
    }
    return opts.audit.list(q);
  });
}
