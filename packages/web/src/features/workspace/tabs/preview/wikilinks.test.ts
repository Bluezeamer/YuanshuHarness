import { expect, test } from "vitest";
import {
  canvasRootOf,
  linkWikilinks,
  resolveWikilink,
  wikiTargetOf,
} from "./wikilinks";

test("[[目标]] 与 [[目标|别名]] 换成 wikilink: 链接，别名当文字；#标题 部分不要；目标里的括号与空格编码掉", () => {
  expect(linkWikilinks("见 [[设计原则]] 和 [[产品/用户研究|研究]]")).toBe(
    "见 [设计原则](wikilink:%E8%AE%BE%E8%AE%A1%E5%8E%9F%E5%88%99) 和 [研究](wikilink:%E4%BA%A7%E5%93%81%2F%E7%94%A8%E6%88%B7%E7%A0%94%E7%A9%B6)",
  );
  expect(linkWikilinks("[[a#标题]]")).toBe("[a](wikilink:a)");
  expect(linkWikilinks("[[a (1) b]]")).toBe(
    "[a \\(1\\) b](wikilink:a%20%281%29%20b)",
  );
  // 文字里的 markdown 记号转义，不会变成强调
  expect(linkWikilinks("[[a|*x*]]")).toBe("[\\*x\\*](wikilink:a)");
});

test("围栏代码块与行内代码里的 [[…]] 不动；空目标与跨行的不动", () => {
  const src = "```\n[[a]]\n```\n`[[b]]` [[ ]] [[c\nd]]";
  expect(linkWikilinks(src)).toBe(src);
  expect(linkWikilinks("[[x]]\n```\n[[y]]\n```\n[[z]]")).toBe(
    "[x](wikilink:x)\n```\n[[y]]\n```\n[z](wikilink:z)",
  );
});

test("wikiTargetOf 解出目标；不是 wikilink 或编码坏了是 null", () => {
  expect(wikiTargetOf("wikilink:%E4%BA%A7%E5%93%81%2Fa")).toBe("产品/a");
  expect(wikiTargetOf("https://x.dev")).toBeNull();
  expect(wikiTargetOf(undefined)).toBeNull();
  expect(wikiTargetOf("wikilink:%E0%A4%A")).toBeNull();
});

test("canvasRootOf：文件在 .canvas/ 里才处理 wikilink，给出目录与 .canvas 的路径", () => {
  expect(canvasRootOf("/p/proj/.canvas/产品/a.md")).toEqual({
    dir: "/p/proj",
    root: "/p/proj/.canvas",
  });
  expect(canvasRootOf("/p/proj/docs/a.md")).toBeNull();
});

test("resolveWikilink：.canvas 结尾是画布（名字不带后缀），其余是笔记，缺 .md 补上；开头的 ./ 与 .canvas/ 去掉", () => {
  const root = "/p/.canvas";
  expect(resolveWikilink(root, "产品/时间线.canvas")).toEqual({
    kind: "canvas",
    board: "产品/时间线",
  });
  expect(resolveWikilink(root, "设计原则")).toEqual({
    kind: "note",
    abs: "/p/.canvas/设计原则.md",
  });
  expect(resolveWikilink(root, "./.canvas/a/b.md")).toEqual({
    kind: "note",
    abs: "/p/.canvas/a/b.md",
  });
});
