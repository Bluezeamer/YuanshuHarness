import { randomBytes } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  boundStrings,
  type ChatMessage,
  EVENT_STRING_MAX,
  mapEvent,
  SNAPSHOT_MESSAGE_MAX,
} from "./events.js";

export type SessionFactory = () => Promise<AgentSession>;

export interface Subscriber {
  // 收到的是已序列化的一帧；抛错表示该订阅者已不可用，会被移除。
  send(frame: string): void;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  running: boolean;
}

export interface ImageInput {
  mimeType: string;
  data: string;
}

export class PoolError extends Error {
  constructor(
    readonly code: "bad_request" | "disposed",
    message: string,
  ) {
    super(message);
  }
}

const WINDOW = 50;

// UUIDv7：48 位毫秒时间戳加随机位。客户端当不透明字符串用。
function uuidv7(): string {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x70, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export class SessionEntry {
  readonly id = uuidv7();
  readonly createdAt = new Date().toISOString();
  running = false;

  private seq = 0;
  private readonly subscribers = new Set<Subscriber>();
  // 快照里的一切都由同一条事件流推出，所以快照与 seq 天然一致。
  private readonly recent: ChatMessage[] = [];
  private partial: ChatMessage | null = null;
  private readonly activeTools = new Map<string, string>();
  private queue: string[] = [];
  private runError: string | undefined;
  private readonly unsubscribeSdk: () => void;
  private disposed = false;

  constructor(private readonly session: AgentSession) {
    this.unsubscribeSdk = session.subscribe((e) => {
      const mapped = mapEvent(e);
      if (!mapped) return;
      if (mapped.type === "run.started") {
        // 自动重试会反复 agent_start；一次运行只对外开始一次。
        if (this.running) return;
        this.running = true;
        this.runError = undefined;
      } else if (mapped.type === "message.ended" && e.type === "message_end") {
        const m = e.message as {
          role: string;
          stopReason?: string;
          errorMessage?: string;
        };
        if (m.role === "assistant")
          this.runError =
            m.stopReason === "error"
              ? (m.errorMessage ?? "模型调用失败")
              : undefined;
      } else if (mapped.type === "run.ended") {
        if (this.runError !== undefined)
          this.emit("run.failed", { message: this.runError });
        this.runError = undefined;
        this.running = false;
      }
      this.emit(mapped.type, mapped.data);
    });
  }

  get info(): SessionInfo {
    return { id: this.id, createdAt: this.createdAt, running: this.running };
  }

  // 先改状态，再分配序号并广播：序号 N 的快照就是事件 N 之后的状态。
  private emit(type: string, raw: Record<string, unknown>): void {
    // 单个字符串超限就截断并标记：保证单帧有界，客户端需要全文时另行拉取。
    const b = boundStrings(raw, EVENT_STRING_MAX);
    const data = b.truncated ? { ...b.value, truncated: true } : b.value;
    this.apply(type, data);
    this.seq += 1;
    this.broadcast(this.frame(type, data));
  }

  private apply(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case "message.started":
        if (data.role === "assistant")
          this.partial = { role: "assistant", text: "" };
        break;
      case "message.delta":
        if (
          data.kind === "text" &&
          this.partial &&
          this.partial.text.length < EVENT_STRING_MAX
        )
          this.partial.text += String(data.text);
        break;
      case "message.ended":
        if (data.role === "assistant") this.partial = null;
        this.recent.push(data as unknown as ChatMessage);
        if (this.recent.length > WINDOW) this.recent.shift();
        break;
      case "tool.started":
        this.activeTools.set(String(data.toolCallId), String(data.toolName));
        break;
      case "tool.ended":
        this.activeTools.delete(String(data.toolCallId));
        break;
      case "queue.updated":
        this.queue = data.queue as string[];
        break;
      case "run.ended":
        this.partial = null;
        this.activeTools.clear();
        break;
    }
  }

  private frame(type: string, data: unknown): string {
    const base = {
      session: this.id,
      seq: this.seq,
      ts: new Date().toISOString(),
      type,
    };
    try {
      return JSON.stringify({ ...base, data });
    } catch {
      // 工具结果可能含循环引用或 bigint；序号不能因此跳过。
      return JSON.stringify({ ...base, data: { unserializable: true } });
    }
  }

  private broadcast(frame: string): void {
    for (const sub of [...this.subscribers]) {
      try {
        sub.send(frame);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  private snapshotFrame(): string {
    const messages = boundStrings(this.recent, SNAPSHOT_MESSAGE_MAX);
    const rest = boundStrings(
      { partial: this.partial, queue: this.queue },
      SNAPSHOT_MESSAGE_MAX,
    );
    return this.frame("snapshot", {
      messages: messages.value,
      ...(messages.truncated || rest.truncated ? { truncated: true } : {}),
      running: this.running,
      activeTools: [...this.activeTools].map(([toolCallId, toolName]) => ({
        toolCallId,
        toolName,
      })),
      partial: rest.value.partial,
      queue: rest.value.queue,
    });
  }

  // 整段同步：先发快照，再登记订阅，其间不会有事件插入。
  subscribe(sub: Subscriber): () => void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    sub.send(this.snapshotFrame());
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  resync(sub: Subscriber): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    sub.send(this.snapshotFrame());
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  // 返回时命令已被接受；整个运行是否成功由事件流告知。
  send(text: string, images: ImageInput[] = []): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    if (text.trim() === "") throw new PoolError("bad_request", "text 不能为空");
    // 模型不支持图片时 SDK 会把图片悄悄换成一句占位文字，必须在这里拒绝。
    if (images.length && !this.session.model?.input.includes("image"))
      throw new PoolError("bad_request", "当前模型不支持图片输入");
    this.session
      .prompt(text, {
        streamingBehavior: "steer",
        ...(images.length
          ? { images: images.map((i) => ({ type: "image" as const, ...i })) }
          : {}),
      })
      .catch((err) => this.emit("run.failed", { message: reason(err) }));
  }

  async stop(): Promise<void> {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    await this.session.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeSdk();
    this.subscribers.clear();
    this.session.dispose();
  }
}

export class SessionPool {
  private readonly entries = new Map<string, SessionEntry>();
  private disposed = false;

  constructor(private readonly factory: SessionFactory) {}

  async create(): Promise<SessionInfo> {
    if (this.disposed) throw new PoolError("disposed", "会话池已关闭");
    const session = await this.factory();
    if (this.disposed) {
      session.dispose();
      throw new PoolError("disposed", "会话池已关闭");
    }
    const entry = new SessionEntry(session);
    this.entries.set(entry.id, entry);
    return entry.info;
  }

  get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  list(): SessionInfo[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) e.dispose();
    this.entries.clear();
  }
}
