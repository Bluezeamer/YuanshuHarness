import { describe, expect, it } from "vitest";
import {
  type Branch,
  insertBeside,
  isBranch,
  leaves,
  mapLeaves,
  normSizes,
  removeLeaf,
  setSizesAt,
  type Tree,
} from "./tree";

interface Leaf {
  k: string;
}
const L = (k: string): Leaf => ({ k });
const row = (...children: Tree<Leaf>[]): Branch<Tree<Leaf>> => ({
  dir: "row",
  sizes: children.map(() => 1),
  children,
});
const col = (...children: Tree<Leaf>[]): Branch<Tree<Leaf>> => ({
  dir: "col",
  sizes: children.map(() => 1),
  children,
});
const keys = (n: Tree<Leaf> | null) => leaves<Leaf>(n).map((l) => l.k);
const isTarget = (k: string) => (l: Leaf) => l.k === k;

describe("isBranch / leaves", () => {
  it("区分叶子与分支，叶子深度优先从左到右", () => {
    expect(isBranch(L("a"))).toBe(false);
    expect(isBranch(row(L("a"), L("b")))).toBe(true);
    expect(keys(row(L("a"), col(L("b"), L("c")), L("d")))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(leaves<Leaf>(null)).toEqual([]);
  });
});

describe("normSizes", () => {
  it("缺的补 1，非正数/非数字变 1，多的截掉", () => {
    expect(normSizes({ sizes: [2, 3], children: [1, 2, 3] })).toEqual([
      2, 3, 1,
    ]);
    expect(
      normSizes({
        sizes: [0, -1, Number.NaN, "x", 4],
        children: [1, 2, 3, 4, 5],
      }),
    ).toEqual([1, 1, 1, 1, 4]);
    expect(normSizes({ sizes: [5, 6, 7], children: [1] })).toEqual([5]);
    expect(normSizes({ sizes: undefined, children: [1, 2] })).toEqual([1, 1]);
    expect(normSizes({ sizes: "oops", children: [1] })).toEqual([1]);
  });
});

describe("removeLeaf", () => {
  it("剩一个孩子的分支被提升，剩零个返回 null", () => {
    const t = row(L("a"), L("b"));
    expect(removeLeaf<Leaf>(t, isTarget("a"))).toEqual(L("b"));
    expect(removeLeaf<Leaf>(L("a"), isTarget("a"))).toBeNull();
    expect(removeLeaf<Leaf>(t, () => true)).toBeNull();
  });

  it("保留下来的孩子带着各自的 size", () => {
    const t: Tree<Leaf> = {
      dir: "row",
      sizes: [3, 5, 7],
      children: [L("a"), L("b"), L("c")],
    };
    const r = removeLeaf<Leaf>(t, isTarget("b"));
    expect(r).toEqual({
      dir: "row",
      sizes: [3, 7],
      children: [L("a"), L("c")],
    });
  });

  it("嵌套分支塌缩时向上折叠", () => {
    const t = row(L("a"), col(L("b"), L("c")));
    expect(removeLeaf<Leaf>(t, isTarget("c"))).toEqual({
      dir: "row",
      sizes: [1, 1],
      children: [L("a"), L("b")],
    });
  });
});

describe("insertBeside", () => {
  it("目标是叶子根：按落点方向包成二叉分支，left/top 放前面", () => {
    expect(insertBeside<Leaf>(L("a"), isTarget("a"), "right", L("n"))).toEqual({
      dir: "row",
      sizes: [1, 1],
      children: [L("a"), L("n")],
    });
    expect(insertBeside<Leaf>(L("a"), isTarget("a"), "top", L("n"))).toEqual({
      dir: "col",
      sizes: [1, 1],
      children: [L("n"), L("a")],
    });
  });

  it("父分支方向一致：同层插入、不增加嵌套，其余 size 不变", () => {
    const t: Tree<Leaf> = {
      dir: "row",
      sizes: [2, 3],
      children: [L("a"), L("b")],
    };
    const r = insertBeside<Leaf>(t, isTarget("a"), "right", L("n"));
    expect(r).toEqual({
      dir: "row",
      sizes: [2, 1, 3],
      children: [L("a"), L("n"), L("b")],
    });
    const l = insertBeside<Leaf>(t, isTarget("b"), "left", L("n"));
    expect(keys(l)).toEqual(["a", "n", "b"]);
  });

  it("父分支方向不同：目标叶子被替换成新的二叉分支", () => {
    const r = insertBeside<Leaf>(
      row(L("a"), L("b")),
      isTarget("b"),
      "bottom",
      L("n"),
    );
    expect(r).toEqual({
      dir: "row",
      sizes: [1, 1],
      children: [
        L("a"),
        { dir: "col", sizes: [1, 1], children: [L("b"), L("n")] },
      ],
    });
  });

  it("目标在更深层时递归插入", () => {
    const r = insertBeside<Leaf>(
      row(L("a"), col(L("b"), L("c"))),
      isTarget("c"),
      "bottom",
      L("n"),
    );
    expect(keys(r)).toEqual(["a", "b", "c", "n"]);
  });

  it("找不到目标时返回同一个引用", () => {
    const t = row(L("a"), L("b"));
    expect(insertBeside<Leaf>(t, isTarget("zzz"), "left", L("n"))).toBe(t);
    const leaf = L("a");
    expect(insertBeside<Leaf>(leaf, isTarget("zzz"), "left", L("n"))).toBe(
      leaf,
    );
  });

  it("不改动输入", () => {
    const t = row(L("a"), L("b"));
    const snap = JSON.stringify(t);
    insertBeside<Leaf>(t, isTarget("a"), "right", L("n"));
    expect(JSON.stringify(t)).toBe(snap);
  });
});

describe("mapLeaves", () => {
  it("只改叶子，分支结构与 sizes 保持，输入不被改动", () => {
    const t: Tree<Leaf> = {
      dir: "col",
      sizes: [2, 1],
      children: [L("a"), row(L("b"), L("c"))],
    };
    const snap = JSON.stringify(t);
    const r = mapLeaves<Leaf>(t, (l) => ({ k: l.k.toUpperCase() }));
    expect(keys(r)).toEqual(["A", "B", "C"]);
    expect(isBranch(r) && r.sizes).toEqual([2, 1]);
    expect(JSON.stringify(t)).toBe(snap);
  });
});

describe("setSizesAt", () => {
  const t: Tree<Leaf> = row(L("a"), col(L("b"), L("c")));

  it("根路径与深层路径都能写入", () => {
    const r1 = setSizesAt<Leaf>(t, [], [2, 3]);
    expect(r1 && isBranch(r1) && r1.sizes).toEqual([2, 3]);
    const r2 = setSizesAt<Leaf>(t, [1], [4, 1]);
    const inner = r2 && isBranch(r2) ? r2.children[1] : null;
    expect(inner && isBranch(inner) && inner.sizes).toEqual([4, 1]);
  });

  it("路径越界 / 指到叶子 / 长度不符 / 非正数 一律拒绝", () => {
    expect(setSizesAt<Leaf>(t, [5], [1, 1])).toBeNull();
    expect(setSizesAt<Leaf>(t, [0], [1])).toBeNull();
    expect(setSizesAt<Leaf>(t, [], [1])).toBeNull();
    expect(setSizesAt<Leaf>(t, [], [1, 0])).toBeNull();
    expect(setSizesAt<Leaf>(t, [], [1, Number.NaN])).toBeNull();
    expect(setSizesAt<Leaf>(L("a"), [], [])).toBeNull();
  });
});
