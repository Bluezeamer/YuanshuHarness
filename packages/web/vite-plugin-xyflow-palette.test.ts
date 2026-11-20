// 构建期色值改写：base.css 里的色值必须全部映射到调色板变量，否则构建失败。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { paletteRewrite } from "./vite-plugin-xyflow-palette";

const require = createRequire(import.meta.url);
const baseCss = readFileSync(
  require.resolve("@xyflow/react/dist/base.css"),
  "utf8",
);

test("base.css 的色值全部被映射成调色板变量，不留裸色值", () => {
  const { css, leftover } = paletteRewrite(baseCss);
  expect(leftover).toEqual([]);
  // 确实替换过：上游的灰值不该再出现
  expect(css).not.toContain("#b1b1b7");
  expect(css).not.toContain("rgba(");
  // 我们的变量进来了
  expect(css).toContain("var(--border-strong)");
  expect(css).toContain("color-mix(in oklch, var(--accent) 10%, transparent)");
});

test("结构样式没有被破坏（关键选择器仍在）", () => {
  const { css } = paletteRewrite(baseCss);
  for (const sel of [
    ".react-flow__node",
    ".react-flow__handle",
    ".react-flow__edge",
    ".react-flow__selection",
    ".react-flow__viewport",
  ])
    expect(css).toContain(sel);
});

test("遇到未登记色值会被识别出来（升级 xyflow 时的护栏）", () => {
  const { leftover } = paletteRewrite(".x { color: #ff00ff; }");
  expect(leftover).toEqual(["#ff00ff"]);
});
