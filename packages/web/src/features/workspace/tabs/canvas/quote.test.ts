import { expect, test } from "vitest";
import { canvasFileLabel, linesOf, wholeLines } from "./quote";

test("来源标签：主机名:绝对路径（落在 .canvas 里）:行号区间；单行不写区间；没有行号只写路径", () => {
  expect(
    canvasFileLabel("Server", "/p", "产品/访谈.md", { from: 3, to: 5 }),
  ).toBe("Server:/p/.canvas/产品/访谈.md:L3-L5");
  expect(canvasFileLabel("Server", "/p", "a.md", { from: 4, to: 4 })).toBe(
    "Server:/p/.canvas/a.md:L4",
  );
  expect(canvasFileLabel("GPU 机", "/srv/x/", "a.md", null)).toBe(
    "GPU 机:/srv/x/.canvas/a.md",
  );
});

test("整个文件的行数：末尾的换行不算一行", () => {
  expect(wholeLines("a\nb\nc\n")).toEqual({ from: 1, to: 3 });
  expect(wholeLines("a\nb\nc")).toEqual({ from: 1, to: 3 });
  expect(wholeLines("")).toEqual({ from: 1, to: 1 });
});

test("选中文字在原文里的行号区间：多行、单行、找不到", () => {
  const src = "# 标题\n\n第一段\n第二行\n\n末段\n";
  expect(linesOf(src, "第一段\n第二行")).toEqual({ from: 3, to: 4 });
  expect(linesOf(src, "末段")).toEqual({ from: 6, to: 6 });
  expect(linesOf(src, "  末段\n")).toEqual({ from: 6, to: 6 });
  expect(linesOf(src, "不存在")).toBeNull();
  expect(linesOf(src, "   ")).toBeNull();
});
