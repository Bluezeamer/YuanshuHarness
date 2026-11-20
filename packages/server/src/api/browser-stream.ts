// 画面流的路由胶水：WS 升级、文本事件与 JPEG 帧、客户端消息交给中枢处理。
// 认证由注册它的 /api/v1 作用域统一施加（含 WS 升级）。
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { PageRegistry } from "../browser/pages/registry.js";
import type {
  Attachment,
  StreamEvent,
  StreamHub,
  Viewer,
} from "../browser/stream/index.js";
import { FrameWindow } from "./lib/frame-window.js";
import { notFound } from "./lib/reply.js";
import { startHeartbeat } from "./lib/ws.js";
import { DEFAULTS } from "./sessions.js";

const OPEN = 1;
// 已发出、客户端还没确认的画面字节上限：超了只留最新一帧，不堆积（陈旧的画面比丢帧更糟）；文本事件照发。
// 约一条 20Mbps、60ms 往返链路的带宽时延积，在路上的旧画面最多是这个量。
const FRAME_WINDOW_BYTES = 128 * 1024;

export async function browserStreamApi(
  app: FastifyInstance,
  opts: {
    hub: StreamHub;
    pages: Pick<PageRegistry, "get">;
    pingIntervalMs?: number;
    pongTimeoutMs?: number;
    /** 未确认的画面字节上限（仅测试用来把阈值调小）。 */
    frameWindowBytes?: number;
  },
): Promise<void> {
  const { hub, pages } = opts;
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULTS.pingIntervalMs;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULTS.pongTimeoutMs;
  const windowBytes = opts.frameWindowBytes ?? FRAME_WINDOW_BYTES;

  app.get<{ Params: { wid: string; pid: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/stream",
    {
      websocket: true,
      // 升级之前拒绝：页面不在、或不属于这个工作区，得到普通 404 而不是先握手再关闭。
      preValidation: async (req, reply) => {
        const page = pages.get(req.params.pid);
        if (!page || page.workspaceKey !== req.params.wid)
          return notFound(reply);
      },
    },
    (socket: WebSocket, req) => {
      // 文本事件照发，画面走发送窗口：慢客户端只影响自己的画面新鲜度。
      const frames = new FrameWindow((jpeg) => {
        if (socket.readyState === OPEN) socket.send(jpeg, { binary: true });
      }, windowBytes);
      const viewer: Viewer = {
        event: (e: StreamEvent) => {
          if (socket.readyState !== OPEN) return;
          socket.send(JSON.stringify(e));
          if (e.type === "closed") socket.close(1000, "closed");
        },
        frame: (jpeg: Buffer) => frames.push(jpeg),
      };

      const attachment: Attachment | null = hub.attach(req.params.pid, viewer);
      if (!attachment) {
        socket.close(1008, "not_found");
        return;
      }

      const stopHeartbeat = startHeartbeat(
        socket,
        pingIntervalMs,
        pongTimeoutMs,
      );
      socket.on("close", () => {
        stopHeartbeat();
        attachment.detach();
      });

      socket.on("message", (raw: RawData, isBinary: boolean) => {
        if (isBinary) {
          viewer.event({
            type: "error",
            message: "画面流只接受 JSON 文本消息，不接受二进制帧",
          });
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          viewer.event({ type: "error", message: "消息必须是 JSON 文本" });
          return;
        }
        // 帧确认与探活是连接层的事，不进中枢：中枢按顺序一条条处理，确认排在慢输入后面会把画面卡住。
        const type = (msg as { type?: unknown } | null)?.type;
        if (type === "ack") {
          frames.ack();
          return;
        }
        if (type === "ping") {
          viewer.event({ type: "pong" });
          return;
        }
        void attachment.handle(msg);
      });
    },
  );
}
