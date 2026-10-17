// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const srcDir = new URL("./", import.meta.url);
const sources = readdirSync(srcDir)
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .map((f) => ({ f, text: readFileSync(new URL(f, srcDir), "utf8") }));
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("R2 风格变量文件之外没有写死色值", () => {
  for (const { f, text } of sources) {
    if (f === "styles.css") continue;
    expect(text, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  }
});

test("R2 不引用第三方域名的资源", () => {
  for (const { f, text } of [...sources, { f: "index.html", text: html }]) {
    expect(text, f).not.toMatch(/https?:\/\//);
  }
});

test("R9 样式表尊重 prefers-reduced-motion", () => {
  const css = sources.find((x) => x.f === "styles.css")?.text ?? "";
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
});
