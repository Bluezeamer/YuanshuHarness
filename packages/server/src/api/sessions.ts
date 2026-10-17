import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  type ImageInput,
  PoolError,
  type SessionEntry,
  type SessionPool,
} from "../session/pool.js";

export interface SessionsApiOptions {
  pool: SessionPool | null;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  maxBufferedBytes: number;
  maxPendingBytes: number;
}

export const DEFAULTS = {
  pingIntervalMs: 30_000,
  pongTimeoutMs: 10_000,
  maxBufferedBytes: 4 * 1024 * 1024,
  maxPendingBytes: 50 * 1024 * 1024,
  maxPayloadBytes: 50 * 1024 * 1024,
};

type AckError = { code: string; message: string };

const OPEN = 1;
const MAX_IMAGES = 20;
const rawSize = (raw: RawData): number =>
  Array.isArray(raw)
    ? raw.reduce((n, b) => n + b.length, 0)
    : "byteLength" in raw
      ? raw.byteLength
      : 0;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseImages(value: unknown): ImageInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return null;
  const out: ImageInput[] = [];
  for (const v of value) {
    const i = v as { mimeType?: unknown; data?: unknown } | null;
    if (
      !i ||
      typeof i.mimeType !== "string" ||
      !i.mimeType.startsWith("image/") ||
      typeof i.data !== "string" ||
      i.data.length % 4 !== 0 ||
      !BASE64.test(i.data)
    )
      return null;
    out.push({ mimeType: i.mimeType, data: i.data });
  }
  return out;
}

export async function sessionsApi(
  app: FastifyInstance,
  opts: SessionsApiOptions,
): Promise<void> {
  const { pool } = opts;
  const sockets = new Set<WebSocket>();

  app.post("/api/v1/sessions", async (_req, reply) => {
    if (!pool) {
      return reply.code(501).send({ error: "no_session_backend" });
    }
    try {
      const info = await pool.create();
      return reply.code(201).send({ id: info.id, createdAt: info.createdAt });
    } catch (err) {
      if (err instanceof PoolError)
        return reply.code(503).send({ error: err.code });
      app.log.error({ err }, "创建会话失败");
      return reply.code(500).send({ error: "session_create_failed" });
    }
  });

  app.get("/api/v1/sessions", async () => ({ sessions: pool?.list() ?? [] }));

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id",
    async (req, reply) => {
      const entry = pool?.get(req.params.id);
      if (!entry) return reply.code(404).send({ error: "not_found" });
      return entry.info;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/stream",
    {
      websocket: true,
      // 升级之前拒绝：不存在的会话得到普通 404，而不是先握手再关闭。
      preValidation: async (req, reply) => {
        if (!pool?.get(req.params.id))
          return reply.code(404).send({ error: "not_found" });
      },
    },
    (socket, req) => {
      const entry = pool?.get(req.params.id);
      if (!entry) {
        socket.close(1008, "not_found");
        return;
      }
      serve(socket, entry);
    },
  );

  function serve(socket: WebSocket, entry: SessionEntry): void {
    sockets.add(socket);
    let pongTimer: NodeJS.Timeout | undefined;

    const writeRaw = (text: string): void => {
      if (socket.readyState !== OPEN) throw new Error("socket closed");
      // 硬上限：已排队的加上这一帧不得超过阈值，超过则不入队、直接断开，
      // 内存因此有界；重连后会拿到新快照。
      if (
        socket.bufferedAmount + Buffer.byteLength(text) >
        opts.maxBufferedBytes
      ) {
        socket.close(1013, "backpressure");
        throw new Error("backpressure");
      }
      socket.send(text);
    };
    const subscriber = { send: writeRaw };
    const unsubscribe = entry.subscribe(subscriber);

    const ack = (id: unknown, error?: AckError): void => {
      const frame = error
        ? { type: "ack", ...(id === undefined ? {} : { id }), ok: false, error }
        : { type: "ack", id, ok: true };
      try {
        writeRaw(JSON.stringify(frame));
      } catch {
        // 连接已不可写，命令的效果仍然保留。
      }
    };

    const ping = setInterval(() => {
      if (socket.readyState !== OPEN) return;
      socket.ping();
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => socket.terminate(), opts.pongTimeoutMs);
    }, opts.pingIntervalMs);
    socket.on("pong", () => clearTimeout(pongTimer));

    socket.on("close", () => {
      clearInterval(ping);
      clearTimeout(pongTimer);
      unsubscribe();
      sockets.delete(socket);
    });

    // 同一连接的命令严格按到达顺序执行：stop 未完成时，后到的 send_message 不得抢先。
    let chain: Promise<void> = Promise.resolve();
    // 已收到但尚未处理完的字节数；超限说明客户端发得比处理得快，断开而不是无界缓存。
    let pending = 0;
    socket.on("message", (raw: RawData, isBinary: boolean) => {
      const size = rawSize(raw);
      pending += size;
      if (pending > opts.maxPendingBytes) {
        socket.close(1013, "overloaded");
        return;
      }
      chain = chain.then(async () => {
        try {
          if (socket.readyState === OPEN) await handle(raw, isBinary);
        } finally {
          pending -= size;
        }
      });
    });

    async function handle(raw: RawData, isBinary: boolean): Promise<void> {
      let msg: Record<string, unknown>;
      try {
        if (isBinary) throw new Error("binary");
        const parsed: unknown = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
        msg = parsed as Record<string, unknown>;
      } catch {
        return ack(undefined, {
          code: "bad_request",
          message: "消息必须是 JSON 对象文本",
        });
      }
      const { id, type } = msg;
      if (typeof id !== "string" || id === "")
        return ack(undefined, { code: "bad_request", message: "缺少 id" });
      try {
        switch (type) {
          case "send_message": {
            const images = parseImages(msg.images);
            if (typeof msg.text !== "string" || images === null)
              return ack(id, {
                code: "bad_request",
                message:
                  "text 必须是字符串，images 必须是 {mimeType, data} 数组",
              });
            entry.send(msg.text, images);
            return ack(id);
          }
          case "stop":
            await entry.stop();
            return ack(id);
          case "resync":
            entry.resync(subscriber);
            return ack(id);
          default:
            return ack(id, {
              code: "unknown_command",
              message: `未知命令：${String(type)}`,
            });
        }
      } catch (err) {
        if (err instanceof PoolError)
          return ack(id, { code: err.code, message: err.message });
        app.log.error({ err }, "命令执行失败");
        return ack(id, { code: "internal", message: "内部错误" });
      }
    }
  }

  // 停止时先断开全部连接，再释放全部会话，最后才轮到 HTTP 服务关闭。
  app.addHook("preClose", async () => {
    const open = [...sockets];
    const closed = open.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (s.readyState === 3) return resolve();
          s.once("close", () => resolve());
          s.close(1001, "server_shutdown");
          // 对端不配合关闭握手时不能让 stop() 一直等下去。
          setTimeout(() => s.terminate(), 1000).unref();
        }),
    );
    pool?.dispose();
    await Promise.all(closed);
  });
}
