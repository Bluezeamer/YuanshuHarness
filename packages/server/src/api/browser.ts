// 侧边浏览器接口（ADR-0081）：GET 状态、WS 旁观流（文本帧是状态 JSON，二进制帧是 JPEG 画面）、DELETE 关闭。
// 只读旁观：不接收任何输入，页面只由 agent 的工具驱动。认证由 /api/v1 作用域统一施加（含 WS 升级）。
import type { FastifyInstance } from "fastify";
import type { BrowserManager, BrowserSubscriber } from "../browser/manager.js";
import type { SessionPool } from "../session/pool.js";
import { DEFAULTS } from "./sessions.js";

const OPEN = 1;
// 慢客户端的画面直接丢，不堆积；状态是文本帧，不受影响。
const FRAME_BACKLOG_BYTES = 1024 * 1024;

export async function browserApi(
  app: FastifyInstance,
  opts: {
    manager: BrowserManager;
    pool: Pick<SessionPool, "info">;
    pingIntervalMs?: number;
    pongTimeoutMs?: number;
  },
): Promise<void> {
  const { manager, pool } = opts;
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULTS.pingIntervalMs;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULTS.pongTimeoutMs;

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/browser",
    async (req, reply) => {
      if (!pool.info(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return manager.state(req.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/browser",
    async (req, reply) => {
      if (!pool.info(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      await manager.release(req.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/browser/stream",
    {
      websocket: true,
      // 升级之前拒绝：不存在的会话得到普通 404。
      preValidation: async (req, reply) => {
        if (!pool.info(req.params.id))
          return reply.code(404).send({ error: "not_found" });
      },
    },
    (socket, req) => {
      let pongTimer: NodeJS.Timeout | undefined;
      const sub: BrowserSubscriber = {
        state: (s) => {
          if (socket.readyState === OPEN)
            socket.send(JSON.stringify({ type: "state", ...s }));
        },
        frame: (jpeg) => {
          if (
            socket.readyState === OPEN &&
            socket.bufferedAmount < FRAME_BACKLOG_BYTES
          )
            socket.send(jpeg, { binary: true });
        },
      };
      const unsubscribe = manager.subscribe(req.params.id, sub);

      const ping = setInterval(() => {
        if (socket.readyState !== OPEN) return;
        socket.ping();
        clearTimeout(pongTimer);
        pongTimer = setTimeout(() => socket.terminate(), pongTimeoutMs);
      }, pingIntervalMs);
      socket.on("pong", () => clearTimeout(pongTimer));
      socket.on("close", () => {
        clearInterval(ping);
        clearTimeout(pongTimer);
        unsubscribe();
      });
      // 旁观流不接收输入；收到什么都忽略。
      socket.on("message", () => {});
    },
  );
}
