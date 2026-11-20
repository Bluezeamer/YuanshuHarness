import { expect, test } from "vitest";
import { exec } from "../exec/testkit";
import {
  agoText,
  buildForest,
  countOf,
  foldable,
  splitKids,
  statusOf,
} from "./subTree";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const done = (id: string, parentId: string, minAgo: number, over = {}) =>
  exec({
    id,
    parentId,
    state: "done",
    outcome: "ok",
    ended: ago(minAgo),
    ...over,
  });
const none = new Set<string>();

test("状态：在跑 / 没在执行 / 成功 / 失败 / 被中断", () => {
  expect(statusOf(exec())).toBe("live");
  expect(statusOf(exec({ state: "idle" }))).toBe("idle");
  expect(statusOf(done("a", "s", 1))).toBe("ok");
  expect(statusOf(done("a", "s", 1, { outcome: "failed" }))).toBe("error");
  expect(statusOf(done("a", "s", 1, { outcome: "interrupted" }))).toBe(
    "stopped",
  );
});

test("建树：主代理的直接子代理在顶层，孙代理挂在父下面，找不到父的丢掉", () => {
  const f = buildForest(
    [
      exec({ id: "a", parentId: "s" }),
      exec({ id: "b", parentId: "a" }),
      exec({ id: "c", parentId: "b" }),
      exec({ id: "x", parentId: "ghost" }),
    ],
    "s",
  );
  expect(f.map((n) => n.id)).toEqual(["a"]);
  expect(f[0]?.kids[0]?.kids[0]?.id).toBe("c");
  expect(countOf(f[0] as NonNullable<(typeof f)[0]>)).toBe(3);
});

test("建树只收模型自己派发的：团队成员与工作流 agent 不进树，它们名下再派的子代理也跟着不进", () => {
  const f = buildForest(
    [
      exec({ id: "t", parentId: "s" }),
      exec({ id: "m", parentId: "s", source: "team", member: "小王" }),
      exec({
        id: "w",
        parentId: "s",
        source: "workflow",
        run: { id: "r", phase: "查" },
      }),
      exec({ id: "m-kid", parentId: "m" }),
      exec({ id: "w-kid", parentId: "w" }),
      exec({ id: "t-kid", parentId: "t" }),
    ],
    "s",
  );
  expect(f.map((n) => n.id)).toEqual(["t"]);
  expect(f[0]?.kids.map((n) => n.id)).toEqual(["t-kid"]);
});

test("结束时间：在跑的没有，缺失 / 解析不了的也没有（不折）", () => {
  const [a, b] = buildForest(
    [
      exec({ id: "a", parentId: "s" }),
      done("b", "s", 30, { ended: "不是时间" }),
    ],
    "s",
  );
  expect(a?.endedAt).toBeNull();
  expect(b?.endedAt).toBeNull();
  expect(foldable(b as NonNullable<typeof b>, none, NOW)).toBe(false);
});

test("折叠：结束满 10 分钟才折，差一点不折", () => {
  const [young, old] = buildForest(
    [done("y", "s", 9), done("o", "s", 10)],
    "s",
  );
  expect(foldable(young as NonNullable<typeof young>, none, NOW)).toBe(false);
  expect(foldable(old as NonNullable<typeof old>, none, NOW)).toBe(true);
});

test("没看过的失败不折，看过之后按时间折；在跑的永远不折", () => {
  const [bad, run] = buildForest(
    [
      done("bad", "s", 60, { outcome: "failed" }),
      exec({ id: "run", parentId: "s" }),
    ],
    "s",
  );
  expect(foldable(bad as NonNullable<typeof bad>, none, NOW)).toBe(false);
  expect(foldable(bad as NonNullable<typeof bad>, new Set(["bad"]), NOW)).toBe(
    true,
  );
  expect(foldable(run as NonNullable<typeof run>, new Set(["run"]), NOW)).toBe(
    false,
  );
});

test("祖先：只要还有后代要显示（在跑 / 刚结束），祖先就留着", () => {
  const [p] = buildForest(
    [
      done("p", "s", 60),
      done("old", "p", 60),
      exec({ id: "live", parentId: "p" }),
    ],
    "s",
  );
  expect(foldable(p as NonNullable<typeof p>, none, NOW)).toBe(false);
  const [q] = buildForest([done("q", "s", 60), done("c", "q", 60)], "s");
  expect(foldable(q as NonNullable<typeof q>, none, NOW)).toBe(true);
});

test("拆分：现状视图收起过期的并给总数（含后代）与最近 3 个；其余视图原样", () => {
  const kids = buildForest(
    [
      exec({ id: "live", parentId: "s" }),
      done("a", "s", 30),
      done("b", "s", 20),
      done("c", "s", 90),
      done("d", "s", 15),
      done("a1", "a", 30),
    ],
    "s",
  );
  const now = splitKids(kids, true, none, NOW);
  expect(now.shown.map((n) => n.id)).toEqual(["live"]);
  expect(now.folded.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  expect(now.count).toBe(5);
  expect(now.latest.map((n) => n.id)).toEqual(["d", "b", "a"]);
  const all = splitKids(kids, false, none, NOW);
  expect(all.shown).toHaveLength(5);
  expect(all.folded).toHaveLength(0);
});

test("多久之前：不到 1 分钟 / 分钟 / 小时", () => {
  expect(agoText(20_000)).toBe("刚刚");
  expect(agoText(3 * 60_000 + 5000)).toBe("3 分钟前");
  expect(agoText(125 * 60_000)).toBe("2 小时前");
});
