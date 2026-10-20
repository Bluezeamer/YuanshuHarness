import { type Mock, vi } from "vitest";
import type { ChatEntry } from "./api";
import type { OpenRequest } from "./layout/doc";
import type { WorkbenchEnv } from "./layout/env";
import { SessionHub } from "./sessions/hub";

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
  // 终端输出走二进制帧。
  serveBytes(b: Uint8Array) {
    this.readyState = 1;
    this.fire("message", { data: b.buffer });
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
    if (
      input.startsWith("/api/v1/saved-layouts/") &&
      init?.method === "DELETE"
    ) {
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

export interface Admin {
  workspaces: {
    id: string;
    name: string;
    path: string;
    environmentId: string;
    tier: string;
    createdAt: string;
  }[];
  rules: Record<string, object[]>;
  variables: Record<string, unknown>[];
  // 下一次对应请求返回的状态码（一次性）。
  fail: Record<string, number>;
  calls: { method: string; path: string; body: unknown }[];
}

// 在 installApi 之上叠加 workspace / 规则 / 会话写入的假实现。
export function installAdmin(): Admin {
  const base = globalThis.fetch;
  const admin: Admin = {
    workspaces: [],
    rules: {},
    variables: [],
    fail: {},
    calls: [],
  };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const isAdmin =
      input.startsWith("/api/v1/workspaces") ||
      input.startsWith("/api/v1/variables") ||
      (input === "/api/v1/sessions" && method === "POST") ||
      (input.startsWith("/api/v1/sessions/") && method === "PATCH");
    if (!isAdmin) return base(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    admin.calls.push({ method, path: input, body });
    const key = `${method} ${input}`;
    const forced = admin.fail[key];
    if (forced) {
      delete admin.fail[key];
      return new Response("{}", { status: forced });
    }
    const json = (s: number, b: object) =>
      new Response(JSON.stringify(b), { status: s });
    if (input === "/api/v1/workspaces") {
      if (method === "GET") return json(200, { workspaces: admin.workspaces });
      if (admin.workspaces.some((x) => x.path === body.path))
        return json(409, {});
      const w = {
        id: `w${admin.workspaces.length + 1}`,
        name: body.name ?? body.path.split("/").pop(),
        path: body.path,
        environmentId: "local",
        tier: "rules",
        createdAt: "t",
      };
      admin.workspaces.push(w);
      return json(201, w);
    }
    if (input.startsWith("/api/v1/variables")) {
      if (input === "/api/v1/variables") {
        if (method === "GET") return json(200, { variables: admin.variables });
        if (admin.variables.some((x) => x.name === body.name))
          return json(409, {});
        // 与 Server 一致：响应里不含 value，只给 maskable。
        const { value, ...meta } = body;
        const v = {
          ...meta,
          id: `v${admin.variables.length + 1}`,
          maskable: String(value).length >= 8,
          createdAt: "t",
        };
        admin.variables.push(v);
        return json(201, v);
      }
      const id = input.split("/").pop();
      const v = admin.variables.find((x) => x.id === id);
      if (!v) return json(404, {});
      if (method === "PATCH") {
        const { value, ...meta } = body;
        Object.assign(v, meta);
        if (value !== undefined) v.maskable = String(value).length >= 8;
        return json(200, v);
      }
      admin.variables = admin.variables.filter((x) => x.id !== id);
      return new Response(null, { status: 204 });
    }
    const m = /^\/api\/v1\/workspaces\/([^/]+)(?:\/rules(?:\/([^/]+))?)?$/.exec(
      input,
    );
    if (m) {
      const [, id, ruleId] = m as unknown as [string, string, string?];
      const w = admin.workspaces.find((x) => x.id === id);
      if (!w) return json(404, {});
      if (input.includes("/rules")) {
        if (ruleId) {
          admin.rules[id] = (admin.rules[id] ?? []).filter(
            (r) => (r as { id: string }).id !== ruleId,
          );
          return new Response(null, { status: 204 });
        }
        return json(200, { rules: admin.rules[id] ?? [] });
      }
      if (method === "PATCH") {
        Object.assign(w, body);
        return json(200, w);
      }
      admin.workspaces = admin.workspaces.filter((x) => x.id !== id);
      return new Response(null, { status: 204 });
    }
    if (method === "POST") return json(201, { id: "new1" });
    return json(200, {});
  });
  return admin;
}

export interface FsNode {
  dirs?: string[];
  readable?: boolean;
  writable?: boolean;
  truncated?: boolean;
}

export interface Fs {
  tree: Record<string, FsNode>;
  home: string;
  calls: string[];
  // 下一次目录请求返回的状态码（一次性）。
  failNext: number | null;
}

// 内存目录树，语义对齐 ADR-0032：点目录按 hidden 过滤，不可读时 dirs 为空。
export const sampleTree = (): Record<string, FsNode> => ({
  "/": { dirs: ["big", "home", "work"] },
  "/big": { dirs: ["d1", "d2"], truncated: true },
  "/home": { dirs: ["u"] },
  "/home/u": { dirs: ["proj", ".cache", "empty"] },
  "/home/u/empty": {},
  "/home/u/.cache": {},
  "/home/u/proj": { dirs: ["locked", "ro"] },
  "/home/u/proj/locked": { dirs: ["x"], readable: false, writable: false },
  "/home/u/proj/ro": { writable: false },
  "/work": { dirs: ["a", "b", "c"] },
  "/work/a": {},
  "/work/b": {},
  "/work/c": {},
});

// 在已有 fetch 之上叠加 /api/v1/fs/dirs。
export function installFs(
  tree: Record<string, FsNode> = sampleTree(),
  home = "/home/u",
): Fs {
  const base = globalThis.fetch;
  const fs: Fs = { tree, home, calls: [], failNext: null };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (!input.startsWith("/api/v1/fs/dirs")) return base(input, init);
    fs.calls.push(input);
    const json = (s: number, b: object) =>
      new Response(JSON.stringify(b), { status: s });
    if (fs.failNext) {
      const s = fs.failNext;
      fs.failNext = null;
      return json(s, {});
    }
    const q = new URLSearchParams(input.split("?")[1]);
    const path = q.get("path") ?? fs.home;
    const node = fs.tree[path];
    if (!node) return json(400, { error: "invalid_path" });
    const readable = node.readable ?? true;
    const hidden = q.get("hidden") === "1";
    const dirs = readable
      ? [...(node.dirs ?? [])]
          .filter((d) => hidden || !d.startsWith("."))
          .sort()
      : [];
    return json(200, {
      path,
      parent: path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/",
      dirs,
      readable,
      writable: node.writable ?? true,
      truncated: node.truncated ?? false,
    });
  });
  return fs;
}

export interface FileFixture {
  type: string;
  bytes: Uint8Array;
}

export interface PaneApi {
  calls: {
    method: string;
    path: string;
    body: unknown;
    range: string | null;
  }[];
  // 目录路径 -> list 响应里的条目
  dirs: Record<string, object[]>;
  files: Record<string, FileFixture>;
  // 全部审计记录，id 从大到小
  audit: Record<string, unknown>[];
  auditPage: number;
  terminalsMade: number;
  // 下一次 "METHOD 路径"（不含查询串）返回的状态码（一次性）。
  fail: Record<string, number>;
}

export const bytes = (s: string) => new TextEncoder().encode(s);

// 在 installApi 之上叠加 pane 内容用到的接口：环境 / workspace、文件、终端、审计。
// workspace w1 在本机 /work/proj，w2 在 ssh1 的 /srv/app。
export function installPaneApi(): PaneApi {
  const base = globalThis.fetch;
  const api: PaneApi = {
    calls: [],
    dirs: {
      "/work/proj": [
        { name: "src", type: "dir", size: 0, mtimeMs: 0 },
        { name: "a.txt", type: "file", size: 5, mtimeMs: 0 },
      ],
      "/work/proj/src": [],
    },
    files: {
      "/work/proj/a.txt": { type: "text/plain", bytes: bytes("hello") },
    },
    audit: [],
    auditPage: 100,
    terminalsMade: 0,
    fail: {},
  };
  const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const [pathname = "", query] = input.split("?");
    const q = new URLSearchParams(query);
    const method = init?.method ?? "GET";
    const mine =
      pathname === "/api/v1/workspaces" ||
      pathname === "/api/v1/environments" ||
      pathname.startsWith("/api/v1/environments/") ||
      pathname.startsWith("/api/v1/terminals") ||
      pathname === "/api/v1/audit";
    if (!mine) return base(input, init);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    api.calls.push({
      method,
      path: input,
      body: init?.body instanceof Blob ? `blob:${init.body.size}` : body,
      range: new Headers(init?.headers).get("Range"),
    });
    const json = (s: number, b: object, h?: HeadersInit) =>
      new Response(JSON.stringify(b), { status: s, headers: h });
    const key = `${method} ${pathname}`;
    const forced = api.fail[key];
    if (forced) {
      delete api.fail[key];
      return json(forced, {});
    }
    if (pathname === "/api/v1/workspaces")
      return json(200, {
        workspaces: [
          {
            id: "w1",
            name: "proj",
            path: "/work/proj",
            environmentId: "local",
            tier: "rules",
            createdAt: "t",
          },
          {
            id: "w2",
            name: "app",
            path: "/srv/app",
            environmentId: "ssh1",
            tier: "rules",
            createdAt: "t",
          },
        ],
      });
    if (pathname === "/api/v1/environments")
      return json(200, {
        environments: [
          { id: "local", name: "本机", kind: "local" },
          { id: "ssh1", name: "dev-box", kind: "ssh" },
        ],
      });
    if (pathname === "/api/v1/terminals") {
      api.terminalsMade += 1;
      return json(201, {
        id: `term${api.terminalsMade}`,
        environmentId: body.environmentId,
        cwd: body.cwd ?? "/home/u",
        cols: body.cols,
        rows: body.rows,
      });
    }
    if (pathname.startsWith("/api/v1/terminals/"))
      return new Response(null, { status: 204 });
    if (pathname === "/api/v1/audit") {
      const kind = q.get("kind");
      const session = q.get("session");
      const before = q.get("before");
      const rest = api.audit.filter(
        (e) =>
          (!kind || e.kind === kind) &&
          (!session || e.sessionId === session) &&
          (!before || (e.id as number) < Number(before)),
      );
      const page = rest.slice(0, api.auditPage);
      const more = rest.length > page.length;
      return json(200, {
        entries: page,
        nextBefore: more ? (page[page.length - 1]?.id ?? null) : null,
      });
    }
    // /api/v1/environments/:env/files/...
    const m = /^\/api\/v1\/environments\/[^/]+\/files\/(\w+)$/.exec(pathname);
    const path = q.get("path") ?? "";
    if (m?.[1] === "list") {
      const entries = api.dirs[path];
      if (!entries) return json(404, {});
      return json(200, {
        path,
        parent: path === "/" ? null : dirname(path),
        entries,
        truncated: false,
      });
    }
    if (m?.[1] === "mkdir") {
      const p = body.path as string;
      api.dirs[p] = [];
      api.dirs[dirname(p)]?.push({
        name: basename(p),
        type: "dir",
        size: 0,
        mtimeMs: 0,
      });
      return json(201, { path: p });
    }
    if (m?.[1] === "entry") {
      const dir = dirname(path);
      api.dirs[dir] = (api.dirs[dir] ?? []).filter(
        (e) => (e as { name: string }).name !== basename(path),
      );
      delete api.files[path];
      return new Response(null, { status: 204 });
    }
    if (m?.[1] === "content") {
      if (method === "PUT") {
        if (api.files[path] && q.get("overwrite") !== "1") return json(409, {});
        api.files[path] = {
          type: "application/octet-stream",
          bytes: bytes(""),
        };
        return new Response(null, { status: 204 });
      }
      const f = api.files[path];
      if (!f) return json(404, {});
      const range = /^bytes=0-(\d+)$/.exec(
        new Headers(init?.headers).get("Range") ?? "",
      );
      if (!range)
        return new Response(f.bytes as BodyInit, {
          headers: { "Content-Type": f.type },
        });
      const part = f.bytes.slice(0, Number(range[1]) + 1);
      return new Response(part as BodyInit, {
        status: 206,
        headers: {
          "Content-Type": f.type,
          "Content-Range": `bytes 0-${part.length - 1}/${f.bytes.length}`,
        },
      });
    }
    return json(404, {});
  });
  return api;
}

// pane 的运行环境：会话 s1 属于 w1（本机 /work/proj），s2 属于 w2（ssh1）。
export function paneEnv(
  active: string | null = "s1",
): WorkbenchEnv & { openContent: Mock<(req: OpenRequest) => void> } {
  const hub = new SessionHub();
  hub.onUnauthorized = vi.fn();
  return {
    hub,
    activeSessionId: active,
    openContent: vi.fn<(req: OpenRequest) => void>(),
    sessions: [
      {
        id: "s1",
        name: "甲",
        createdAt: "t",
        updatedAt: "t",
        running: false,
        workspaceId: "w1",
      },
      {
        id: "s2",
        name: "乙",
        createdAt: "t",
        updatedAt: "t",
        running: false,
        workspaceId: "w2",
      },
    ],
  };
}
