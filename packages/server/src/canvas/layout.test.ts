import { describe, expect, test } from "vitest";
import {
  boardFile,
  cardFile,
  cardsDir,
  classify,
  insideCanvas,
  isCleanPath,
  noteAssetsDir,
  sanitizeName,
  sanitizePath,
  splitLeaf,
  timeName,
  uniqueName,
} from "./layout.js";

describe("路径", () => {
  test("画布、资源文件夹与卡片路径都相对 .canvas/、用 /", () => {
    expect(boardFile("产品想法")).toBe("产品想法.canvas");
    expect(cardsDir("产品想法")).toBe("产品想法.cards");
    expect(cardFile("产品想法", "风险")).toBe("产品想法.cards/风险.md");
  });

  test("classify 认出四类路径，卡片带画布名", () => {
    expect(classify("x.canvas")).toEqual({ kind: "board", board: "x" });
    expect(classify("x.cards/a.md")).toEqual({
      kind: "card",
      board: "x",
    });
    expect(classify("index.md")).toEqual({ kind: "index" });
    expect(classify("../docs/design.md")).toEqual({ kind: "ref" });
    // 笔记：树里任意位置的 .md（点开头的目录除外）；画布名是不带后缀的路径，旧的 boards/ 也只是普通子目录
    expect(classify("a.md")).toEqual({ kind: "note" });
    expect(classify("notes/sub/a.md")).toEqual({ kind: "note" });
    expect(classify(".git/a.md")).toEqual({ kind: "other" });
    expect(classify("notes/a.txt")).toEqual({ kind: "other" });
    expect(classify("产品/时间线.canvas")).toEqual({
      kind: "board",
      board: "产品/时间线",
    });
    expect(classify("boards/x.cards/a.md")).toEqual({
      kind: "card",
      board: "boards/x",
    });
    // 笔记的图片：<文件夹>/.assets/<笔记名>/<文件>（根目录的笔记在 .assets/ 下）；不是画布「产品/」的资源
    expect(classify("产品/.assets/访谈/a.png")).toEqual({ kind: "noteAsset" });
    expect(classify(".assets/总览/_large/v.mp4")).toEqual({
      kind: "noteAsset",
    });
    expect(classify(".assets/总览")).toEqual({ kind: "other" });
    expect(noteAssetsDir("产品/访谈.md")).toBe("产品/.assets/访谈");
    expect(noteAssetsDir("总览.md")).toBe(".assets/总览");
    // 画布自己的资源（含放大文件的子文件夹）；文件夹本身不是资源
    expect(classify("x.assets/p.png")).toEqual({
      kind: "asset",
      board: "x",
    });
    expect(classify("x.assets/_large/v.mp4")).toEqual({
      kind: "asset",
      board: "x",
    });
    expect(classify("x.assets")).toEqual({ kind: "other" });
    expect(classify("x.assets/")).toEqual({ kind: "other" });
  });

  test("画布名是路径：isCleanPath 逐段检查，sanitizePath 逐段清洗，splitLeaf 拆出目录", () => {
    expect(isCleanPath("想法")).toBe(true);
    expect(isCleanPath("产品/时间线")).toBe(true);
    for (const bad of ["", "a//b", "/a", "a/", "../a", "a/../b", "a:b", ".h"])
      expect(isCleanPath(bad)).toBe(false);
    expect(sanitizePath(" 产品 / 时间线 ")).toBe("产品/时间线");
    expect(sanitizePath("a\\b//c")).toBe("a/b/c");
    expect(sanitizePath("../x")).toBe("x");
    expect(sanitizePath("//")).toBe("");
    expect(splitLeaf("产品/时间线")).toEqual({ dir: "产品/", leaf: "时间线" });
    expect(splitLeaf("想法")).toEqual({ dir: "", leaf: "想法" });
  });

  test("insideCanvas 拒绝逃出 .canvas/ 与绝对路径", () => {
    expect(insideCanvas("x.canvas")).toBe(true);
    expect(insideCanvas("x.cards/a.md")).toBe(true);
    expect(insideCanvas("../secret")).toBe(false);
    expect(insideCanvas("../../x")).toBe(false);
    expect(insideCanvas("/etc/passwd")).toBe(false);
    expect(insideCanvas("C:/x")).toBe(false);
    expect(insideCanvas("")).toBe(false);
    expect(insideCanvas("a\0b")).toBe(false);
  });
});

describe("命名", () => {
  test("清洗非法字符、首尾点与空白，合法字符原样保留", () => {
    expect(sanitizeName("  风险 与 布局  ")).toBe("风险 与 布局");
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
    expect(sanitizeName(".hidden.")).toBe("hidden");
    expect(sanitizeName("多   空格")).toBe("多 空格");
    expect(sanitizeName("...")).toBe("");
    expect(sanitizeName("x".repeat(200))).toHaveLength(80);
  });

  test("timeName 用本地时间 YYYYMMDD-HHmmss", () => {
    expect(timeName(new Date(2026, 10, 4, 9, 5, 7))).toBe("20261104-090507");
    expect(timeName(new Date(2026, 0, 1, 23, 59, 59))).toBe("20260101-235959");
  });

  test("uniqueName 重名加序号，比较不区分大小写", () => {
    expect(uniqueName(new Set(), "风险")).toBe("风险");
    expect(uniqueName(new Set(["风险"]), "风险")).toBe("风险 (2)");
    expect(uniqueName(new Set(["风险", "风险 (2)"]), "风险")).toBe("风险 (3)");
    expect(uniqueName(new Set(["Risk"]), "risk")).toBe("risk (2)");
  });
});
