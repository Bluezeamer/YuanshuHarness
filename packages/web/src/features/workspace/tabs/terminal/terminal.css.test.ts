// @vitest-environment node
// 终端尺寸回归（A6/B23）：.ws-term-screen 是 FitAddon 的父元素。border-box 下
// getComputedStyle().height 含 padding，FitAddon 会把它当成可用高度，导致 rows
// 高估、xterm 网格比可视区高，最后一行被祖先 overflow:hidden 裁掉且无法滚动查看。
// 因此这块挂载盒的留白只能用 inset，padding 必须保持 0。
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = readFileSync(
  new URL("./terminal.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const block = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(m, `terminal.css 里缺少 ${selector} 规则`).not.toBeNull();
  return m?.[1] ?? "";
};

test("xterm 挂载点用 inset 留白，不带 padding", () => {
  const body = block(".ws-term-screen");
  expect(body).toMatch(/(^|;|\s)inset\s*:/);
  expect(body).not.toMatch(/(^|;|\s)padding(-[a-z]+)?\s*:/);
  expect(body).toMatch(/position\s*:\s*absolute/);
});
