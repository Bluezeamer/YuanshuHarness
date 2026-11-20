// 会话列表的推送流：快照 + 增删改事件，取代前端左轨轮询。认证由注册它的 /api/v1 作用域统一施加（含 WS 升级）。
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { uuidv7 } from "../id.js";
import type { FeedEvent, SessionFeed } from "../session/session-feed.js";
import { failIfOverloaded, isPing, startHeartbeat } from "./lib/ws.js";
import { DEFAULTS } from "./sessions.js";

const OPEN = 1;
const VIEWING_MAX = 200;

export async function libraryStreamApi(
  app: FastifyInstance,
  opts: {
    feed: SessionFeed;
    pingIntervalMs?: number;
    pongTimeoutMs?: number;
    maxBufferedBytes?: number;
  },
): Promise<void> {
  const { feed } = opts;
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULTS.pingIntervalMs;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULTS.pongTimeoutMs;
  const maxBuffered = opts.maxBufferedBytes ?? DEFAULTS.maxBufferedBytes;

  app.get(
    "/api/v1/library/stream",
    { websocket: true },
    (socket: WebSocket) => {
      const connectionId = uuidv7();
      let seq = 0;
      let closed = false;

      const send = (type: string, data: unknown): void => {
        if (closed || socket.readyState !== OPEN) return;
        const frame = JSON.stringify({ seq: ++seq, type, data });
        // 慢客户端：静默丢弃会让它的列表停在旧状态，按既有做法断开，重连即回快照。
        failIfOverloaded(socket, Buffer.byteLength(frame), maxBuffered, true);
        socket.send(frame);
      };

      // 先订阅再取快照，中间的变更先缓存，快照之后再按序补发：一条事件都不丢。
      const buffered: FeedEvent[] = [];
      let snapshotting = true;
      const unsubscribe = feed.subscribe((e) => {
        if (snapshotting) buffered.push(e);
        else send(e.type, e.data);
      });

      const stopHeartbeat = startHeartbeat(
        socket,
        pingIntervalMs,
        pongTimeoutMs,
      );
      socket.on("close", () => {
        closed = true;
        stopHeartbeat();
        unsubscribe();
        feed.dropViewer(connectionId);
      });

      try {
        send("snapshot", { sessions: feed.snapshot() });
        snapshotting = false;
        for (const e of buffered.splice(0)) send(e.type, e.data);
      } catch {
        // 首帧就触发背压：连接已被关闭，清理走 close 事件。
      }

      socket.on("message", (raw: RawData, isBinary: boolean) => {
        if (isPing(raw, isBinary)) return send("pong", {});
        const ids = parseViewing(raw, isBinary);
        // 不合法的消息直接忽略，连接继续可用。
        if (ids !== null) feed.setViewing(connectionId, ids);
      });
    },
  );
}

// 「我在看这些会话」：整份替换。不是字符串数组、超过 200 个都当无效消息。
function parseViewing(raw: RawData, isBinary: boolean): string[] | null {
  if (isBinary) return null;
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const msg = parsed as { type?: unknown; sessionIds?: unknown };
    if (msg.type !== "viewing" || !Array.isArray(msg.sessionIds)) return null;
    if (msg.sessionIds.length > VIEWING_MAX) return null;
    return msg.sessionIds.every((id) => typeof id === "string")
      ? (msg.sessionIds as string[])
      : null;
  } catch {
    return null;
  }
}
