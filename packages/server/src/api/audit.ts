import type { FastifyInstance } from "fastify";
import { isObject, posInt } from "../lib/validate.js";
import {
  AUDIT_PAGE_MAX,
  AUDIT_SUMMARY_MAX,
  type AuditLog,
  type AuditQuery,
  auditSession,
} from "../store/audit.js";

const optStr = (v: unknown, max: number): string | null =>
  typeof v === "string" && v !== "" && v.length <= max ? v : null;

// 执行审计的查询；服务端各记录点直接调用 AuditLog，UI 侧动作（划选提问等）经 POST 上报。
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

  // 只收 ui 类：其余 kind 由服务端自己的记录点写，不能被客户端冒充。
  app.post("/api/v1/audit/events", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const summary = optStr(body.summary, AUDIT_SUMMARY_MAX);
    if (body.kind !== "ui" || summary === null)
      return reply.code(400).send({ error: "bad_request" });
    const detail = isObject(body.detail) ? body.detail : undefined;
    opts.audit.record({
      sessionId: auditSession(body.sessionId),
      actor: "user",
      kind: "ui",
      environmentId: optStr(body.environmentId, 100),
      summary,
      ...(detail ? { detail } : {}),
    });
    return reply.code(204).send();
  });
}
