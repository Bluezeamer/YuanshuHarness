import { describe, expect, test } from "vitest";
import { resolveLink, rewriteForMoves, scanWikilinks } from "./wikilink.js";

describe("scanWikilinks", () => {
  test("取出目标，去重、保持出现顺序；别名与 #标题 部分不算", () => {
    expect(
      scanWikilinks(
        "见 [[想法.canvas]]，[[设计原则|原则]]、[[设计原则#取舍]]、[[产品/用户研究.md]]",
      ),
    ).toEqual(["想法.canvas", "设计原则", "产品/用户研究.md"]);
  });

  test("目标规范化：反斜杠、开头的 ./ 与 / 与 .canvas/ 去掉；空目标丢掉", () => {
    expect(
      scanWikilinks("[[./a.md]] [[/b.md]] [[.canvas/c.md]] [[d\\e.md]]"),
    ).toEqual(["a.md", "b.md", "c.md", "d/e.md"]);
    expect(scanWikilinks("[[ ]] [[]] [[|x]]")).toEqual([]);
  });

  test("围栏代码块与行内代码里的不算；跨行的不算", () => {
    expect(scanWikilinks("[[a]]\n```\n[[b]]\n```\n`[[c]]` [[d\n]]")).toEqual([
      "a",
    ]);
  });
});

describe("resolveLink", () => {
  const known = new Set(["a.md", "a.canvas", "x/b.md", "c.canvas"]);

  test("先按原样、再补 .md、再补 .canvas", () => {
    expect(resolveLink("a.canvas", known)).toBe("a.canvas");
    expect(resolveLink("a", known)).toBe("a.md");
    expect(resolveLink("c", known)).toBe("c.canvas");
    expect(resolveLink("x/b", known)).toBe("x/b.md");
  });

  test("找不到是 null", () => {
    expect(resolveLink("nope", known)).toBeNull();
    expect(resolveLink("b", known)).toBeNull();
  });
});

describe("rewriteForMoves", () => {
  const known = new Set(["a.md", "x/b.md", "c.canvas", "d.md", "d.canvas"]);
  const moves = new Map([
    ["a.md", "y/a2.md"],
    ["c.canvas", "c2.canvas"],
  ]);

  test("指向被挪走文件的链接改到新位置；别名、#标题、写没写扩展名都照原样；没挪的不动", () => {
    expect(
      rewriteForMoves(
        "[[a]] [[a.md]] [[a|别名]] [[a#标题]] [[./a]] [[c.canvas]] [[c]] [[x/b]]",
        moves,
        known,
      ),
    ).toBe(
      "[[y/a2]] [[y/a2.md]] [[y/a2|别名]] [[y/a2#标题]] [[y/a2]] [[c2.canvas]] [[c2]] [[x/b]]",
    );
  });

  test("代码里的、指不到已知文件的不动；没有 [[ 的原样返回", () => {
    const t = "`[[a]]` ```\n[[a]]\n``` [[不存在]] [[ ]]";
    expect(rewriteForMoves(t, moves, known)).toBe(t);
    expect(rewriteForMoves("没有链接", moves, known)).toBe("没有链接");
  });

  test("原来没写扩展名、去掉后会指到别的文件时保留扩展名", () => {
    // [[c]] 原本只能指到 c.canvas；改名成 d.canvas 后，d 先会指到 d.md，所以必须写成 d.canvas
    const m = new Map([["c.canvas", "d.canvas"]]);
    expect(rewriteForMoves("[[c]]", m, known)).toBe("[[d.canvas]]");
  });
});
