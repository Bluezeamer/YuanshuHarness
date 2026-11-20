import type { FastifyInstance } from "fastify";
import type { SessionPool } from "../session/pool.js";

// 会话的 directory 清单：第 1 个是 local，其余是 remote。改清单走工作区路由。
export function sessionDirectoriesApi(
  app: FastifyInstance,
  opts: { pool: SessionPool },
): void {
  const { pool } = opts;
  const view = (id: string) => {
    const rows = pool.directoryRows(id);
    if (!rows) return null;
    return {
      directories: rows.map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        environmentId: w.environmentId,
        role: w.role,
        current: w.current,
      })),
    };
  };

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/directories",
    async (req, reply) => {
      const out = view(req.params.id);
      return out ?? reply.code(404).send({ error: "not_found" });
    },
  );
}
