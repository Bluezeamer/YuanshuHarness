// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { build } from "vite";
import { expect, test } from "vitest";

const srcDir = new URL("./", import.meta.url);
const sources = readdirSync(srcDir)
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .map((f) => ({ f, text: readFileSync(new URL(f, srcDir), "utf8") }));
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const config = readFileSync(
  new URL("../vite.config.ts", import.meta.url),
  "utf8",
);
const HEX = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
// 协议相对地址（//host/x）同样会向第三方发请求。
const REMOTE =
  /https?:\/\/|(?:src|href)=["']?\/\/|url\(["']?\/\/|@import\s+["']?\/\//;

test("R2 风格变量文件之外没有写死色值", () => {
  for (const { f, text } of [
    ...sources,
    { f: "index.html", text: html },
    { f: "vite.config.ts", text: config },
  ]) {
    if (f === "styles.css") continue;
    expect(text, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  }
});

test("R12 源码不用 Tailwind 内置的黑白，一律走调色板变量", () => {
  for (const { f, text } of sources) {
    expect(text, f).not.toMatch(
      /\b(?:text|bg|border|ring|fill|stroke)-(?:white|black)\b/,
    );
  }
});

test("R2 不引用第三方域名的资源", () => {
  for (const { f, text } of [...sources, { f: "index.html", text: html }]) {
    expect(text, f).not.toMatch(REMOTE);
  }
});

// 内存里真构建一次，不写盘。React 的报错文案里有 https 链接，那是字符串不是资源，所以 JS 只查色值。
test("R2 构建产物：色值只剩调色板变量与 Tailwind 自带的 #0000 / #fff；没有第三方资源引用", async () => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const out = (await build({
    logLevel: "silent",
    mode: "production",
    build: { write: false },
  }).finally(() => {
    process.env.NODE_ENV = env;
  })) as {
    output: {
      fileName: string;
      type: string;
      code?: string;
      source?: string | Uint8Array;
    }[];
  };
  const files = out.output.map((o) => ({
    name: o.fileName,
    text: String(o.type === "chunk" ? o.code : o.source),
  }));
  expect(files.some((f) => f.name.endsWith(".css"))).toBe(true);
  for (const { name, text } of files) {
    if (name.endsWith(".js")) {
      expect(text.match(new RegExp(HEX, "g")) ?? [], name).toEqual([]);
      continue;
    }
    // 调色板变量声明，以及 Tailwind 的相对色语法特性探测（不是颜色）。
    const rest = text
      .replace(/--[\w-]+:\s*#[0-9a-fA-F]{3,8}\b/g, "")
      .replace("color:rgb(from red r g b)", "");
    const found = rest.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
    expect(
      found.filter((c) => c !== "#0000" && c !== "#fff"),
      name,
    ).toEqual([]);
    // Tailwind 文件头的许可注释里有网址，注释不会发请求。
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.match(new RegExp(REMOTE, "g")) ?? [], name).toEqual([]);
  }
});

test("R9 样式表尊重 prefers-reduced-motion", () => {
  const css = sources.find((x) => x.f === "styles.css")?.text ?? "";
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
});
