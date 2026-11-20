import { expect, test } from "vitest";
import {
  dropAllowed,
  flatten,
  movesFor,
  stepIndex,
  type TreeNode,
  topLevel,
} from "./treeModel";

const f = (id: string): TreeNode => ({ id, kind: "folder" });
const i = (id: string, label?: string): TreeNode => ({
  id,
  kind: "item",
  ...(label ? { label } : {}),
});

const nodes = [
  i("想法"),
  f("产品"),
  i("产品/时间线"),
  f("产品/子"),
  i("产品/子/深"),
  i("产品/调研"),
  f("空"),
  i("设计"),
];

const ids = (rows: ReturnType<typeof flatten>) => rows.map((r) => r.node.id);

test("flatten：同一层文件夹在前、各自按名字排；只展开 open 里的文件夹；深度与展开态正确", () => {
  expect(ids(flatten(nodes, new Set()))).toEqual([
    "产品",
    "空",
    "想法",
    "设计",
  ]);
  const rows = flatten(nodes, new Set(["产品", "产品/子"]));
  expect(ids(rows)).toEqual([
    "产品",
    "产品/子",
    "产品/子/深",
    "产品/时间线",
    "产品/调研",
    "空",
    "想法",
    "设计",
  ]);
  expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 1, 0, 0, 0]);
  expect(rows[0]).toMatchObject({
    open: true,
    hasChildren: true,
    name: "产品",
  });
  expect(rows.find((r) => r.node.id === "空")).toMatchObject({
    open: false,
    hasChildren: false,
  });
  // open 里有但不是文件夹的 id 不起作用
  expect(ids(flatten(nodes, new Set(["想法"])))).toEqual([
    "产品",
    "空",
    "想法",
    "设计",
  ]);
});

test("flatten 有 query：按显示名过滤，匹配的连同祖先文件夹都显示并强制展开；label 优先于路径名", () => {
  expect(ids(flatten(nodes, new Set(), "深"))).toEqual([
    "产品",
    "产品/子",
    "产品/子/深",
  ]);
  expect(ids(flatten(nodes, new Set(), "调"))).toEqual(["产品", "产品/调研"]);
  const labeled = [f("a"), i("a/x", "显示名")];
  expect(ids(flatten(labeled, new Set(), "显示"))).toEqual(["a", "a/x"]);
  expect(ids(flatten(labeled, new Set(), "x"))).toEqual([]);
  expect(flatten(nodes, new Set(), "  ")).toHaveLength(4);
  expect(flatten(nodes, new Set(), "没有")).toEqual([]);
});

test("movesFor：拖到文件夹里取每个的最后一段，拖到根（空串）就是最后一段本身", () => {
  expect(movesFor(["a/b", "c"], "x/y")).toEqual([
    { id: "a/b", to: "x/y/b" },
    { id: "c", to: "x/y/c" },
  ]);
  expect(movesFor(["a/b"], "")).toEqual([{ id: "a/b", to: "b" }]);
});

test("dropAllowed：不能落进自己或子孙；全都已经在那个文件夹里就不算落点；空拖拽物不行", () => {
  const kind = (id: string) => nodes.find((n) => n.id === id)?.kind;
  expect(dropAllowed(["产品"], "产品", kind)).toBe(false);
  expect(dropAllowed(["产品"], "产品/子", kind)).toBe(false);
  expect(dropAllowed(["产品"], "空", kind)).toBe(true);
  // 前缀相同但不是子孙（产品2 不在 产品 里）
  expect(dropAllowed(["产品"], "产品2", kind)).toBe(true);
  expect(dropAllowed(["产品/时间线"], "产品", kind)).toBe(false);
  expect(dropAllowed(["产品/时间线"], "", kind)).toBe(true);
  expect(dropAllowed(["产品/时间线", "想法"], "产品", kind)).toBe(true);
  // 笔记可以落在以它自己名字开头的文件夹里
  expect(dropAllowed(["想法"], "想法2", kind)).toBe(true);
  expect(dropAllowed([], "空", kind)).toBe(false);
});

test("topLevel：多选时被选中文件夹里的子孙不单独算，跟着文件夹走", () => {
  expect(topLevel(["产品", "产品/时间线", "产品/子/深", "想法"])).toEqual([
    "产品",
    "想法",
  ]);
  expect(topLevel(["产品/时间线", "想法"])).toEqual(["产品/时间线", "想法"]);
});

test("stepIndex：在可见行里上下走，到头停住；没有当前行时下 = 第一行、上 = 最后一行", () => {
  const rows = flatten(nodes, new Set());
  expect(stepIndex(rows, "产品", 1)).toBe(1);
  expect(stepIndex(rows, "设计", 1)).toBe(3);
  expect(stepIndex(rows, "产品", -1)).toBe(0);
  expect(stepIndex(rows, null, 1)).toBe(0);
  expect(stepIndex(rows, null, -1)).toBe(3);
  expect(stepIndex(rows, "不在", 1)).toBe(0);
});
