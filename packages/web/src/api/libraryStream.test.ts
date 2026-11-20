import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PROBE_MS } from "./foreground";
import { applyLibraryEvent, LibraryStream } from "./libraryStream";
import type { LibrarySession } from "./sessionLibrary";

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed = false;
  protocols: string[];
  private ls: Record<string, ((ev: { data?: unknown }) => void)[]> = {};

  constructor(
    public url: string,
    protocols: string[],
  ) {
    this.protocols = protocols;
    FakeWS.all.push(this);
  }

  addEventListener(t: string, fn: (ev: { data?: unknown }) => void) {
    this.ls[t] = [...(this.ls[t] ?? []), fn];
  }

  send(s: string) {
    this.sent.push(JSON.parse(s) as Record<string, unknown>);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    for (const fn of this.ls.close ?? []) fn({});
  }

  recv(o: unknown) {
    for (const fn of this.ls.message ?? []) fn({ data: JSON.stringify(o) });
  }

  sendRaw(data: unknown) {
    for (const fn of this.ls.message ?? []) fn({ data });
  }

  drop() {
    this.readyState = 3;
    for (const fn of this.ls.close ?? []) fn({});
  }
}

const fr = (seq: number, type: string, data: unknown = {}) => ({
  seq,
  type,
  data,
});

const row = (id: string): LibrarySession =>
  ({ id, title: id }) as unknown as LibrarySession;

// 回前台订阅是全局的：用例结束要关掉它们，否则会漏进下一个用例。
const opened: LibraryStream[] = [];

function open(token: string | null = "tok") {
  FakeWS.all = [];
  const events: unknown[] = [];
  const status: string[] = [];
  const s = new LibraryStream(
    token,
    { onEvent: (e) => events.push(e), onStatus: (x) => status.push(x) },
    {
      WS: FakeWS as unknown as typeof WebSocket,
      backoffMs: [1000, 4000],
    },
  );
  opened.push(s);
  return { s, events, status, ws: () => FakeWS.all[FakeWS.all.length - 1] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  vi.useRealTimers();
});

test("子协议带令牌；快照后 added / updated / removed 按序回调", () => {
  const { events, ws } = open("secret");
  const first = ws();
  expect(first?.url).toBe("ws://localhost:3000/api/v1/library/stream");
  expect(first?.protocols).toEqual(["yuanshu.v1", "bearer.secret"]);

  first?.recv(fr(1, "snapshot", { sessions: [row("a")] }));
  first?.recv(fr(2, "session.added", { session: row("b") }));
  first?.recv(fr(3, "session.updated", { session: row("a") }));
  first?.recv(fr(4, "session.removed", { id: "b" }));

  expect(events).toEqual([
    { type: "snapshot", sessions: [row("a")] },
    { type: "added", session: row("b") },
    { type: "updated", session: row("a") },
    { type: "removed", id: "b" },
  ]);
});

test("首帧不是 snapshot 或帧无法解析：关连接并重连，不回调 onEvent", () => {
  const { events, ws } = open();
  const first = ws();
  first?.recv(fr(1, "session.added", { session: row("a") }));
  expect(first?.closed).toBe(true);
  expect(events).toHaveLength(0);
  expect(FakeWS.all).toHaveLength(1);

  vi.advanceTimersByTime(1000);
  expect(FakeWS.all).toHaveLength(2);
  ws()?.sendRaw("not json");
  expect(ws()?.closed).toBe(true);
  expect(events).toHaveLength(0);
});

test("序号缺口触发重连，新快照重新对齐", () => {
  const { events, ws } = open();
  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  ws()?.recv(fr(3, "session.added", { session: row("a") }));
  expect(ws()?.closed).toBe(true);
  vi.advanceTimersByTime(1000);
  ws()?.recv(fr(9, "snapshot", { sessions: [row("b")] }));
  ws()?.recv(fr(10, "session.added", { session: row("c") }));
  expect(events).toEqual([
    { type: "snapshot", sessions: [] },
    { type: "snapshot", sessions: [row("b")] },
    { type: "added", session: row("c") },
  ]);
});

test("断开后按指数退避重连，封顶后不再增加；快照后复位", () => {
  const { ws } = open();
  ws()?.drop();
  vi.advanceTimersByTime(999);
  expect(FakeWS.all).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(FakeWS.all).toHaveLength(2);

  ws()?.drop();
  vi.advanceTimersByTime(1999);
  expect(FakeWS.all).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(FakeWS.all).toHaveLength(3);

  ws()?.drop();
  vi.advanceTimersByTime(3999);
  expect(FakeWS.all).toHaveLength(3);
  vi.advanceTimersByTime(1);
  expect(FakeWS.all).toHaveLength(4);

  // 已到上限 4000：再断开等的还是 4000，不是 8000。
  ws()?.drop();
  vi.advanceTimersByTime(3999);
  expect(FakeWS.all).toHaveLength(4);
  vi.advanceTimersByTime(1);
  expect(FakeWS.all).toHaveLength(5);

  // 收到快照后退避复位到最小间隔。
  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  ws()?.drop();
  vi.advanceTimersByTime(1000);
  expect(FakeWS.all).toHaveLength(6);
});

test("onStatus：快照到达 live，断开 reconnecting，新快照再 live", () => {
  const { status, ws } = open();
  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  ws()?.drop();
  vi.advanceTimersByTime(1000);
  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  expect(status).toEqual(["live", "reconnecting", "live"]);
});

test("viewing：未收到快照时缓存，快照后补发，相同集合不重发，超 200 取前 200", () => {
  const { s, ws } = open();
  s.viewing(["a", "b"]);
  expect(ws()?.sent).toHaveLength(0);

  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  expect(ws()?.sent).toEqual([{ type: "viewing", sessionIds: ["a", "b"] }]);

  // 顺序不同视为同一集合。
  s.viewing(["b", "a"]);
  expect(ws()?.sent).toHaveLength(1);

  s.viewing(["b"]);
  expect(ws()?.sent[1]).toEqual({ type: "viewing", sessionIds: ["b"] });

  const many = Array.from({ length: 250 }, (_, i) => `s${i}`);
  s.viewing(many);
  const last = ws()?.sent[2]?.sessionIds as string[];
  expect(last).toHaveLength(200);
  expect(last[0]).toBe("s0");
});

test("重连后等新快照再补发最近一份「我在看」", () => {
  const { s, ws } = open();
  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  s.viewing(["a"]);
  ws()?.drop();
  vi.advanceTimersByTime(1000);
  expect(ws()?.sent).toHaveLength(0);
  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  expect(ws()?.sent).toEqual([{ type: "viewing", sessionIds: ["a"] }]);
});

test("close() 之后不再重连，也不再回调", () => {
  const { s, events, status, ws } = open();
  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  const first = ws();
  s.close();
  first?.drop();
  s.viewing(["a"]);
  vi.advanceTimersByTime(10_000);
  expect(FakeWS.all).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(status).toEqual(["live"]);
});

test("等着重连时 close()：定时器被清掉，不会再建连接", () => {
  const { s, ws } = open();
  ws()?.drop();
  expect(vi.getTimerCount()).toBe(1);
  s.close();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(10_000);
  expect(FakeWS.all).toHaveLength(1);
});

test("applyLibraryEvent：替换、追加、更新、删除，无变化返回原数组", () => {
  const a = row("a");
  const b = row("b");
  const list = [a, b];

  expect(applyLibraryEvent(list, { type: "snapshot", sessions: [b] })).toEqual([
    b,
  ]);
  expect(applyLibraryEvent(list, { type: "added", session: row("c") })).toEqual(
    [a, b, row("c")],
  );

  const updated = row("a");
  expect(
    applyLibraryEvent(list, { type: "updated", session: updated }),
  ).toEqual([updated, b]);
  expect(applyLibraryEvent(list, { type: "removed", id: "a" })).toEqual([b]);

  expect(applyLibraryEvent(list, { type: "removed", id: "zzz" })).toBe(list);
  expect(applyLibraryEvent(list, { type: "updated", session: a })).toBe(list);
});

// ---- 回前台 ----

// 先让合并窗口过去，再发信号。
const foreground = () => {
  vi.advanceTimersByTime(1000);
  window.dispatchEvent(new Event("online"));
};
const pings = (w: FakeWS | undefined) =>
  w?.sent.filter((m) => m.type === "ping") ?? [];

test("回前台：连着就发 ping，任何帧都算回音，不重连", () => {
  const { ws } = open();
  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  foreground();
  expect(pings(ws())).toHaveLength(1);
  // 探针在途时再回前台不重复发
  foreground();
  expect(pings(ws())).toHaveLength(1);
  ws()?.recv(fr(2, "pong"));
  vi.advanceTimersByTime(PROBE_MS * 2);
  expect(FakeWS.all).toHaveLength(1);
  expect(ws()?.closed).toBe(false);
});

test("回前台：ping 没有回音就关掉旧连接并立即重连，不走退避", () => {
  const { ws, status } = open();
  const old = ws();
  old?.recv(fr(1, "snapshot", { sessions: [] }));
  foreground();
  vi.advanceTimersByTime(PROBE_MS - 1);
  expect(FakeWS.all).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(old?.closed).toBe(true);
  expect(FakeWS.all).toHaveLength(2);
  expect(status).toEqual(["live", "reconnecting"]);

  // 旧连接晚到的 close 不能算到新连接头上
  old?.drop();
  vi.advanceTimersByTime(10_000);
  expect(FakeWS.all).toHaveLength(2);
});

test("回前台：在退避里等着的立即重连，退避复位", () => {
  const { ws } = open();
  ws()?.drop();
  ws()?.drop();
  vi.advanceTimersByTime(500);
  expect(FakeWS.all).toHaveLength(1);
  foreground();
  expect(FakeWS.all).toHaveLength(2);
  // 之前排着的那次重连已被取消，不会再多建一条
  vi.advanceTimersByTime(10_000);
  expect(FakeWS.all).toHaveLength(2);
});

test("回前台：首次连接还没有快照不打断；close 之后不再响应", () => {
  const { s, ws } = open();
  foreground();
  expect(pings(ws())).toHaveLength(0);
  expect(FakeWS.all).toHaveLength(1);
  expect(ws()?.closed).toBe(false);

  ws()?.recv(fr(1, "snapshot", { sessions: [] }));
  s.close();
  foreground();
  expect(pings(ws())).toHaveLength(0);
});
