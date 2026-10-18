import type { Frame } from "./conversation";

export interface Ack {
  id?: string;
  ok: boolean;
  error?: { code?: string; message?: string };
}

export interface StreamHandlers {
  onFrame(frame: Frame): void;
  onAck(ack: Ack): void;
  // 对端关闭或出错；自己调用 close() 不触发。
  onClose(): void;
  // 首帧不是快照、帧无法解析。之后连接已被关闭。
  onProtocolError(message: string): void;
}

const SUBPROTOCOL = "yuanshu.v1";

export const streamUrl = (id: string): string => {
  const base = new URL(
    `/api/v1/sessions/${encodeURIComponent(id)}/stream`,
    location.href,
  );
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return base.toString();
};

// 浏览器 WebSocket 不能设请求头，令牌走第二个子协议（ADR-0026）。
// 序号只在收到快照时重置；发出 resync 后丢弃一切实时帧，直到新快照到达。
export class Stream {
  private expected: number | null = null;
  private waitingSnapshot = false;
  private closing = false;
  private n = 0;
  private readonly ws: WebSocket;

  constructor(
    url: string,
    token: string | null,
    private readonly h: StreamHandlers,
    WS: typeof WebSocket = WebSocket,
  ) {
    this.ws = new WS(
      url,
      token ? [SUBPROTOCOL, `bearer.${token}`] : [SUBPROTOCOL],
    );
    this.ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    // 握手失败时浏览器先发 error 再发 close，只能通知一次。
    const ended = () => {
      if (this.closing) return;
      this.closing = true;
      h.onClose();
    };
    this.ws.addEventListener("close", ended);
    this.ws.addEventListener("error", ended);
  }

  get ready(): boolean {
    return !this.closing && this.ws.readyState === 1;
  }

  command(type: string, extra: Record<string, unknown> = {}): string | null {
    if (!this.ready) return null;
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
