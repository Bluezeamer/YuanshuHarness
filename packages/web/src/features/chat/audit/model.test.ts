import { expect, test } from "vitest";
import type { CallsPage } from "../../../api/calls";
import {
  actionOf,
  clampSplit,
  composition,
  countByFilter,
  filterOf,
  groupByTurn,
  inputOf,
  matchesQuery,
  mergeFirstPage,
  selectCalls,
  splitMax,
  summarize,
} from "./model";
import { sample, summaryOf, tokens } from "./testkit";

const calls = () =>
  sample()
    .map(summaryOf)
    .sort((a, b) => b.seq - a.seq);

test("五档计数：用户 2 / 工具返回 9 / 工具调用 9 / 子代理 1，工具调用与触发类型无关", () => {
  expect(countByFilter(calls())).toEqual({
    all: 12,
    user: 2,
    tool: 9,
    call: 9,
    sub: 1,
  });
  // 子代理那条自己也发起了工具：同时出现在「子代理」和「工具调用」里
  const sub = selectCalls(calls(), "sub", "");
  expect(sub.map((c) => c.seq)).toEqual([12]);
  expect(selectCalls(calls(), "call", "").map((c) => c.seq)).toContain(12);
});

test("filterOf：未知档位回退「全部」", () => {
  expect(filterOf("sub")).toBe("sub");
  expect(filterOf("nope")).toBe("all");
  expect(filterOf(undefined)).toBe("all");
});

test("搜索只匹配摘要、来源工具名、发起的工具名，大小写不敏感", () => {
  const all = calls();
  expect(selectCalls(all, "all", "DISPATCH").map((c) => c.seq)).toEqual([
    11, 5,
  ]);
  expect(selectCalls(all, "all", "重试").map((c) => c.seq)).toEqual([1]);
  expect(selectCalls(all, "all", "zzzz")).toEqual([]);
  expect(matchesQuery(all[0] as (typeof all)[0], "   ")).toBe(true);
  // 不匹配请求正文：列表阶段没有正文
  expect(selectCalls(all, "all", "你是元枢")).toEqual([]);
});

test("筛选与搜索叠加", () => {
  expect(selectCalls(calls(), "user", "dispatch").map((c) => c.seq)).toEqual([
    5,
  ]);
});

test("按 turn 分组：倒序输入保持顺序，null 单独成组", () => {
  const g = groupByTurn(calls());
  expect(g.map((x) => [x.turn, x.calls.length])).toEqual([
    [2, 8],
    [1, 4],
  ]);
  const withNull = groupByTurn([
    { ...(calls()[0] as ReturnType<typeof calls>[0]), turn: null },
    ...calls().slice(1),
  ]);
  expect(withNull[0]?.turn).toBeNull();
});

test("按 turn 分组：子代理的调用按来源子会话分开，不同子会话的同号轮次不并组", () => {
  const sub = (id: string, name: string, seq: number, turn: number) => ({
    ...(calls()[0] as ReturnType<typeof calls>[0]),
    id: `${id}-c${seq}`,
    seq,
    turn,
    trigger: "subagent" as const,
    subagent: { sessionId: id, name },
  });
  // 时间倒序：乙的第 2 次、甲的第 1 次、甲的第 1 次（同一子会话、同一轮并组）、乙的第 1 次
  const g = groupByTurn([
    sub("b", "乙", 2, 1),
    sub("a", "甲", 1, 1),
    sub("a", "甲", 2, 1),
    sub("b", "乙", 1, 1),
  ]);
  expect(g.map((x) => [x.source?.name, x.calls.length])).toEqual([
    ["乙", 1],
    ["甲", 2],
    ["乙", 1],
  ]);
  // 本会话自己的调用没有来源
  expect(groupByTurn(calls())[0]?.source).toBeUndefined();
});

test("汇总：入 = 四段之和，出 = out；筛后只算筛出的", () => {
  const all = calls();
  const one = summarize(all);
  expect(one).toEqual({ count: 12, input: 12 * 380, output: 12 * 40 });
  const subs = summarize(selectCalls(all, "sub", ""));
  expect(subs).toEqual({ count: 1, input: 380, output: 40 });
});

test("组成条：四段宽度合计恰为 100，比例按 tokens", () => {
  const segs = composition(
    tokens({ system: 100, tools: 50, history: 200, current: 30 }),
  );
  expect(segs.map((s) => s.label)).toEqual([
    "系统",
    "工具定义",
    "历史",
    "本轮",
  ]);
  expect(segs.map((s) => s.tokens)).toEqual([100, 50, 200, 30]);
  const sum = segs.reduce((a, s) => a + s.pct, 0);
  expect(Math.round(sum * 100)).toBe(10000);
  expect(segs[2]?.pct).toBeGreaterThan(segs[0]?.pct ?? 0);
});

test("组成条：难除尽的比例也合计 100；全零不画条", () => {
  for (const t of [
    { system: 1, tools: 1, history: 1, current: 0 },
    { system: 7, tools: 11, history: 13, current: 17 },
    { system: 3333, tools: 3333, history: 3333, current: 1 },
  ]) {
    const sum = composition(tokens(t)).reduce((a, s) => a + s.pct, 0);
    expect(Math.round(sum * 100)).toBe(10000);
  }
  const zero = composition(
    tokens({ system: 0, tools: 0, history: 0, current: 0 }),
  );
  expect(zero.every((s) => s.pct === 0)).toBe(true);
  expect(inputOf(tokens({ system: 0, tools: 0, history: 0, current: 0 }))).toBe(
    0,
  );
});

test("行尾的做了什么：子代理 > 发起的工具 > 文本", () => {
  const byId = Object.fromEntries(calls().map((c) => [c.seq, c]));
  expect(actionOf(byId[12] as (typeof byId)[number])).toBe("子代理");
  expect(actionOf(byId[3] as (typeof byId)[number])).toBe("run_tests");
  expect(actionOf(byId[4] as (typeof byId)[number])).toBe("文本");
  expect(
    actionOf({
      ...(byId[3] as (typeof byId)[number]),
      calledTools: ["a", "b", "c"],
    }),
  ).toBe("a +2");
});

test("分栏宽度：不小于 216，详情至少留 320，容器未知不设上限", () => {
  expect(clampSplit(100, 900)).toBe(216);
  expect(clampSplit(9999, 900)).toBe(580);
  expect(clampSplit(300.4, 900)).toBe(300);
  expect(splitMax(0)).toBeGreaterThan(2000);
  // 容器太窄时不会得到小于最小宽度的上限
  expect(splitMax(400)).toBe(216);
});

test("刷新合并：接得上就去重合并并保留旧游标；接不上以新页为准", () => {
  const all = calls();
  const page = (from: number, to: number, next: number | null): CallsPage => ({
    calls: all.filter((c) => c.seq <= from && c.seq >= to),
    nextBefore: next,
  });
  const prev = page(8, 4, 4);
  // 新增 9、10 两条，页内与已载入重叠
  const merged = mergeFirstPage(prev, page(10, 7, 7));
  expect(merged.calls.map((c) => c.seq)).toEqual([10, 9, 8, 7, 6, 5, 4]);
  expect(merged.nextBefore).toBe(4);
  // 新增很多条：新页与已载入之间有缺口
  const gap = mergeFirstPage(page(3, 1, null), page(11, 8, 8));
  expect(gap.calls.map((c) => c.seq)).toEqual([11, 10, 9, 8]);
  expect(gap.nextBefore).toBe(8);
  // 新页已经覆盖到最早一条：没有更早的了
  expect(mergeFirstPage(prev, page(11, 1, null)).nextBefore).toBeNull();
  // 还没载入过
  expect(
    mergeFirstPage({ calls: [], nextBefore: null }, page(5, 3, 3)).calls,
  ).toHaveLength(3);
});
