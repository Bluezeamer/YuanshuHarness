import { expect, test } from "vitest";
import { flushLocal } from "../../../../app/localState";
import {
  readTreeView,
  toggleAll,
  treeViewKey,
  writeTreeView,
} from "./treeView";

const flush = () => flushLocal();

test("浏览状态：没存过是空的；存了读回来；键里带环境与目录，不同项目互不串", () => {
  expect(readTreeView("k")).toEqual({ open: [], scroll: 0 });
  writeTreeView("k", { open: ["产品", "产品/访谈"], scroll: 120 });
  flush();
  expect(readTreeView("k")).toEqual({
    open: ["产品", "产品/访谈"],
    scroll: 120,
  });
  expect(treeViewKey("local", "/a")).not.toBe(treeViewKey("local", "/b"));
  expect(treeViewKey("local", "/a")).not.toBe(treeViewKey("h1", "/a"));
});

test("浏览状态：存坏了、字段类型不对都退回空；负的滚动位置当 0", () => {
  for (const raw of ["{oops", "null", '"x"', "[]"]) {
    localStorage.setItem("k", raw);
    expect(readTreeView("k")).toEqual({ open: [], scroll: 0 });
  }
  localStorage.setItem(
    "k",
    JSON.stringify({ open: ["a", 3, null], scroll: -5 }),
  );
  expect(readTreeView("k")).toEqual({ open: ["a"], scroll: 0 });
  localStorage.setItem("k", JSON.stringify({ open: "a", scroll: "x" }));
  expect(readTreeView("k")).toEqual({ open: [], scroll: 0 });
});

test("全部展开 / 折叠一个按钮：有展开的就全部折叠，都没展开就全部展开，来回切换", () => {
  const folders = ["产品", "产品/访谈", "归档"];
  let state = toggleAll(new Set(), folders);
  expect(state.anyOpen).toBe(false);
  expect([...state.open].sort()).toEqual([...folders].sort());
  state = toggleAll(state.open, folders);
  expect(state.anyOpen).toBe(true);
  expect(state.open.size).toBe(0);
  state = toggleAll(state.open, folders);
  expect(state.open.size).toBe(3);
  // 只展开了一部分：先全部折叠
  expect(toggleAll(new Set(["归档"]), folders)).toEqual({
    anyOpen: true,
    open: new Set(),
  });
  // 记着的展开项里有已经不存在的文件夹：不算展开着
  expect(toggleAll(new Set(["已删"]), folders).anyOpen).toBe(false);
});
