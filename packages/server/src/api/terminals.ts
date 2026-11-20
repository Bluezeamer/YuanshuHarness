// 终端接口：POST 创建、GET 列表/详情、WS 双向流、DELETE 关闭。认证由注册它的 /api/v1 作用域统一施加（含 WS 升级）。
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { EnvHub } from "../env/hub.js";
import { pathOf } from "../permission/paths.js";
import { auditSession } from "../store/audit.js";
import type {
  CloseReason,
  Terminal,
  TerminalClient,
  TerminalManager,
} from "../terminal/manager.js";
import { toHttp } from "./lib/reply.js";
import { failIfOverloaded, startHeartbeat } from "./lib/ws.js";
import { DEFAULTS } from "./sessions.js";

const OPEN = 1;
const SIZE_MAX = 500;

const isSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= SIZE_MAX;

export async function terminalsApi(
  app: FastifyInstance,
  opts: {
    hub: EnvHub;
    manager: TerminalManager;
    // 校验 body 里的 workspaceId；缺省不校验。
    workspaceExists?: (id: string) => boolean;
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
      workspaceId?: unknown;
    };
  }>("/api/v1/terminals", async (req, reply) => {
    const { environmentId, cwd, cols, rows, sessionId, workspaceId } =
      req.body ?? {};
    if (typeof environmentId !== "string" || !isSize(cols) || !isSize(rows))
      return reply.code(400).send({ error: "bad_request" });
    const env = hub.get(environmentId);
    if (!env) return reply.code(404).send({ error: "env_not_found" });
    if (workspaceId !== undefined && typeof workspaceId !== "string")
      return reply.code(400).send({ error: "bad_request" });
    if (
      workspaceId !== undefined &&
      !(opts.workspaceExists?.(workspaceId) ?? true)
    )
      return reply.code(404).send({ error: "workspace_not_found" });
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
        ...(typeof workspaceId === "string" ? { workspaceId } : {}),
      });
      return reply.code(201).send(t.info);
    } catch (err) {
      return toHttp(reply, err);
    }
  });

  app.get("/api/v1/terminals", async () => ({
    terminals: manager.list().map((t) => t.status()),
  }));

  app.get<{ Params: { id: string } }>(
    "/api/v1/terminals/:id",
    async (req, reply) => {
      const t = manager.get(req.params.id);
      if (!t) return reply.code(404).send({ error: "not_found" });
      return t.status();
    },
  );

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
    const sendText = (m: object) => socket.send(JSON.stringify(m));

    // 积压过半先暂停 pty，降到四分之一再恢复；硬上限 maxBuffered 仍断开该客户端。
    let congested = false;
    function gauge(): void {
      const next =
        socket.bufferedAmount > (congested ? maxBuffered / 4 : maxBuffered / 2);
      if (next === congested) return;
      congested = next;
      t.congest(client, next);
    }

    const client: TerminalClient = {
      send(chunk) {
        if (socket.readyState !== OPEN) throw new Error("socket closed");
        // 慢客户端不能让输出在内存里无界堆积；断开它，终端本身继续保留，重连即回放。
        failIfOverloaded(socket, chunk.length, maxBuffered);
        socket.send(chunk, { binary: true }, gauge);
        gauge();
      },
      end(reason: CloseReason, exitCode) {
        if (socket.readyState !== OPEN) return;
        if (reason === "exit") sendText({ type: "exit", exitCode });
        socket.close(reason === "shutdown" ? 1001 : 1000, reason);
      },
    };

    const stopHeartbeat = startHeartbeat(socket, pingIntervalMs, pongTimeoutMs);
    socket.on("close", () => {
      stopHeartbeat();
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
