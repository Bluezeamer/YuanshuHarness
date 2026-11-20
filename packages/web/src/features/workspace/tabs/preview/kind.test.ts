// 扩展名判定与体积阈值：新增格式都走这张表，别让 PreviewTab 里再散落判断。
import { expect, test } from "vitest";
import { kindByExt } from "./kind";
import { IMAGE_MAX, PARSE_MAX, PDF_MAX, TEXT_MAX } from "./limits";

test("kindByExt：常见文档格式都能判出来", () => {
  expect(kindByExt("/a/b.docx")).toEqual({ kind: "docx" });
  expect(kindByExt("c.doc")).toEqual({ kind: "docx" });
  expect(kindByExt("t.xlsx")).toEqual({ kind: "sheet" });
  expect(kindByExt("t.xls")).toEqual({ kind: "sheet" });
  expect(kindByExt("t.csv")).toEqual({ kind: "sheet" });
  expect(kindByExt("t.pptx")).toEqual({ kind: "pptx" });
  expect(kindByExt("book.epub")).toEqual({ kind: "epub" });
  expect(kindByExt("i.html")).toEqual({ kind: "html" });
  expect(kindByExt("i.htm")).toEqual({ kind: "html" });
  expect(kindByExt("conf.json")).toEqual({ kind: "json" });
  expect(kindByExt("x.pdf")).toEqual({ kind: "pdf" });
  expect(kindByExt("x.md")).toEqual({ kind: "markdown" });
  expect(kindByExt("x.png")).toEqual({ kind: "image", mime: "image/png" });
  // 认不出的仍交给内容判断
  expect(kindByExt("weird.zzz")).toBeNull();
  expect(kindByExt("Makefile")).toBeNull();
});

test("阈值：解析类 20MB、文本 5MB、图片 5MB、PDF 100MB", () => {
  expect(PARSE_MAX).toBe(20 * 1024 * 1024);
  expect(TEXT_MAX).toBe(5 * 1024 * 1024);
  expect(IMAGE_MAX).toBe(5 * 1024 * 1024);
  expect(PDF_MAX).toBe(100 * 1024 * 1024);
});
