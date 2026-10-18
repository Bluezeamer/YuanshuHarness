import { expect, test } from "vitest";
import type { ChatEntry, Page, Result } from "./api";
import { afterEarlier, afterTail, loadOlder } from "./history";

const e = (index: number, text = `m${index}`): ChatEntry => ({
  index,
  role: index % 2 === 0 ? "user" : "assistant",
  text,
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);
const ok = (
  messages: ChatEntry[],
  nextBefore: string | null = null,
): Result<Page> => ({
  ok: true,
  data: { messages, nextBefore },
});

test("R2 窗口之前的消息作为历史：按 startIndex 截页，不比对内容", async () => {
  const page = range(0, 8).map((i) => e(i));
  const r = await loadOlder(async () => ok(page), 5);
  expect(r).toEqual({ ok: true, nextBefore: null, older: page.slice(0, 5) });
});

test("R2 页内文本与窗口不同也不影响：窗口内的消息本来就不取自页", async () => {
  const page = range(0, 8).map((i) => e(i, "别的"));
  const r = await loadOlder(async () => ok(page), 5);
  expect(r).toMatchObject({ ok: true, older: page.slice(0, 5) });
});

test("R2 窗口从 0 开始：没有更早的消息", async () => {
  const r = await loadOlder(async () => ok(range(0, 3).map((i) => e(i))), 0);
  expect(r).toEqual({ ok: true, nextBefore: null, older: [] });
});

test("R2 窗口被截空（startIndex 等于总数）时整页都是历史", async () => {
  const page = range(0, 4).map((i) => e(i));
  const r = await loadOlder(async () => ok(page), 4);
  expect(r).toEqual({ ok: true, nextBefore: null, older: page });
});

test("R2 取数期间窗口外又新增了消息：多出的部分被截掉，不重复", async () => {
  const r = await loadOlder(async () => ok(range(0, 12).map((i) => e(i))), 5);
  expect(r).toMatchObject({ ok: true, older: range(0, 5).map((i) => e(i)) });
});

test("R2 页没覆盖到 startIndex - 1（服务端落后）：重取，之后成功", async () => {
  let calls = 0;
  const r = await loadOlder(async () => {
    calls += 1;
    return ok(range(0, calls === 1 ? 3 : 8).map((i) => e(i)));
  }, 5);
  expect(calls).toBe(2);
  expect(r).toMatchObject({ ok: true, older: range(0, 5).map((i) => e(i)) });
});

test("R2 页一直接不上窗口（早于窗口的部分超出一页）：3 次后降级为失败", async () => {
  let calls = 0;
  const r = await loadOlder(async () => {
    calls += 1;
    return ok(range(400, 600).map((i) => e(i)));
  }, 300);
  expect(calls).toBe(3);
  expect(r).toEqual({ ok: false });
});

test("R2 请求失败直接降级", async () => {
  const r = await loadOlder(async () => ({ ok: false, kind: "network" }), 5);
  expect(r).toEqual({ ok: false });
});

test("R2 窗口满后滚动了一轮、内容重复：序位不依赖内容，照样对得上", async () => {
  const dup = (i: number): ChatEntry => ({
    index: i,
    role: i % 2 === 0 ? "user" : "assistant",
    text: i % 2 === 0 ? "继续" : "好",
  });
  const r = await loadOlder(async () => ok(range(0, 62).map(dup)), 12);
  expect(r).toMatchObject({ ok: true, older: range(0, 12).map(dup) });
});

test("R2 页内有更早的历史时带回游标", async () => {
  const r = await loadOlder(
    async () =>
      ok(
        range(100, 300).map((i) => e(i)),
        "c100",
      ),
    250,
  );
  expect(r).toMatchObject({ ok: true, nextBefore: "c100" });
});

const loaded = (from: number, to: number, nextBefore: string | null) => ({
  older: range(from, to).map((i) => e(i)),
  nextBefore,
});

test("R2 累积：新页与已加载块首尾衔接时合并，保留更早的游标", () => {
  const r = afterTail(loaded(100, 150, "c100"), loaded(150, 200, "c150"));
  expect(r.older.map((m) => m.index)).toEqual(range(100, 200));
  expect(r.nextBefore).toBe("c100");
});

test("R2 累积：新页与已加载块重叠时合并不重复，且新页的文本为准", () => {
  const prev = loaded(100, 160, "c100");
  const fresh = {
    older: range(140, 200).map((i) => e(i, `新${i}`)),
    nextBefore: "c140",
  };
  const r = afterTail(prev, fresh);
  expect(r.older.map((m) => m.index)).toEqual(range(100, 200));
  expect(r.older.find((m) => m.index === 150)?.text).toBe("新150");
  expect(r.nextBefore).toBe("c100");
});

test("R2 累积：新页比已加载块更靠前时仍保留已加载部分", () => {
  const r = afterTail(loaded(180, 200, "c180"), loaded(100, 190, "c100"));
  expect(r.older.map((m) => m.index)).toEqual(range(100, 200));
  expect(r.nextBefore).toBe("c100");
});

test("R2 累积：中间有缺口（断开期间新增超过一页）时改用新页，游标跟随新页", () => {
  const r = afterTail(loaded(0, 50, null), loaded(500, 700, "c500"));
  expect(r.older.map((m) => m.index)).toEqual(range(500, 700));
  expect(r.nextBefore).toBe("c500");
});

test("R2 累积：还没有已加载内容时直接采用新页", () => {
  const fresh = loaded(0, 3, null);
  expect(afterTail({ older: [], nextBefore: null }, fresh)).toEqual(fresh);
});

test("R13 加载更早：拼在已有历史之前，游标换成新页的", () => {
  const r = afterEarlier(loaded(100, 200, "c100"), "c100", {
    messages: range(0, 100).map((i) => e(i)),
    nextBefore: null,
  });
  expect(r.older.map((m) => m.index)).toEqual(range(0, 200));
  expect(r.nextBefore).toBeNull();
});

test("R13 加载更早：取数期间游标已变（被重新对齐替换）时丢弃结果", () => {
  const prev = loaded(500, 700, "c500");
  const r = afterEarlier(prev, "c100", {
    messages: range(0, 100).map((i) => e(i)),
    nextBefore: null,
  });
  expect(r).toBe(prev);
});
