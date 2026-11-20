import type { FastifyInstance } from "fastify";
import type { SessionLibrary } from "../session/library.js";
import { PoolError, type SessionPool } from "../session/pool.js";
import { libraryError } from "./session-library.js";

const entryIdOf = (body: unknown): string | null => {
  const v = (body as { entryId?: unknown } | null)?.entryId;
  return typeof v === "string" && v !== "" ? v : null;
};

// B20 历史节点回退（树 / 指令列表 / 导航）与 P09 复制会话分叉。
export function registerSessionTree(
  app: FastifyInstance,
  pool: SessionPool,
  library: SessionLibrary,
): void {
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/tree",
    async (req, reply) => {
      try {
        const tree = pool.sessionTree(req.params.id);
        return tree ?? reply.code(404).send({ error: "not_found" });
      } catch (err) {
        return libraryError(app, err, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/user-messages",
    async (req, reply) => {
      try {
        const messages = pool.userMessages(req.params.id);
        return messages
          ? { messages }
          : reply.code(404).send({ error: "not_found" });
      } catch (err) {
        return libraryError(app, err, reply);
      }
    },
  );

  // 运行中 / 压缩中不能回退；成功后客户端会额外收到一帧完整快照。
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/sessions/:id/navigate",
    async (req, reply) => {
      const entryId = entryIdOf(req.body);
      if (entryId === null)
        return reply.code(400).send({ error: "bad_request" });
      try {
        const result = await pool.navigate(req.params.id, entryId);
        return result ?? reply.code(404).send({ error: "not_found" });
      } catch (err) {
        if (err instanceof PoolError && err.code === "session_running")
          return reply.code(409).send({ error: "session_running" });
        return libraryError(app, err, reply);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/sessions/:id/fork",
    async (req, reply) => {
      const entryId = entryIdOf(req.body);
      if (entryId === null)
        return reply.code(400).send({ error: "bad_request" });
      try {
        return reply.code(201).send(await library.fork(req.params.id, entryId));
      } catch (err) {
        return libraryError(app, err, reply);
      }
    },
  );
}
