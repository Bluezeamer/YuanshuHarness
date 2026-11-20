// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const dir = fileURLToPath(new URL("./", import.meta.url));
// 去掉注释再查：注释里可以讲「为什么不用」。
const strip = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = readdirSync(dir)
  .filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ f, text: strip(readFileSync(`${dir}${f}`, "utf8")) }));

test("对话流滚动用 scrollTop 计算，不用 scrollIntoView（会带动嵌入预览整页滚动）", () => {
  for (const { f, text } of sources)
    expect(text, f).not.toContain("scrollIntoView");
});

test("D2：状态条展开态只能叫 data-csx-open，不得复用全站的 data-open", () => {
  for (const { f, text } of sources)
    expect(text, f).not.toMatch(/data-open\b|dataset\.open\b/);
});

test("单文件不超过 500 行", () => {
  for (const { f, text } of sources)
    expect(text.split("\n").length, f).toBeLessThanOrEqual(500);
});

test("CSS 类名全部带 ch- 前缀", () => {
  for (const { f, text } of sources.filter((s) => s.f.endsWith(".css"))) {
    const classes =
      text
        .replace(/@import[^;]*;/g, "")
        .match(/\.[a-zA-Z][\w-]*(?=[\s,.:{[>+~)])/g) ?? [];
    for (const c of classes)
      expect(c, `${f}: ${c}`).toMatch(/^\.(ch-|u-|is-|mono)/);
  }
});

const css = (f: string) => readFileSync(`${dir}${f}`, "utf8");

test("停靠区样式契约：卡间距 8px、与对话流同一条 720 阅读列、输入卡圆角 14", () => {
  const dock = css("chat.dock.css");
  expect(dock).toMatch(/\.ch-dock\s*\{[^}]*gap:\s*8px/s);
  expect(dock).toMatch(/\.ch-dock > \*\s*\{[^}]*max-width:\s*720px/s);
  expect(css("chat.composer.css")).toMatch(
    /\.ch-box\s*\{[^}]*border-radius:\s*14px/s,
  );
  expect(css("chat.composer.css")).not.toMatch(
    /\.ch-composer\s*\{[^}]*border-top/s,
  );
});

test("页脚样式契约：发丝线隔开、整行居中；窄于 440px 先收掉速度项", () => {
  const s = css("chat.foot.css");
  expect(s).toMatch(
    /\.ch-foot\s*\{[^}]*justify-content:\s*center[^}]*border-top:\s*1px solid var\(--line\)/s,
  );
  expect(s).toMatch(
    /@container \(max-width: 440px\)[\s\S]*data-foot="speed"[\s\S]*display:\s*none/,
  );
});
