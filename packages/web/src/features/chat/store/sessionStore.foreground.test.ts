import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ack,
  FakeWS,
  installChatApi,
  msgs,
  snapshot,
} from "../../../test/chatFakes";
import { ChatHub } from "./hub";

// 回前台恢复：每个用例结束都释放会话，否则它的回前台订阅会漏进下一个用例。
let hub: ChatHub;

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  hub.release("s1");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function open(history = msgs(0, 8)) {
  const api = installChatApi(history);
  hub = new ChatHub({ token: () => "tok", onUnauthorized: vi.fn() });
  const store = hub.acquire("s1");
  const ws = FakeWS.last;
  ws.serve(snapshot(1, history));
  return { api, store, ws };
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
// 回前台信号：先让合并窗口过去。
const foreground = async () => {
  await tick(1000);
  window.dispatchEvent(new Event("online"));
  await tick();
};
const sessionProbes = (api: { requests: string[] }) =>
  api.requests.filter((r) => r === "/api/v1/sessions");

test("连着时回前台只发一个 ping 探针；回执到了就不重连", async () => {
  const { store, ws } = open();
  await foreground();
  expect(ws.commands("ping")).toHaveLength(1);
  ws.serve(ack(String(ws.commands("ping")[0]?.id)));
  await tick(5000);
  expect(FakeWS.all).toHaveLength(1);
  expect(ws.closed).toBe(false);
  expect(store.getSnapshot().conn).toBe("open");
});

test("探针期间再回前台不重复发；普通帧也算回音", async () => {
  const { ws } = open();
  await foreground();
  await foreground();
  expect(ws.commands("ping")).toHaveLength(1);
  ws.serve({ session: "s1", seq: 2, type: "message.delta", data: {} });
  await tick(5000);
  expect(FakeWS.all).toHaveLength(1);
});

test("探针 3 秒没有回音：关掉旧连接并立即重连，已显示的内容不清", async () => {
  const { api, store, ws } = open();
  await foreground();
  await tick(2900);
  expect(FakeWS.all).toHaveLength(1);
  await tick(200);
  expect(ws.closed).toBe(true);
  expect(store.getSnapshot().conn).toBe("reconnecting");
  expect(store.getSnapshot().messages).toHaveLength(8);
  // 不等 3 秒的重试间隔：探测 REST 之后马上建新连接
  expect(sessionProbes(api)).toHaveLength(1);
  expect(FakeWS.all).toHaveLength(2);
  FakeWS.last.serve(snapshot(1, api.history));
  await tick();
  expect(store.getSnapshot().conn).toBe("open");
});

test("探针在途时连接自己断了：照常 3 秒后重试，不被探针超时提前触发", async () => {
  const { ws } = open();
  await foreground();
  await tick(1000);
  ws.drop();
  await tick(2100);
  expect(FakeWS.all).toHaveLength(1);
  await tick(1000);
  expect(FakeWS.all).toHaveLength(2);
});

test("已断在等重试：回前台立即重连，不必等 3 秒", async () => {
  const { store, ws } = open();
  ws.drop();
  expect(store.getSnapshot().conn).toBe("reconnecting");
  await tick(100);
  expect(FakeWS.all).toHaveLength(1);
  await foreground();
  expect(FakeWS.all).toHaveLength(2);
});

test("连续失败停下后，回前台清零失败计数重新连", async () => {
  const { store, ws } = open();
  ws.drop();
  for (let i = 0; i < 5; i++) {
    await tick(3100);
    FakeWS.last.drop();
  }
  expect(store.getSnapshot().conn).toBe("closed");
  const before = FakeWS.all.length;
  await foreground();
  expect(FakeWS.all).toHaveLength(before + 1);
  FakeWS.last.serve(snapshot(1, []));
  await tick();
  expect(store.getSnapshot().conn).toBe("open");
});

test("首次连接还在路上：回前台不打断", async () => {
  installChatApi(msgs(0, 8));
  hub = new ChatHub({ token: () => "tok", onUnauthorized: vi.fn() });
  const store = hub.acquire("s1");
  expect(store.getSnapshot().conn).toBe("connecting");
  await foreground();
  expect(FakeWS.all).toHaveLength(1);
  expect(FakeWS.last.closed).toBe(false);
});

test("重试的探测还在路上时回前台：只留最新一次，不会建出两条连接", async () => {
  const { api, ws } = open();
  const gates: Array<() => void> = [];
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    input === "/api/v1/sessions"
      ? new Promise((resolve) => gates.push(() => resolve(base(input, init))))
      : base(input, init),
  );
  ws.drop();
  await tick(3100);
  await foreground();
  expect(gates).toHaveLength(2);
  for (const release of gates) release();
  await tick();
  expect(FakeWS.all).toHaveLength(2);
  expect(sessionProbes(api)).toHaveLength(2);
});

test("重连的新连接还没等到快照时又回前台：旧的那条要关掉，不留着泄漏", async () => {
  const { ws } = open();
  ws.drop();
  await tick(3100);
  expect(FakeWS.all).toHaveLength(2);
  const pending = FakeWS.last;
  expect(pending.closed).toBe(false);
  await foreground();
  expect(FakeWS.all).toHaveLength(3);
  expect(pending.closed).toBe(true);
  expect(FakeWS.last.closed).toBe(false);
});

test("释放后不再响应回前台", async () => {
  const { ws } = open();
  hub.release("s1");
  await foreground();
  expect(ws.commands("ping")).toHaveLength(0);
  expect(FakeWS.all).toHaveLength(1);
});
