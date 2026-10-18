import { expect, test } from "vitest";
import type { Frame } from "./conversation";
import { type Ack, Stream } from "./stream";

class FakeWS {
  static last: FakeWS;
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
    FakeWS.last = this;
  }
  addEventListener(t: string, fn: (ev: { data?: unknown }) => void) {
    this.ls[t] = [...(this.ls[t] ?? []), fn];
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  recv(o: unknown) {
    for (const fn of this.ls.message ?? []) fn({ data: JSON.stringify(o) });
  }
  drop() {
    this.readyState = 3;
    for (const fn of this.ls.close ?? []) fn({});
  }
  // 握手失败：浏览器先触发 error 再触发 close。
  failConnect() {
    this.readyState = 3;
    for (const fn of this.ls.error ?? []) fn({});
    for (const fn of this.ls.close ?? []) fn({});
  }
}

const fr = (seq: number, type: string, data = {}) => ({
  session: "s",
  seq,
  type,
  data,
});

function open(token: string | null = "tok") {
  const frames: Frame[] = [];
  const acks: Ack[] = [];
  const log = { closed: 0, proto: [] as string[] };
  const s = new Stream(
    "ws://x/stream",
    token,
    {
      onFrame: (f) => frames.push(f),
      onAck: (a) => acks.push(a),
      onClose: () => log.closed++,
      onProtocolError: (m) => log.proto.push(m),
    },
    FakeWS as unknown as typeof WebSocket,
  );
  return { s, ws: FakeWS.last, frames, acks, log };
}

test("R1 令牌走第二个子协议，不出现在 URL", () => {
  const { ws } = open("secret");
  expect(ws.protocols).toEqual(["yuanshu.v1", "bearer.secret"]);
  expect(ws.url).not.toContain("secret");
});

test("R1 首帧不是快照：协议错误并关闭", () => {
  const { ws, frames, log } = open();
  ws.recv(fr(1, "run.started"));
  expect(log.proto).toHaveLength(1);
  expect(ws.closed).toBe(true);
  expect(frames).toHaveLength(0);
});

test("R3 序号连续的帧按序交付", () => {
  const { ws, frames } = open();
  ws.recv(fr(5, "snapshot"));
  ws.recv(fr(6, "run.started"));
  ws.recv(fr(7, "run.ended"));
  expect(frames.map((x) => x.seq)).toEqual([5, 6, 7]);
});

test("R3 跳号：发 resync，丢弃其后的实时帧，新快照后恢复", () => {
  const { ws, frames } = open();
  ws.recv(fr(1, "snapshot"));
  ws.recv(fr(3, "run.started"));
  expect(ws.sent.map((m) => m.type)).toEqual(["resync"]);
  ws.recv(fr(4, "run.ended"));
  ws.recv(fr(5, "run.ended"));
  expect(ws.sent).toHaveLength(1);
  expect(frames.map((x) => x.seq)).toEqual([1]);
  ws.recv(fr(9, "snapshot"));
  ws.recv(fr(10, "run.started"));
  expect(frames.map((x) => x.seq)).toEqual([1, 9, 10]);
});

test("R3 重复帧（序号回退）同样触发 resync", () => {
  const { ws } = open();
  ws.recv(fr(4, "snapshot"));
  ws.recv(fr(4, "run.started"));
  expect(ws.sent.map((m) => m.type)).toEqual(["resync"]);
});

test("R8 命令 id 递增，回执原样交给调用方", () => {
  const { s, ws, acks } = open();
  expect(s.command("send_message", { text: "a" })).toBe("c1");
  expect(s.command("stop")).toBe("c2");
  expect(ws.sent[0]).toEqual({ id: "c1", type: "send_message", text: "a" });
  ws.recv({ type: "ack", id: "c1", ok: false, error: { message: "忙" } });
  expect(acks).toEqual([
    { type: "ack", id: "c1", ok: false, error: { message: "忙" } },
  ]);
});

test("R10 对端关闭触发 onClose；自己 close 不触发；关闭后命令不可用", () => {
  const a = open();
  a.ws.drop();
  expect(a.log.closed).toBe(1);
  expect(a.s.command("stop")).toBeNull();

  const b = open();
  b.s.close();
  b.ws.drop();
  expect(b.log.closed).toBe(0);
  expect(b.s.command("stop")).toBeNull();
});

test("R10 握手失败时 error 加 close 只算一次关闭", () => {
  const { ws, log } = open();
  ws.failConnect();
  expect(log.closed).toBe(1);
});

test("R1 关闭后到达的帧被忽略", () => {
  const { s, ws, frames } = open();
  ws.recv(fr(1, "snapshot"));
  s.close();
  ws.recv(fr(2, "run.started"));
  expect(frames).toHaveLength(1);
});
