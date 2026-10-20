// 终端接口：POST 创建、WS 双向流、DELETE 关闭。认证由注册它的 /api/v1 作用域统一施加（含 WS 升级）。
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { EnvHub } from "../env/hub.js";
import { pathOf } from "../permission/paths.js";
import { auditSession } from "../store/audit.js";
import {
  type CloseReason,
  type Terminal,
  type TerminalClient,
  TerminalError,
  type TerminalManager,
} from "../terminal/manager.js";
import { DEFAULTS } from "./sessions.js";

const OPEN = 1;
const SIZE_MAX = 500;

const isSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= SIZE_MAX;

const HTTP_STATUS = {
  too_many_terminals: 429,
  pty_unavailable: 501,
  spawn_failed: 502,
} as const;

export async function terminalsApi(
  app: FastifyInstance,
  opts: {
    hub: EnvHub;
    manager: TerminalManager;
    pingIntervalMs?: number;
    pongTimeoutMs?: number;
    maxBufferedBytes?: number;
  },
): Promise<void> {
  const { hub, manager } = opts;
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULTS.pingIntervalMs;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULTS.pongTimeoutMs;
  const maxBuffered = opts.maxBufferedBytes ?? DEFAULTS.maxBufferedBytes;

  app.post<{
    Body: {
      environmentId?: unknown;
      cwd?: unknown;
      cols?: unknown;
      rows?: unknown;
      sessionId?: unknown;
    };
  }>("/api/v1/terminals", async (req, reply) => {
    const { environmentId, cwd, cols, rows, sessionId } = req.body ?? {};
    if (typeof environmentId !== "string" || !isSize(cols) || !isSize(rows))
      return reply.code(400).send({ error: "bad_request" });
    const env = hub.get(environmentId);
    if (!env) return reply.code(404).send({ error: "env_not_found" });
    if (cwd !== undefined) {
      const pm = pathOf(env);
      if (
        typeof cwd !== "string" ||
        cwd.length > 4096 ||
        cwd.includes("\0") ||
        !pm.isAbsolute(cwd)
      )
        return reply.code(400).send({ error: "invalid_path" });
      try {
        const st = await env.stat(cwd);
        if (!st) return reply.code(404).send({ error: "not_found" });
        if (!st.isDirectory)
          return reply.code(400).send({ error: "not_a_directory" });
      } catch (err) {
        return reply.code(502).send({
          error: "spawn_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      const t = await manager.create(env, {
        ...(cwd === undefined
          ? {}
          : { cwd: pathOf(env).resolve(cwd as string) }),
        cols,
        rows,
        sessionId: auditSession(sessionId),
      });
      return reply.code(201).send(t.info);
    } catch (err) {
      if (err instanceof TerminalError)
        return reply
          .code(HTTP_STATUS[err.code])
          .send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/terminals/:id",
    async (req, reply) => {
      if (!manager.destroy(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  // 关闭时结束全部终端（会通知并关闭各自的连接）。
  app.addHook("preClose", async () => {
    manager.closeAll();
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/terminals/:id/stream",
    {
      websocket: true,
      // 升级之前拒绝：不存在的终端得到普通 404，而不是先握手再关闭。
      preValidation: async (req, reply) => {
        if (!manager.get(req.params.id))
          return reply.code(404).send({ error: "not_found" });
      },
    },
    (socket, req) => {
      const t = manager.get(req.params.id);
      if (!t) {
        socket.close(1008, "not_found");
        return;
      }
      serve(socket, t);
    },
  );

  function serve(socket: WebSocket, t: Terminal): void {
    let pongTimer: NodeJS.Timeout | undefined;
    const sendText = (m: object) => socket.send(JSON.stringify(m));

    const client: TerminalClient = {
      send(chunk) {
        if (socket.readyState !== OPEN) throw new Error("socket closed");
        // 慢客户端不能让输出在内存里无界堆积；断开它，终端本身继续保留，重连即回放。
        if (socket.bufferedAmount + chunk.length > maxBuffered) {
          socket.close(1013, "backpressure");
          throw new Error("backpressure");
        }
        socket.send(chunk, { binary: true });
      },
      end(reason: CloseReason, exitCode) {
        if (socket.readyState !== OPEN) return;
        if (reason === "exit") sendText({ type: "exit", exitCode });
        socket.close(reason === "shutdown" ? 1001 : 1000, reason);
      },
    };

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
      t.detach(client);
    });

    // ready 与回放必须在同一个同步段内发出，之后的输出才不会与回放错序。
    sendText({
      type: "ready",
      id: t.info.id,
      cols: t.info.cols,
      rows: t.info.rows,
    });
    const replay = t.attach(client);
    if (replay.length > 0) socket.send(replay, { binary: true });

    socket.on("message", (raw: RawData, isBinary: boolean) => {
      let msg: Record<string, unknown>;
      try {
        if (isBinary) throw new Error("binary");
        const parsed: unknown = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
        msg = parsed as Record<string, unknown>;
      } catch {
        return sendText({ type: "error", message: "消息必须是 JSON 对象文本" });
      }
      if (msg.type === "input" && typeof msg.data === "string")
        return t.input(msg.data);
      if (msg.type === "resize" && isSize(msg.cols) && isSize(msg.rows))
        return t.resize(msg.cols, msg.rows);
      sendText({ type: "error", message: "未知消息或参数非法" });
    });
  }
}
