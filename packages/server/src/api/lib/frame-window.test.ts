import { expect, test } from "vitest";
import { FrameWindow } from "./frame-window.js";

const buf = (n: number, tag = "x") => Buffer.from(tag.repeat(n));

function make(maxBytes: number) {
  const sent: Buffer[] = [];
  const w = new FrameWindow((b) => sent.push(b), maxBytes);
  return { w, sent };
}

test("窗口空着：来一帧发一帧，哪怕这一帧比窗口还大", () => {
  const { w, sent } = make(100);
  w.push(buf(500, "a"));
  expect(sent).toEqual([buf(500, "a")]);
});

test("在路上的字节没到上限：继续发；到了上限：不发", () => {
  const { w, sent } = make(100);
  w.push(buf(40, "a"));
  w.push(buf(40, "b"));
  w.push(buf(40, "c")); // 此刻在路上 80 < 100，放行；之后到 120
  w.push(buf(40, "d")); // 120 >= 100，等着
  expect(sent).toEqual([buf(40, "a"), buf(40, "b"), buf(40, "c")]);
});

test("等着的只留最新一帧，确认之后发它；中间被顶掉的不发", () => {
  const { w, sent } = make(0);
  w.push(buf(10, "a"));
  w.push(buf(10, "b"));
  w.push(buf(10, "c"));
  expect(sent).toEqual([buf(10, "a")]);
  w.ack();
  expect(sent).toEqual([buf(10, "a"), buf(10, "c")]);
});

test("最后一帧不会丢：窗口满时来的最后一帧，等确认后一定发出", () => {
  const { w, sent } = make(0);
  w.push(buf(10, "a"));
  w.push(buf(10, "z"));
  w.ack();
  expect(sent.at(-1)).toEqual(buf(10, "z"));
});

test("确认按先进先出扣字节；还没腾够就继续等", () => {
  const { w, sent } = make(120);
  w.push(buf(100, "a")); // 在路上 100，<120
  w.push(buf(50, "b")); // 放行，150
  w.push(buf(10, "c")); // 150 >= 120，等着
  w.ack(); // 扣掉 a 的 100：剩 50 < 120，放行 c
  expect(sent).toEqual([buf(100, "a"), buf(50, "b"), buf(10, "c")]);

  w.push(buf(200, "d")); // 在路上 60，放行 → 260
  w.push(buf(10, "e")); // 等着
  w.ack(); // 扣 b 的 50：210 >= 120，仍然等着
  expect(sent).toHaveLength(4);
  w.ack(); // 扣 c 的 10：200 >= 120，仍然等着
  expect(sent).toHaveLength(4);
  w.ack(); // 扣 d 的 200：0
  expect(sent.at(-1)).toEqual(buf(10, "e"));
});

test("等着的那一帧发出去之后不会再发第二遍", () => {
  const { w, sent } = make(0);
  w.push(buf(10, "a"));
  w.push(buf(10, "b"));
  w.ack(); // 发出 b
  w.ack(); // 确认 a 之后再来确认：没有新帧，不能重发 b
  w.ack();
  expect(sent).toEqual([buf(10, "a"), buf(10, "b")]);
});

test("多余的确认被忽略：不抛、不发、也不会把窗口算成负数", () => {
  const { w, sent } = make(100);
  w.ack();
  w.ack();
  w.push(buf(60, "a"));
  w.push(buf(60, "b"));
  w.push(buf(60, "c")); // 120 >= 100，等着
  expect(sent).toEqual([buf(60, "a"), buf(60, "b")]);
});
