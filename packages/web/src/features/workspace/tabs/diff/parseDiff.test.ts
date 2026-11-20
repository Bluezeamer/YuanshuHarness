// diff 行号推算：hunk 头给起点，增删各占一侧。
import { expect, test } from "vitest";
import { parseDiff } from "./parseDiff";

test("parseDiff：hunk 头之后的上下文/新增/删除各自占到正确行号", () => {
  const text = [
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -10,3 +10,4 @@",
    " line10",
    "-line11",
    "+LINE11",
    "+extra",
    " line12",
    "",
  ].join("\n");
  const rows = parseDiff(text);
  expect(rows.map((r) => [r.kind, r.a, r.b])).toEqual([
    ["meta", null, null],
    ["meta", null, null],
    ["hunk", null, null],
    ["same", 10, 10],
    ["del", 11, null],
    ["add", null, 11],
    ["add", null, 12],
    ["same", 12, 13],
  ]);
});

test("parseDiff：没有 hunk 头时从 1 起算；纯新增文件全是 add", () => {
  const rows = parseDiff("+a\n+b\n");
  expect(rows).toEqual([
    { a: null, b: 1, kind: "add", text: "a" },
    { a: null, b: 2, kind: "add", text: "b" },
  ]);
});
