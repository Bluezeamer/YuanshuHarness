import { expect, test } from "vitest";
import type { TreeNode } from "../../../api/session-nav";
import { flattenTree } from "./historyTree";

const node = (id: string, over: Partial<TreeNode> = {}): TreeNode => ({
  id,
  parentId: null,
  type: "message",
  role: "user",
  preview: id,
  timestamp: "",
  children: [],
  ...over,
});

// u1 → a1 →（分叉）u2 → a2（当前分支）/ u3 → a3（旧分支）
const fork = (): TreeNode[] => {
  const a2 = node("a2", { parentId: "u2", role: "assistant" });
  const u2 = node("u2", { parentId: "a1", children: [a2] });
  const a3 = node("a3", { parentId: "u3", role: "assistant" });
  const u3 = node("u3", { parentId: "a1", children: [a3] });
  const a1 = node("a1", {
    parentId: "u1",
    role: "assistant",
    children: [u2, u3],
  });
  const u1 = node("u1", { children: [a1] });
  return [u1];
};

const active = ["a2", "u2", "a1", "u1"];

test("单链不缩进：从根到叶一路直排，前缀为空", () => {
  const leaf = node("a1", { parentId: "u1", role: "assistant" });
  const rows = flattenTree([node("u1", { children: [leaf] })], ["a1", "u1"]);
  expect(rows.map((r) => r.node.id)).toEqual(["u1", "a1"]);
  expect(rows.map((r) => r.prefix)).toEqual(["", ""]);
  expect(rows.map((r) => r.active)).toEqual([true, true]);
});

test("只在分叉点分叉：分叉的子节点带 ├─/└─，单链子孙继续缩进但不分叉", () => {
  const rows = flattenTree(fork(), active);
  expect(rows.map((r) => r.node.id)).toEqual([
    "u1",
    "a1",
    "u2",
    "a2",
    "u3",
    "a3",
  ]);
  expect(rows.map((r) => r.prefix)).toEqual([
    "",
    "",
    "├─",
    "│   ",
    "└─",
    "    ",
  ]);
  // 当前 activePath 上的节点高亮；旧分支不高亮
  expect(rows.map((r) => r.active)).toEqual([
    true,
    true,
    true,
    true,
    false,
    false,
  ]);
});

test("分叉处把当前 active 分支排在前面（即使原始顺序相反）", () => {
  const roots = fork();
  const a1 = roots[0]?.children[0] as TreeNode;
  a1.children = [...a1.children].reverse(); // [u3, u2]，当前分支在后
  const rows = flattenTree(roots, active);
  expect(rows.map((r) => r.node.id)).toEqual([
    "u1",
    "a1",
    "u2",
    "a2",
    "u3",
    "a3",
  ]);
  expect(rows[2]?.isLast).toBe(false);
  expect(rows[4]?.isLast).toBe(true);
});

test("分叉点可折叠：折叠后隐藏整棵子树并记下节点数，重新展开还原", () => {
  const collapsed = flattenTree(fork(), active, new Set(["a1"]));
  expect(collapsed.map((r) => r.node.id)).toEqual(["u1", "a1"]);
  expect(collapsed[1]).toMatchObject({
    foldable: true,
    folded: true,
    hidden: 4,
  });

  const expanded = flattenTree(fork(), active);
  expect(expanded[1]).toMatchObject({
    foldable: true,
    folded: false,
    hidden: 0,
  });
  // 单链节点不是分叉点，没有折叠按钮
  expect(expanded.find((r) => r.node.id === "u2")?.foldable).toBe(false);
});
