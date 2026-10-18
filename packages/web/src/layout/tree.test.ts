import { expect, test } from "vitest";
import {
  addTab,
  layout,
  MIN_RATIO,
  neighbor,
  paneIds,
  remove,
  repair,
  resize,
  selectTab,
  split,
  tabGroups,
  visibleIds,
} from "./tree";
import type { TreeNode } from "./types";

const leaf = (paneId: string): TreeNode => ({ kind: "leaf", paneId });
const box = { x: 0, y: 0, w: 1, h: 1 };

test("R2 分割叶子：新 pane 在后，比例对半", () => {
  const t = split(leaf("a"), "a", "h", "b");
  expect(t).toEqual({
    kind: "split",
    dir: "h",
    children: [leaf("a"), leaf("b")],
    ratios: [0.5, 0.5],
  });
});

test("R2 同向再分割并入父节点，不嵌套；占比取自被分割的那块", () => {
  const t = split(split(leaf("a"), "a", "h", "b"), "b", "h", "c");
  expect(t).toEqual({
    kind: "split",
    dir: "h",
    children: [leaf("a"), leaf("b"), leaf("c")],
    ratios: [0.5, 0.25, 0.25],
  });
});

test("R2 异向分割产生嵌套", () => {
  const t = split(split(leaf("a"), "a", "h", "b"), "b", "v", "c");
  expect(paneIds(t)).toEqual(["a", "b", "c"]);
  const r = layout(t, box);
  expect(r.get("b")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
  expect(r.get("c")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
});

test("R2 关闭 pane：兄弟占满空位，只剩一个孩子时折叠", () => {
  const t = split(leaf("a"), "a", "h", "b");
  expect(remove(t, "a")).toEqual(leaf("b"));
  const three = split(t, "b", "h", "c");
  const r = remove(three, "b");
  expect(
    r && r.kind === "split" && r.ratios.reduce((x, y) => x + y),
  ).toBeCloseTo(1);
  expect(paneIds(r)).toEqual(["a", "c"]);
});

test("R2 关闭最后一个 pane：树为空", () => {
  expect(remove(leaf("a"), "a")).toBeNull();
});

test("R2 调整尺寸：总和不变，两块都不小于最小比例", () => {
  const t = split(leaf("a"), "a", "h", "b");
  const moved = resize(t, [], 0, 0.2);
  expect(moved.kind === "split" && moved.ratios[0]).toBeCloseTo(0.7);
  const over = resize(t, [], 0, 5);
  if (over.kind !== "split") throw new Error("split expected");
  expect(over.ratios[1] ?? 0).toBeCloseTo(MIN_RATIO);
  expect((over.ratios[0] ?? 0) + (over.ratios[1] ?? 0)).toBeCloseTo(1);
  const under = resize(t, [], 0, -5);
  expect(under.kind === "split" && under.ratios[0]).toBeCloseTo(MIN_RATIO);
});

test("R16 比例之和不为 1 或长度不符：按等分修复并报告", () => {
  const bad: TreeNode = {
    kind: "split",
    dir: "h",
    children: [leaf("a"), leaf("b"), leaf("c")],
    ratios: [0.5, 0.2],
  };
  const r = repair(bad);
  expect(r.fixed).toBe(true);
  expect(r.tree.kind === "split" && r.tree.ratios).toEqual([
    1 / 3,
    1 / 3,
    1 / 3,
  ]);
  const good = split(leaf("a"), "a", "h", "b");
  expect(repair(good).fixed).toBe(false);
});

test("R6 方向键按位置找相邻 pane", () => {
  const t = split(split(leaf("a"), "a", "h", "b"), "b", "v", "c");
  const r = layout(t, box);
  expect(neighbor(r, "a", "right")).toBe("b");
  expect(neighbor(r, "b", "down")).toBe("c");
  expect(neighbor(r, "c", "up")).toBe("b");
  expect(neighbor(r, "c", "left")).toBe("a");
  expect(neighbor(r, "a", "left")).toBeNull();
});

import { dividers } from "./tree";

test("dividers：嵌套分割各给出一条线，位置和比例正确", () => {
  const t = split(
    split({ kind: "leaf", paneId: "a" }, "a", "h", "b"),
    "b",
    "v",
    "c",
  );
  const ds = dividers(t, { x: 0, y: 0, w: 1, h: 1 });
  expect(ds).toHaveLength(2);
  const top = ds.find((d) => d.path.length === 0);
  expect(top?.rect).toEqual({ x: 0.5, y: 0, w: 0, h: 1 });
  const inner = ds.find((d) => d.path.length === 1);
  expect(inner?.dir).toBe("v");
  expect(inner?.rect).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0 });
});

// R9a：tab 组
const grp = (sel: string, tabs: string[]): TreeNode => ({
  kind: "leaf",
  paneId: sel,
  tabs,
});

test("R9a tab 组：paneIds 含全部 tab，visibleIds 只含选中项", () => {
  const t: TreeNode = {
    kind: "split",
    dir: "h",
    children: [grp("b", ["a", "b"]), leaf("c")],
    ratios: [0.5, 0.5],
  };
  expect(paneIds(t)).toEqual(["a", "b", "c"]);
  expect(visibleIds(t)).toEqual(["b", "c"]);
  expect(layout(t, box).has("a")).toBe(false);
  expect(tabGroups(t, box)).toEqual([
    { rect: { x: 0, y: 0, w: 0.5, h: 1 }, selected: "b", tabs: ["a", "b"] },
  ]);
});

test("R9a addTab：并入目标所在的叶子并选中新 tab；普通叶子变 tab 组", () => {
  const t = addTab(leaf("a"), "a", "b");
  expect(t).toEqual(grp("b", ["a", "b"]));
  expect(addTab(t, "a", "c")).toEqual(grp("c", ["a", "b", "c"]));
});

test("R9a selectTab：只换选中项", () => {
  expect(selectTab(grp("b", ["a", "b"]), "a")).toEqual(grp("a", ["a", "b"]));
});

test("R9a remove：关掉选中 tab 改选相邻；剩一个退回普通叶子；组空了消失", () => {
  expect(remove(grp("b", ["a", "b", "c"]), "b")).toEqual(grp("c", ["a", "c"]));
  expect(remove(grp("c", ["a", "b", "c"]), "c")).toEqual(grp("b", ["a", "b"]));
  expect(remove(grp("a", ["a", "b", "c"]), "b")).toEqual(grp("a", ["a", "c"]));
  expect(remove(grp("b", ["a", "b"]), "b")).toEqual(leaf("a"));
});

test("R9a split 以 tab 组里的任一 pane 为目标，都分割整个组", () => {
  const t = split(grp("b", ["a", "b"]), "a", "h", "c");
  expect(t).toEqual({
    kind: "split",
    dir: "h",
    children: [grp("b", ["a", "b"]), leaf("c")],
    ratios: [0.5, 0.5],
  });
});

test("R9a repair：tabs 不含选中项或有重复时退化为普通叶子/去重", () => {
  expect(repair(grp("z", ["a", "b"])).tree).toEqual(leaf("z"));
  expect(repair(grp("a", ["a", "a", "b"])).tree).toEqual(grp("a", ["a", "b"]));
  expect(repair(grp("a", ["a"])).tree).toEqual(leaf("a"));
});
