import { ClientError } from "./http.js";
import type { Frame } from "./render.js";

export interface Ack {
  id?: string;
  ok: boolean;
  error?: { code?: string; message?: string };
}

export interface StreamHandlers {
  // 已通过序号校验、按序到达的帧（含快照）。
  onFrame(frame: Frame): void;
  onAck(ack: Ack): void;
  // 连接被对端关闭或出错。自己调用 close() 不触发。
  onClose(code: number, reason: string): void;
  // 协议违例（首帧不是快照、帧无法解析）。之后连接已被关闭。
  onProtocolError(message: string): void;
}

const SUBPROTOCOL = "yuanshu.v1";

// 序号校验：只在收到 snapshot 时重置期望值；发出 resync 后丢弃一切实时帧，直到新快照到达。
export class Stream {
  private expected: number | null = null;
  private waitingSnapshot = false;
  private closing = false;
  private n = 0;

  private constructor(
    private readonly ws: WebSocket,
    private readonly h: StreamHandlers,
  ) {
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", (ev) => {
      if (!this.closing) h.onClose(ev.code, ev.reason);
    });
  }

  static open(
    httpUrl: string,
    path: string,
    token: string | null,
    handlers: StreamHandlers,
  ): Promise<Stream> {
    const url = httpUrl.replace(/\/$/, "").replace(/^http/, "ws") + path;
    const ws = new WebSocket(
      url,
      token ? [SUBPROTOCOL, `bearer.${token}`] : [SUBPROTOCOL],
    );
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Stream(ws, handlers)), {
        once: true,
      });
      // 升级被拒时拿不到状态码与原因，调用方应已做过 HTTP 预检。
      ws.addEventListener(
        "error",
        () => reject(new ClientError(`无法建立连接：${url}`)),
        { once: true },
      );
    });
  }

  command(type: string, extra: Record<string, unknown> = {}): string {
    const id = `c${++this.n}`;
    this.ws.send(JSON.stringify({ id, type, ...extra }));
    return id;
  }

  close(): void {
    this.closing = true;
    this.ws.close();
  }

  private fail(message: string): void {
    this.closing = true;
    this.ws.close();
    this.h.onProtocolError(message);
  }

  private onMessage(data: unknown): void {
    if (this.closing) return;
    let msg: Record<string, unknown>;
    try {
      if (typeof data !== "string") throw new Error("not text");
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.fail("收到无法解析的消息");
      return;
    }
    if (msg.type === "ack") {
      this.h.onAck(msg as unknown as Ack);
      return;
    }

    const frame = msg as unknown as Frame;
    if (frame.type === "snapshot") {
      this.expected = frame.seq + 1;
      this.waitingSnapshot = false;
      this.h.onFrame(frame);
      return;
    }
    if (this.expected === null) {
      this.fail(`第一帧应为 snapshot，实际为 ${String(frame.type)}`);
      return;
    }
    if (this.waitingSnapshot) return;
    if (frame.seq !== this.expected) {
      this.waitingSnapshot = true;
      this.command("resync");
      return;
    }
    this.expected = frame.seq + 1;
    this.h.onFrame(frame);
  }
}
