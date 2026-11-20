// 后台任务接口：给界面的列表、详情、日志跟随（尾部 + 增量）与停止。调用者是用户本人，
// 不走 agent 权限档位；停止记审计。
import type { FastifyInstance } from "fastify";
import type { JobManager } from "../job/manager.js";
import type { SessionPool } from "../session/pool.js";
import type { AuditLog } from "../store/audit.js";
import { bad } from "./lib/reply.js";

const isOffset = (v: string | undefined): v is string =>
  v !== undefined && /^(0|[1-9][0-9]*)$/.test(v);

export async function jobsApi(
  app: FastifyInstance,
  opts: { jobs: JobManager; pool: SessionPool; audit: AuditLog },
): Promise<void> {
  const { jobs, pool, audit } = opts;

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/jobs",
    async (req, reply) => {
      if (!pool.info(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return { jobs: jobs.list(req.params.id) };
    },
  );

  // 任务详情：含完整命令 / 参数与子会话 id，界面的详情面板用。
  app.get<{ Params: { id: string } }>(
    "/api/v1/jobs/:id",
    async (req, reply) => {
      const row = jobs.get(req.params.id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      return { job: row };
    },
  );

  // 日志跟随：不给 from 取最后 256 KB，给了 from 就往后读一屏；next 是下次该传的 from。
  app.get<{ Params: { id: string }; Querystring: { from?: string } }>(
    "/api/v1/jobs/:id/log",
    async (req, reply) => {
      const row = jobs.get(req.params.id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      const raw = req.query.from;
      if (raw !== undefined && !isOffset(raw))
        return bad(reply, "bad_request", "from must be a non-negative integer");
      const chunk = jobs.readLog(
        row.id,
        raw === undefined ? undefined : Number(raw),
      );
      if (!chunk.missing && raw !== undefined && Number(raw) > chunk.size)
        return bad(reply, "bad_request", "from is past the end of the log");
      return {
        text: chunk.text,
        from: chunk.from,
        next: chunk.next,
        headCut: chunk.headCut,
        ended: row.state !== "running" && chunk.next === chunk.size,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/jobs/:id/stop",
    async (req, reply) => {
      const row = jobs.get(req.params.id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      const stopped = await jobs.stop(row.sessionId, row.id, "user");
      audit.record({
        sessionId: row.sessionId,
        actor: "user",
        kind: "tool",
        environmentId: "",
        summary: `stop job ${row.id}`,
        detail: { op: "job_stop", target: row.id },
      });
      return { stopped, job: jobs.get(row.id) };
    },
  );
}
