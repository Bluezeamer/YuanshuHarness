import type { FastifyInstance, FastifyReply } from "fastify";
import { LibraryError, type SessionLibrary } from "../session/library.js";
import { PoolError } from "../session/pool.js";

// 把动作里的业务错误翻成统一的 {error} 响应；其余错误原样抛出。
export function libraryError(
  app: FastifyInstance,
  err: unknown,
  reply: FastifyReply,
) {
  if (err instanceof LibraryError)
    return reply.code(err.status).send({ error: err.code });
  if (err instanceof PoolError && err.code === "bad_request")
    return reply.code(400).send({ error: "bad_request" });
  if (err instanceof PoolError && err.code === "load_failed") {
    app.log.error({ err }, "加载会话失败");
    return reply.code(500).send({ error: "session_load_failed" });
  }
  if (err instanceof PoolError)
    return reply.code(503).send({ error: err.code });
  throw err;
}

// 会话生命周期动作；GET /sessions 与 PATCH /sessions/:id 在 sessions.ts 里复用同一个 library。
export function registerSessionLibrary(
  app: FastifyInstance,
  library: SessionLibrary,
): void {
  for (const action of ["archive", "unarchive"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/sessions/:id/${action}`,
      async (req, reply) => {
        try {
          return library[action](req.params.id);
        } catch (err) {
          return libraryError(app, err, reply);
        }
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/refresh-context",
    async (req, reply) => {
      try {
        return await library.refreshContext(req.params.id);
      } catch (err) {
        return libraryError(app, err, reply);
      }
    },
  );
}
