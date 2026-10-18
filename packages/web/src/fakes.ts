import { vi } from "vitest";
import type { ChatEntry } from "./api";

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
  // 握手失败：浏览器先触发 error 再触发 close。
  failConnect() {
    this.readyState = 3;
    this.fire("error");
    this.fire("close");
  }
}

export const msgs = (from: number, to: number): ChatEntry[] =>
  Array.from({ length: to - from }, (_, i) => ({
    index: from + i,
    role: (from + i) % 2 === 0 ? "user" : "assistant",
    text: `m${from + i}`,
  }));

// 帧的外壳与 session/pool.ts 的 frame() 一致。
export const frame = (seq: number, type: string, data: object = {}) => ({
  session: "s1",
  seq,
  ts: "2026-10-18T00:00:00.000Z",
  type,
  data,
});

// 快照的 data 与 pool.ts 的 snapshotFrame() 一致：窗口固定最近 50 条，消息无 index，另带窗口起点 startIndex。
export const snapshot = (
  seq: number,
  history: ChatEntry[],
  extra: Record<string, unknown> = {},
) => {
  const start = Math.max(0, history.length - 50);
  return frame(seq, "snapshot", {
    messages: history.slice(start).map(({ role, text }) => ({ role, text })),
    startIndex: start,
    running: false,
    activeTools: [],
    partial: null,
    queue: [],
    ...extra,
  });
};

export interface Api {
  history: ChatEntry[];
  sessions: number | "network";
  list: object[];
  retryAfter?: string;
  messages: number | "network" | "garbage" | "shape";
  // 设置后，带游标的请求（加载更早）会等它完成才响应。
  pause: Promise<void> | null;
  tailPause: Promise<void> | null;
  // 设置后，工作台 PUT 会等它完成才响应。
  putPause: Promise<void> | null;
  calls: string[];
  workbench: { revision: number; document: unknown };
  puts: unknown[];
  putStatus: number | "network";
  saved: { id: string; revision: number; document: unknown }[];
  tokens: (string | null)[];
}

const cursor = (n: number) => btoa(String(n)).replace(/=+$/, "");

// 分页语义与 store/history.ts 的 pageMessages 一致：游标是严格上界。
export function installApi(history: ChatEntry[] = []): Api {
  const api: Api = {
    history,
    sessions: 200,
    list: [],
    messages: 200,
    pause: null,
    tailPause: null,
    putPause: null,
    calls: [],
    workbench: { revision: 0, document: null },
    puts: [],
    putStatus: 200,
    saved: [],
    tokens: [],
  };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    api.calls.push(input);
    api.tokens.push(new Headers(init?.headers).get("Authorization"));
    const reply = (status: number, body: object, headers?: HeadersInit) =>
      new Response(JSON.stringify(body), { status, headers });

    if (input === "/api/v1/workbench") {
      if (init?.method === "PUT") {
        const b = JSON.parse(String(init.body)) as {
          baseRevision: number;
          document: unknown;
        };
        if (api.putStatus === "network") throw new TypeError("network");
        if (api.putPause) await api.putPause;
        if (api.putStatus !== 200) return reply(api.putStatus, {});
        if (b.baseRevision !== api.workbench.revision)
          return reply(409, api.workbench);
        api.puts.push(b.document);
        api.workbench = { revision: b.baseRevision + 1, document: b.document };
        return reply(200, { revision: api.workbench.revision });
      }
      return reply(200, api.workbench);
    }
    if (input === "/api/v1/saved-layouts") {
      if (init?.method === "POST") {
        const b = JSON.parse(String(init.body)) as { document: unknown };
        const id = `sv${api.saved.length + 1}`;
        api.saved.push({ id, revision: 1, document: b.document });
        return reply(201, { id, revision: 1 });
      }
      return reply(200, { layouts: api.saved });
    }
    if (input.startsWith("/api/v1/saved-layouts/") && init?.method === "DELETE") {
      const id = input.slice("/api/v1/saved-layouts/".length);
      const i = api.saved.findIndex((x) => x.id === id);
      if (i < 0) return reply(404, {});
      api.saved.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (input === "/api/v1/sessions") {
      if (api.sessions === "network") throw new TypeError("network");
      const headers: Record<string, string> = {};
      if (api.retryAfter) headers["Retry-After"] = api.retryAfter;
      return reply(api.sessions, { sessions: api.list }, headers);
    }
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
    });
  });
  return api;
}
