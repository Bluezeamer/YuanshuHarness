import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  answerHandoff,
  answerPageDialog,
  closePage,
  ensureEngine,
  getBrowser,
  getConsole,
  getThumb,
  openPage,
  type PageView,
} from "./browser";
import { saveToken } from "./http";

const fetchMock = vi.fn();
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

const page: PageView = {
  id: "p1",
  workspaceKey: "w",
  url: "https://example.org/",
  title: "示例",
  state: "active",
  controller: "user",
  userOpened: true,
  usedBy: [],
  inUseBy: null,
  loading: false,
  hasThumb: false,
  epoch: 1,
  viewers: 0,
  handoffPending: false,
  handoffReason: null,
  pendingDownloads: [],
  pendingUpload: null,
  dialog: null,
  createdAt: "2026-11-12T08:00:00.000Z",
  lastUsedAt: "2026-11-12T08:00:00.000Z",
};

beforeEach(() => {
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

test("变更类调用：409 带状态码与服务端的中文原因", async () => {
  fetchMock.mockResolvedValue(
    json(409, { error: "limit", message: "激活的页面已达上限，先关掉一个" }),
  );
  expect(await closePage("tok", "w", "p1")).toEqual({
    ok: false,
    status: 409,
    message: "激活的页面已达上限，先关掉一个",
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/v1/workspaces/w/browser/pages/p1/close",
  );
  expect(fetchMock.mock.calls[0]?.[1].headers).toEqual({
    Authorization: "Bearer tok",
  });
});

test("变更类调用：网络失败 status = 0，错误体没有 message 时给通用中文", async () => {
  fetchMock.mockRejectedValueOnce(new Error("down"));
  expect(await closePage("tok", "w", "p1")).toEqual({
    ok: false,
    status: 0,
    message: "网络不通，请稍后重试",
  });
  fetchMock.mockResolvedValueOnce(json(502, { error: "navigation_failed" }));
  expect(await closePage("tok", "w", "p1")).toEqual({
    ok: false,
    status: 502,
    message: "操作失败，请重试",
  });
});

test("变更类调用：成功返回数据，204 返回 undefined", async () => {
  fetchMock.mockResolvedValueOnce(json(201, { page, status: 200, deny: null }));
  expect(await openPage("tok", "w", "example.org")).toEqual({
    ok: true,
    data: { page, status: 200, deny: null },
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/v1/workspaces/w/browser/pages",
  );
  expect(fetchMock.mock.calls[0]?.[1].body).toBe(
    JSON.stringify({ target: "example.org" }),
  );

  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(await closePage("tok", "w", "p1")).toEqual({
    ok: true,
    data: undefined,
  });
});

test("answerHandoff：POST 到 handoff，body 即答复；409 带服务端原因", async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(
    await answerHandoff("tok", "w", "p1", {
      outcome: "refused",
      reason: "不行",
    }),
  ).toEqual({ ok: true, data: undefined });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/v1/workspaces/w/browser/pages/p1/handoff",
  );
  expect(fetchMock.mock.calls[0]?.[1].method).toBe("POST");
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
    outcome: "refused",
    reason: "不行",
  });
  fetchMock.mockResolvedValueOnce(
    json(409, {
      error: "no_handoff",
      message: "agent 当前没有在等这个页面的接管",
    }),
  );
  expect(await answerHandoff("tok", "w", "p1", { outcome: "done" })).toEqual({
    ok: false,
    status: 409,
    message: "agent 当前没有在等这个页面的接管",
  });
});

test("answerPageDialog：POST 到 dialog，body 是回答；409 带服务端原因", async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(
    await answerPageDialog("tok", "w", "p1", { accept: true, text: "小红" }),
  ).toEqual({ ok: true, data: undefined });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/v1/workspaces/w/browser/pages/p1/dialog",
  );
  expect(fetchMock.mock.calls[0]?.[1].method).toBe("POST");
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
    accept: true,
    text: "小红",
  });
  fetchMock.mockResolvedValueOnce(
    json(409, {
      error: "no_dialog",
      message: "这个页面现在没有等待回答的对话框",
    }),
  );
  expect(await answerPageDialog("tok", "w", "p1", { accept: false })).toEqual({
    ok: false,
    status: 409,
    message: "这个页面现在没有等待回答的对话框",
  });
});

test("ensureEngine 从 {engine} 里取状态", async () => {
  const engine = {
    status: "installing",
    executable: null,
    sandbox: null,
    problem: null,
  };
  fetchMock.mockResolvedValueOnce(json(202, { engine }));
  expect(await ensureEngine("tok")).toEqual({ ok: true, data: engine });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/browser/engine/ensure");
});

test("getBrowser / getConsole：成功取数据，失败按 CallResult 映射", async () => {
  fetchMock.mockResolvedValueOnce(
    json(200, {
      engine: {
        status: "ready",
        executable: "/bin/chromium",
        sandbox: { enabled: true },
        problem: null,
      },
      pages: [page],
      limits: { perWorkspace: 12, global: 30, sleepingPerWorkspace: 100 },
    }),
  );
  const r = await getBrowser("tok", "w");
  expect(r).toEqual({
    ok: true,
    data: {
      engine: {
        status: "ready",
        executable: "/bin/chromium",
        sandbox: { enabled: true },
        problem: null,
      },
      pages: [page],
      limits: { perWorkspace: 12, global: 30, sleepingPerWorkspace: 100 },
    },
  });

  fetchMock.mockResolvedValueOnce(json(404));
  expect(await getConsole("tok", "w", "p1")).toEqual({
    ok: false,
    kind: "server",
  });

  fetchMock.mockResolvedValueOnce(json(200, { entries: [] }));
  expect(await getConsole("tok", "w", "p1")).toEqual({
    ok: true,
    data: [],
  });
});

test("getThumb：失败给 null，成功给 Blob", async () => {
  fetchMock.mockResolvedValueOnce(json(404));
  expect(await getThumb("tok", "w", "p1")).toBeNull();

  fetchMock.mockRejectedValueOnce(new Error("down"));
  expect(await getThumb("tok", "w", "p1")).toBeNull();

  fetchMock.mockResolvedValueOnce(new Response("jpeg", { status: 200 }));
  // 不比 instanceof Blob：jsdom 环境里全局的 Blob 与 Response.blob() 给的不一定是同一个类，随 Node 版本变
  const blob = await getThumb("tok", "w", "p1");
  expect(await blob?.text()).toBe("jpeg");
  expect(fetchMock.mock.calls[2]?.[0]).toBe(
    "/api/v1/workspaces/w/browser/pages/p1/thumb",
  );
});

test("两条 WebSocket 的路径：id 做 URL 编码，令牌走子协议", async () => {
  const sockets: Array<{ url: string; protocols: string[] }> = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      binaryType = "";
      constructor(
        public url: string,
        public protocols: string[],
      ) {
        sockets.push({ url, protocols });
      }
    },
  );
  const { openBrowserEvents, openPageStream } = await import("./browser");
  openBrowserEvents("w/1", "tok");
  openPageStream("w", "p/2", "tok");
  expect(sockets[0]?.url).toBe(
    "ws://localhost:3000/api/v1/workspaces/w%2F1/browser/events",
  );
  expect(sockets[1]?.url).toBe(
    "ws://localhost:3000/api/v1/workspaces/w/browser/pages/p%2F2/stream",
  );
  expect(sockets[0]?.protocols).toEqual(["yuanshu.v1", "bearer.tok"]);
  expect(sockets[1]?.protocols).toEqual(["yuanshu.v1", "bearer.tok"]);
});
