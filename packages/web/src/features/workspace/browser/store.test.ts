import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserEvent } from "../../../api/browser";
import { PROBE_MS } from "../../../api/foreground";
import { acquireBrowserStore, type StoreDeps } from "./store";
import { engineState, FakeSocket, limitsView, pageView } from "./testkit";

const RETRY_MS = 3000;

const snapshot = (pages = [pageView({ id: "a" })]): BrowserEvent => ({
  type: "snapshot",
  engine: engineState(),
  pages,
  limits: limitsView,
});

// 每个用例用独立的工作区 id：store 是模块级共享的，别让上一条的连接漏进下一条。
let wid = 0;
const acquire = (over: Partial<StoreDeps> = {}) =>
  acquireBrowserStore(`w${++wid}`, deps(over));

const deps = (over: Partial<StoreDeps> = {}): StoreDeps => ({
  open: (wid) => new FakeSocket(wid) as unknown as WebSocket,
  retryMs: RETRY_MS,
  maxRetries: 5,
  ...over,
});

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("首份快照整体落进状态，连上后 link 为 live", () => {
  const { store, release } = acquire();
  const sock = FakeSocket.last;
  expect(store.getSnapshot()).toEqual({
    link: "connecting",
    engine: null,
    pages: [],
    limits: null,
    handedBack: [],
  });
  sock.open();
  sock.serve(snapshot());
  const s = store.getSnapshot();
  expect(s.link).toBe("live");
  expect(s.engine?.status).toBe("ready");
  expect(s.pages.map((p) => p.id)).toEqual(["a"]);
  expect(s.limits).toEqual(limitsView);
  release();
});

test("增量事件：added / updated / removed / engine", () => {
  const { store, release } = acquire();
  const sock = FakeSocket.last;
  sock.open();
  sock.serve(snapshot([pageView({ id: "a" }), pageView({ id: "b" })]));
  sock.serve({
    type: "page",
    event: { type: "added", page: pageView({ id: "c" }) },
  } satisfies BrowserEvent);
  sock.serve({
    type: "page",
    event: { type: "updated", page: pageView({ id: "b", title: "改过" }) },
  } satisfies BrowserEvent);
  sock.serve({
    type: "page",
    event: { type: "removed", id: "a", workspaceKey: "w" },
  } satisfies BrowserEvent);
  sock.serve({ type: "engine", state: engineState("installing") });
  const s = store.getSnapshot();
  expect(s.pages.map((p) => p.id)).toEqual(["b", "c"]);
  expect(s.pages[0]?.title).toBe("改过");
  expect(s.engine?.status).toBe("installing");
  release();
});

test("不认识的文本帧与坏 JSON 忽略，不影响后续", () => {
  const { store, release } = acquire();
  const sock = FakeSocket.last;
  sock.open();
  sock.serveText("{不是 JSON");
  sock.serve({ type: "nope" });
  sock.serve(snapshot());
  expect(store.getSnapshot().pages).toHaveLength(1);
  release();
});

test("同一工作区多次 acquire 共用同一个 store 与一条连接", () => {
  const d = deps();
  const open = vi.spyOn(d, "open");
  const a = acquireBrowserStore("multi", d);
  const b = acquireBrowserStore("multi", d);
  expect(b.store).toBe(a.store);
  expect(open).toHaveBeenCalledTimes(1);
  expect(FakeSocket.all).toHaveLength(1);
  a.release();
  b.release();
});

test("release 减到 0 才关连接并丢掉 store；之后 acquire 重新建连", () => {
  const d = deps();
  const a = acquireBrowserStore("refs", d);
  const b = acquireBrowserStore("refs", d);
  const sock = FakeSocket.last;
  a.release();
  expect(sock.closed).toBe(false);
  b.release();
  expect(sock.closed).toBe(true);
  // 新 store：状态回到起点
  const c = acquireBrowserStore("refs", d);
  expect(c.store).not.toBe(a.store);
  expect(c.store.getSnapshot().link).toBe("connecting");
  expect(FakeSocket.all).toHaveLength(2);
  c.release();
});

test("断线后按间隔重连；用尽次数进入 lost，不再建连", async () => {
  const { store, release } = acquire({ maxRetries: 1 });
  FakeSocket.last.open();
  FakeSocket.last.serve(snapshot());
  FakeSocket.last.drop();
  expect(store.getSnapshot().link).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  expect(FakeSocket.all).toHaveLength(2);
  // 第二路也没连上：超过上限，停在 lost，不再重连
  FakeSocket.last.drop();
  expect(store.getSnapshot().link).toBe("lost");
  await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
  expect(FakeSocket.all).toHaveLength(2);
  release();
});

test("重连成功后失败计数清零：之后再断仍可重连", async () => {
  const { store, release } = acquire({ maxRetries: 1 });
  FakeSocket.last.open();
  FakeSocket.last.drop();
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  FakeSocket.last.open();
  FakeSocket.last.drop();
  expect(store.getSnapshot().link).toBe("reconnecting");
  release();
});

test("重连成功后的快照整体替换旧状态", async () => {
  const { store, release } = acquire();
  FakeSocket.last.open();
  FakeSocket.last.serve(
    snapshot([pageView({ id: "a" }), pageView({ id: "b" })]),
  );
  FakeSocket.last.drop();
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  FakeSocket.last.open();
  FakeSocket.last.serve(snapshot([pageView({ id: "c" })]));
  expect(store.getSnapshot().pages.map((p) => p.id)).toEqual(["c"]);
  release();
});

test("retry：lost 之后手动重连，失败计数清零", async () => {
  const { store, release } = acquire({ maxRetries: 1 });
  FakeSocket.last.open();
  FakeSocket.last.drop();
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  FakeSocket.last.drop();
  expect(store.getSnapshot().link).toBe("lost");
  store.retry();
  expect(store.getSnapshot().link).toBe("connecting");
  expect(FakeSocket.all).toHaveLength(3);
  // 计数清零：这一轮没连上就断，也还能重连一次
  FakeSocket.last.drop();
  expect(store.getSnapshot().link).toBe("reconnecting");
  release();
});

// ---- 回前台 ----

// 先让合并窗口过去，再发信号。
const foreground = async () => {
  await vi.advanceTimersByTimeAsync(1000);
  window.dispatchEvent(new Event("online"));
};
const pings = (sock: FakeSocket) => sock.sent.filter((m) => m.type === "ping");

test("回前台：连着就发 ping，回音（任何消息）到了不重连", async () => {
  const { release } = acquire();
  const sock = FakeSocket.last;
  sock.open();
  sock.serve(snapshot());
  await foreground();
  await foreground();
  expect(pings(sock)).toHaveLength(1);
  sock.serve({ type: "pong" });
  await vi.advanceTimersByTimeAsync(PROBE_MS * 2);
  expect(FakeSocket.all).toHaveLength(1);
  expect(sock.closed).toBe(false);
  release();
});

test("回前台：ping 没有回音就关掉旧连接并立即重连，已显示的页面不清", async () => {
  const { store, release } = acquire();
  const sock = FakeSocket.last;
  sock.open();
  sock.serve(snapshot([pageView({ id: "a" })]));
  await foreground();
  await vi.advanceTimersByTimeAsync(PROBE_MS);
  expect(sock.closed).toBe(true);
  expect(FakeSocket.all).toHaveLength(2);
  expect(store.getSnapshot().link).toBe("connecting");
  expect(store.getSnapshot().pages.map((p) => p.id)).toEqual(["a"]);
  release();
});

test("回前台：在退避里等着、或已经放弃的，立即重连", async () => {
  const { store, release } = acquire({ maxRetries: 1 });
  FakeSocket.last.open();
  FakeSocket.last.drop();
  expect(store.getSnapshot().link).toBe("reconnecting");
  await foreground();
  expect(FakeSocket.all).toHaveLength(2);

  // 回前台清零了失败计数：要再连续断两次才放弃
  FakeSocket.last.drop();
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  FakeSocket.last.drop();
  expect(store.getSnapshot().link).toBe("lost");
  const before = FakeSocket.all.length;
  await foreground();
  expect(FakeSocket.all).toHaveLength(before + 1);
  expect(store.getSnapshot().link).toBe("connecting");
  release();
});

test("回前台：首次连接还没通不打断；释放之后不再响应", async () => {
  const { release } = acquire();
  const sock = FakeSocket.last;
  await foreground();
  expect(FakeSocket.all).toHaveLength(1);
  expect(sock.closed).toBe(false);

  sock.open();
  release();
  await foreground();
  expect(pings(sock)).toHaveLength(0);
});

test("onAgentUse 只对连上之后的实时事件触发，首份快照不触发；取消订阅后不再触发", () => {
  const { store, release } = acquire();
  const seen: string[] = [];
  const off = store.onAgentUse((u) => seen.push(u.page.id));
  const sock = FakeSocket.last;
  sock.open();
  // 快照里已经有 agent 在用的页面：不触发
  sock.serve(
    snapshot([
      pageView({ id: "a", inUseBy: "s1" }),
      pageView({ id: "e", inUseBy: null }),
    ]),
  );
  expect(seen).toEqual([]);
  // 新开一个页面（agent 在用）：触发（fresh）
  sock.serve({
    type: "page",
    event: { type: "added", page: pageView({ id: "b", inUseBy: "s1" }) },
  } satisfies BrowserEvent);
  expect(seen).toEqual(["b"]);
  // 同一页面继续动作：inUseBy 还是 s1，不再触发
  sock.serve({
    type: "page",
    event: { type: "updated", page: pageView({ id: "b", inUseBy: "s1" }) },
  } satisfies BrowserEvent);
  expect(seen).toEqual(["b"]);
  // 已有页面从没人用变成 agent 在用：触发（要拿事件前的状态去比）
  sock.serve({
    type: "page",
    event: { type: "updated", page: pageView({ id: "e", inUseBy: "s1" }) },
  } satisfies BrowserEvent);
  expect(seen).toEqual(["b", "e"]);
  off();
  sock.serve({
    type: "page",
    event: { type: "added", page: pageView({ id: "c" }) },
  } satisfies BrowserEvent);
  expect(seen).toEqual(["b", "e"]);
  release();
});

test("订阅者收到变更通知；释放后不再通知", () => {
  const { store, release } = acquire();
  const seen = vi.fn();
  store.subscribe(seen);
  FakeSocket.last.open();
  expect(seen).toHaveBeenCalled();
  release();
  seen.mockClear();
  FakeSocket.last.open();
  expect(seen).not.toHaveBeenCalled();
});

test("show 事件只通知订阅者，不进状态", () => {
  const { store, release } = acquire();
  const sock = FakeSocket.last;
  sock.open();
  sock.serve(snapshot());
  const seen: string[] = [];
  const off = store.onShow((s) => seen.push(`${s.by}:${s.pageId}`));
  const before = store.getSnapshot();
  sock.serve({
    type: "show",
    show: {
      sessionId: "s1",
      by: "整理报告",
      pageId: "a",
      title: "报告",
      url: "http://x.test/",
      note: "请看第二节",
    },
  });
  expect(seen).toEqual(["整理报告:a"]);
  expect(store.getSnapshot()).toBe(before);
  off();
  release();
});
