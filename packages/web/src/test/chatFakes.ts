// 对话数据层测试夹具（只被 *.test.* 引用）：假 WebSocket、帧构造、历史与用量相关的假 REST。
import { vi } from "vitest";
import type { ChatEntry, CompactionAnchor } from "../api";

type Listener = (ev: { data?: unknown }) => void;

export class FakeWS {
  static all: FakeWS[] = [];
  static get last(): FakeWS {
    const w = FakeWS.all[FakeWS.all.length - 1];
    if (!w) throw new Error("还没有创建过 WebSocket");
    return w;
  }

  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  private ls: Record<string, Listener[]> = {};

  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeWS.all.push(this);
  }

  addEventListener(t: string, fn: Listener) {
    this.ls[t] = [...(this.ls[t] ?? []), fn];
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  private fire(t: string, ev: { data?: unknown } = {}) {
    for (const fn of this.ls[t] ?? []) fn(ev);
  }

  serve(o: unknown) {
    this.readyState = 1;
    this.fire("message", { data: JSON.stringify(o) });
  }
  // 对端断开：浏览器只触发 close。
  drop() {
    this.readyState = 3;
    this.fire("close");
  }
  // 发出的命令里某一类型的全部消息。
  commands(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

export const msgs = (from: number, to: number): ChatEntry[] =>
  Array.from({ length: to - from }, (_, i) => ({
    index: from + i,
    role: (from + i) % 2 === 0 ? "user" : "assistant",
    text: `m${from + i}`,
  }));

export const compactionAnchor = (
  afterIndex: number,
  seq: number,
  over: Partial<CompactionAnchor> = {},
): CompactionAnchor => ({
  afterIndex,
  seq,
  summary: `压缩摘要 ${seq}`,
  tokensBefore: 4096,
  createdAt: "2026-10-25T10:00:00.000Z",
  ...over,
});

// 帧的外壳与 session/pool.ts 的 frame() 一致。
export const frame = (seq: number, type: string, data: object = {}) => ({
  session: "s1",
  seq,
  ts: "2026-10-18T00:00:00.000Z",
  type,
  data,
});

// 快照的 data 与 pool.ts 的 snapshotFrame() 一致：窗口固定最近 50 条，另带窗口起点 startIndex。
export const snapshot = (
  seq: number,
  history: ChatEntry[],
  extra: Record<string, unknown> = {},
) => {
  const start = Math.max(0, history.length - 50);
  return frame(seq, "snapshot", {
    messages: history
      .slice(start)
      .map(({ role, text, ts, blocks, attachments }) => ({
        role,
        text,
        ...(ts ? { ts } : {}),
        ...(blocks ? { blocks } : {}),
        ...(attachments ? { attachments } : {}),
      })),
    startIndex: start,
    running: false,
    activeTools: [],
    partial: null,
    queue: [],
    ...extra,
  });
};

export const ack = (
  id: string,
  ok = true,
  code?: string,
  message?: string,
) => ({
  type: "ack",
  id,
  ok,
  ...(ok ? {} : { error: { code, message } }),
});

export interface ChatApi {
  history: ChatEntry[];
  // /sessions 探测的状态码或网络错误。
  sessions: number | "network";
  retryAfter?: string;
  messages: number | "network" | "garbage" | "shape";
  // 带游标 / 不带游标的 messages 请求等它完成才响应。
  pause: Promise<void> | null;
  tailPause: Promise<void> | null;
  // /usage 与 /calls?limit=1 的响应体；null 表示 404。
  usage: object | null;
  calls: object[] | null;
  // messages 响应里带的压缩边界锚点；默认没有。
  compactions: CompactionAnchor[];
  requests: string[];
  tokens: (string | null)[];
}

const cursor = (n: number) => btoa(String(n)).replace(/=+$/, "");

// 分页语义与 store/history.ts 的 pageMessages 一致：游标是严格上界。
export function installChatApi(history: ChatEntry[] = []): ChatApi {
  const api: ChatApi = {
    history,
    sessions: 200,
    messages: 200,
    pause: null,
    tailPause: null,
    usage: null,
    calls: null,
    compactions: [],
    requests: [],
    tokens: [],
  };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    api.requests.push(input);
    api.tokens.push(new Headers(init?.headers).get("Authorization"));
    const reply = (status: number, body: object, headers?: HeadersInit) =>
      new Response(JSON.stringify(body), { status, headers });

    if (input === "/api/v1/sessions") {
      if (api.sessions === "network") throw new TypeError("network");
      const headers: Record<string, string> = {};
      if (api.retryAfter) headers["Retry-After"] = api.retryAfter;
      return reply(api.sessions, { sessions: [] }, headers);
    }
    if (input.endsWith("/usage"))
      return api.usage ? reply(200, api.usage) : reply(404, {});
    if (input.includes("/calls"))
      return api.calls
        ? reply(200, { calls: api.calls, nextBefore: null })
        : reply(404, {});

    if (api.messages === "network") throw new TypeError("network");
    if (api.messages === "garbage")
      return new Response("<html>", { status: 200 });
    if (api.messages === "shape") return reply(200, { ok: true });
    if (api.messages !== 200) return reply(api.messages, {});
    const q = new URLSearchParams(input.split("?")[1]);
    const limit = Number(q.get("limit") ?? 50);
    const before = q.get("before");
    if (before && api.pause) await api.pause;
    if (!before && api.tailPause) await api.tailPause;
    const end = before ? Number(atob(before)) : api.history.length;
    const start = Math.max(0, end - limit);
    return reply(200, {
      messages: api.history.slice(start, end),
      nextBefore: start > 0 ? cursor(start) : null,
      compactions: api.compactions,
    });
  });
  return api;
}
