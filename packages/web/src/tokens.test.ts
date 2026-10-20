// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, test } from "vitest";

const srcDir = fileURLToPath(new URL("./", import.meta.url));

// 递归读取 src/ 下所有源文件，排除测试文件与目录本身。
function walkSources(dir: string, prefix = ""): { f: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const fullPath = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(fullPath).isDirectory()) return walkSources(fullPath, rel);
    if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) return [];
    return [{ f: rel, text: readFileSync(fullPath, "utf8") }];
  });
}

const sources = walkSources(srcDir);
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
      isEntry?: boolean;
      code?: string;
      source?: string | Uint8Array;
    }[];
  };
  const files = out.output.map((o) => ({
    name: o.fileName,
    lazy: o.type === "chunk" && !(o as { isEntry?: boolean }).isEntry,
    text: String(o.type === "chunk" ? o.code : o.source),
  }));
  expect(files.some((f) => f.name.endsWith(".css"))).toBe(true);
  for (const { name, text, lazy } of files) {
    if (name.endsWith(".js")) {
      // 按需加载的第三方块（mermaid）自带主题色，不在我们的调色板约束内；只查入口包。
      if (lazy) continue;
      // react-markdown 的弃用提示里有 "#add-urltransform" 这类锚点文字，不是色值。
      const js = text.replace(/#[\w]+-[\w-]+/g, "");
      expect(js.match(new RegExp(HEX, "g")) ?? [], name).toEqual([]);
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

// 只解析 :root 里纯 oklch() 字面量；color-mix 派生色（-soft）只做底色，不参与文字对比。
function oklchToLinear(L: number, C: number, hDeg: number) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
function tokenLuminance(name: string): number {
  const css = sources.find((x) => x.f === "styles.css")?.text ?? "";
  const m = css.match(
    new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`),
  );
  if (!m) throw new Error(`:root 里没有纯 oklch 字面量 --${name}`);
  const [r = 0, g = 0, b = 0] = oklchToLinear(
    Number(m[1]) / 100,
    Number(m[2]),
    Number(m[3]),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (fg: string, bg: string) => {
  const [x, y] = [tokenLuminance(fg), tokenLuminance(bg)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test("R3 文字色在 bg / panel 上对比度 ≥ 4.5:1", () => {
  // ok / warn / accent 本色只做点、线、环，文字走 -ink / -deep。
  for (const fg of [
    "ink",
    "mute",
    "accent-deep",
    "ok-ink",
    "warn-ink",
    "danger",
  ])
    for (const bg of ["bg", "panel"])
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  // 实心按钮：浅字压在 deep / danger 底上。
  expect(contrast("panel", "accent-deep")).toBeGreaterThanOrEqual(4.5);
  expect(contrast("bg", "danger")).toBeGreaterThanOrEqual(4.5);
});

test("R9 样式表尊重 prefers-reduced-motion", () => {
  const css = sources.find((x) => x.f === "styles.css")?.text ?? "";
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
});
