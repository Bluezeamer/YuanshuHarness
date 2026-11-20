// 会话列表推送流：快照 + 增删改事件。
// 与服务端 packages/server/src/api/library-stream.ts 对应；重连即新快照，没有续传。

import { createProbe, onForeground } from "./foreground";
import { subprotocols, wsUrl } from "./http";
import type { LibrarySession } from "./sessionLibrary";

export type LibraryEvent =
  | { type: "snapshot"; sessions: LibrarySession[] }
  | { type: "added" | "updated"; session: LibrarySession }
  | { type: "removed"; id: string };

// 服务端偶尔把已有行再报一次 added，两种事件合并方式一致。
export function applyLibraryEvent(
  list: readonly LibrarySession[],
  e: LibraryEvent,
): readonly LibrarySession[] {
  if (e.type === "snapshot") return e.sessions;
  if (e.type === "removed") {
    const at = list.findIndex((s) => s.id === e.id);
    if (at < 0) return list;
    return [...list.slice(0, at), ...list.slice(at + 1)];
  }
  const at = list.findIndex((s) => s.id === e.session.id);
  if (at < 0) return [...list, e.session];
  if (list[at] === e.session) return list;
  const next = [...list];
  next[at] = e.session;
  return next;
}

export interface LibraryStreamHandlers {
  onEvent(e: LibraryEvent): void;
  /** 收到快照后 "live"；断开后 "reconnecting"（此时列表可能过期） */
  onStatus?(s: "live" | "reconnecting"): void;
}

const VIEWING_MAX = 200;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface Frame {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

// 集合比：顺序无关。
const viewingKey = (ids: readonly string[]): string =>
  [...new Set(ids)].sort().join("\n");

export class LibraryStream {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 期望的下一帧序号；null 表示这条连接还没收到快照 */
  private expected: number | null = null;
  private ended = true;
  private closed = false;
  private delay: number;
  private readonly maxDelay: number;
  private ids: readonly string[] = [];
  private sentViewing: string | null = null;
  private readonly offForeground = onForeground(() => this.resume());
  private readonly probe = createProbe(
    () => this.ping(),
    () => this.dead(),
  );

  constructor(
    private readonly token: string | null,
    private readonly h: LibraryStreamHandlers,
    private readonly opts: {
      WS?: typeof WebSocket;
      backoffMs?: [min: number, max: number];
    } = {},
  ) {
    this.delay = opts.backoffMs?.[0] ?? 1000;
    this.maxDelay = opts.backoffMs?.[1] ?? 15000;
    this.connect();
  }

  /** 整份替换「我在看」；还没收到快照时先记下，快照后补发。 */
  viewing(ids: readonly string[]): void {
    if (this.closed) return;
    this.ids = ids.slice(0, VIEWING_MAX);
    this.sendViewing();
  }

  close(): void {
    this.closed = true;
    this.ended = true;
    this.offForeground();
    this.probe.cancel();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private connect(): void {
    const WS = this.opts.WS ?? WebSocket;
    const ws = new WS(
      wsUrl("/api/v1/library/stream"),
      subprotocols(this.token),
    );
    this.ws = ws;
    this.expected = null;
    this.ended = false;
    ws.addEventListener("message", (ev: MessageEvent) =>
      this.onMessage(ev.data),
    );
    // 握手失败时浏览器先 error 再 close，只算一次断开；已被换掉的旧连接晚到的 close 不算。
    const end = () => {
      if (this.ws === ws) this.reconnect();
    };
    ws.addEventListener("close", end);
    ws.addEventListener("error", end);
  }

  private reconnect(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.expected = null;
    this.probe.cancel();
    // 新连接要等快照后才补发「我在看」。
    this.sentViewing = null;
    this.h.onStatus?.("reconnecting");
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, this.maxDelay);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.connect();
    }, wait);
  }

  // 协议错误：关掉这条连接，走同一条重连路径。
  private fail(): void {
    const ws = this.ws;
    this.reconnect();
    ws?.close();
  }

  // 回前台：在退避里等着的立即重连，已有快照的探一下还活不活；首次连接还在路上的不打断。
  private resume(): void {
    if (this.closed) return;
    if (this.ended) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.delay = this.opts.backoffMs?.[0] ?? 1000;
      this.connect();
    } else if (this.expected !== null) this.probe.start();
  }

  private ping(): boolean {
    const ws = this.ws;
    if (ws?.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: "ping" }));
    return true;
  }

  // 探针没有回音：连接已死，关掉并立即重连。
  private dead(): void {
    this.fail();
    this.resume();
  }

  private sendViewing(): void {
    if (this.closed || this.ended || this.expected === null) return;
    const ws = this.ws;
    if (ws?.readyState !== 1) return;
    const key = viewingKey(this.ids);
    if (key === this.sentViewing) return;
    this.sentViewing = key;
    ws.send(JSON.stringify({ type: "viewing", sessionIds: this.ids }));
  }

  private onMessage(raw: unknown): void {
    if (this.closed || this.ended) return;
    this.probe.settle();
    let frame: Frame;
    try {
      if (typeof raw !== "string") throw new Error("not text");
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) throw new Error("shape");
      if (typeof parsed.seq !== "number" || typeof parsed.type !== "string")
        throw new Error("shape");
      if (!isObject(parsed.data)) throw new Error("shape");
      frame = parsed as unknown as Frame;
    } catch {
      this.fail();
      return;
    }

    if (this.expected === null) {
      const sessions = frame.data.sessions;
      if (frame.type !== "snapshot" || !Array.isArray(sessions)) {
        this.fail();
        return;
      }
      this.expected = frame.seq + 1;
      this.delay = this.opts.backoffMs?.[0] ?? 1000;
      this.h.onStatus?.("live");
      this.h.onEvent({
        type: "snapshot",
        sessions: sessions as LibrarySession[],
      });
      this.sendViewing();
      return;
    }

    if (frame.seq !== this.expected) {
      this.fail();
      return;
    }
    this.expected = frame.seq + 1;
    // 线上的类型带 session. 前缀，对外简化成 added / updated / removed。
    const type = frame.type.replace(/^session\./, "");
    if (type === "added" || type === "updated") {
      const session = frame.data.session;
      if (!isObject(session)) {
        this.fail();
        return;
      }
      this.h.onEvent({
        type,
        session: session as unknown as LibrarySession,
      });
      return;
    }
    if (type === "removed") {
      const id = frame.data.id;
      if (typeof id !== "string") {
        this.fail();
        return;
      }
      this.h.onEvent({ type: "removed", id });
    }
  }
}
