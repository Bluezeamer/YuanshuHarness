// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const srcDir = fileURLToPath(new URL("../", import.meta.url));

// 递归读取目录下的源码与样式，跳过测试文件与令牌定义处。
function walk(dir: string, prefix: string): { f: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = `${prefix}/${name}`;
    if (statSync(full).isDirectory()) return walk(full, rel);
    if (/\.test\.tsx?$/.test(name) || name === "tokens.css") return [];
    if (!/\.(tsx?|css)$/.test(name)) return [];
    return [{ f: rel, text: readFileSync(full, "utf8") }];
  });
}

const sources = [
  ...walk(join(srcDir, "ui"), "ui"),
  ...walk(join(srcDir, "features"), "features"),
  ...walk(join(srcDir, "app"), "app"),
];
const tokens = readFileSync(join(srcDir, "ui/tokens.css"), "utf8");

test("扫描范围非空，避免守卫形同虚设", () => {
  expect(sources.length).toBeGreaterThan(10);
});

test("ui 与 features 下没有裸 hex / rgb / hsl", () => {
  const raw = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
  for (const { f, text } of sources) expect(text, f).not.toMatch(raw);
});

test("没有 Tailwind 内置黑白与默认色板", () => {
  const prefix =
    "(?:text|bg|border|fill|stroke|ring|from|to|via|divide|outline|shadow|decoration|accent|caret)";
  const blackWhite = new RegExp(`\\b${prefix}-(?:white|black)\\b`);
  const palette = new RegExp(
    `\\b${prefix}-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}\\b`,
  );
  for (const { f, text } of sources) {
    expect(text, f).not.toMatch(blackWhite);
    expect(text, f).not.toMatch(palette);
  }
});

test("没有 min-width ≥ 640px 的样式（表格必须贴合容器，百分比列宽）", () => {
  const minWidth =
    /min-width:\s*(\d+(?:\.\d+)?)px|\bmin-w-\[(\d+(?:\.\d+)?)px\]/g;
  for (const { f, text } of sources) {
    // 媒体查询里的 min-width 是断点，不是元素宽度
    const body = text
      .split("\n")
      .filter((line) => !line.includes("@media"))
      .join("\n");
    for (const m of body.matchAll(minWidth)) {
      const px = Number(m[1] ?? m[2]);
      expect(px, `${f}: ${m[0]}`).toBeLessThan(640);
    }
  }
});

test("tokens.css 包含 brand-spec 的全部令牌与映射", () => {
  const required = [
    "--bg",
    "--surface",
    "--surface-2",
    "--surface-3",
    "--fg",
    "--muted",
    "--meta",
    "--border",
    "--border-strong",
    "--accent",
    "--accent-ink",
    "--live",
    "--live-ink",
    "--warn",
    "--warn-ink",
    "--danger",
    "--elev-lg",
    "--r-ctl",
    "--r-card",
    "--r-panel",
    "--r-bar",
    "--r-pill",
    "--ease",
    "--dur",
    "--font-sans",
    "--font-mono",
  ];
  for (const name of required) {
    expect(tokens, name).toMatch(new RegExp(`${name}\\s*:`));
  }
  expect(tokens).toContain("cubic-bezier(0.23, 1, 0.32, 1)");
  expect(tokens).toContain("@theme inline");
  expect(tokens).toContain("prefers-reduced-motion");
});

test(":root 里没有字号阶梯，且派生色一律走 color-mix(in oklch)", () => {
  // 字号只剩 type.css 的字样角色与两条阅读字号变量（声明在下面的 html 块里，由下一条用例守）。
  const rest = tokens.slice(tokens.indexOf(":root {"));
  const root = rest.slice(0, rest.indexOf("\n}"));
  expect(root.match(/--fs-[a-z0-9]+\s*:/g) ?? []).toEqual([]);
  const mixes = tokens.match(/color-mix\([^)]*\)/g) ?? [];
  expect(mixes.length).toBeGreaterThan(0);
  for (const m of mixes) expect(m, m).toMatch(/^color-mix\(in oklch,/);
});

// 规则变更：界面字号从三档枚举改成自由调节后，覆盖源从 html[data-font-size] 换成根元素上的
// 内联变量（src/app/fontSize.ts 写 --fs-read/--fs-code），档位选择器已不存在，
// 因此不再逐档点名，改为守「兜底两条齐全」与「没有残留档位选择器」——后者正是两套读逻辑并存的入口。
test("阅读字号：只在 html 上给两条兜底默认值，且不再有档位选择器", () => {
  const tiers = ["--fs-read", "--fs-code"];
  // 兜底值必须落在 html 而不是 :root：:root 里出现 --fs-read 会被当成又一组字号阶梯
  expect(tokens).not.toMatch(/:root\s*\{[^}]*--fs-read:/s);
  const html = /html\s*\{([^}]*)\}/.exec(tokens)?.[1] ?? "";
  for (const t of tiers) expect(html, t).toMatch(t);
  expect(html).not.toContain("--fs-meta");
  expect(tokens).not.toContain("data-font-size");
});

test("自己画字的两个面（终端、编辑器）显式引用代码档", () => {
  // 这两处不经由 CSS 继承：xterm 画在 canvas 上、CodeMirror 的主题是 JS 里的样式表，
  // 只能显式写变量名。落回固定字号（旧的 --fs-md / --fs-sm 一类）就又会不跟随界面字号。
  for (const suffix of ["TerminalTab.tsx", "mountEditor.ts"]) {
    const hit = sources.find((s) => s.f.endsWith(suffix));
    expect(hit, suffix).toBeTruthy();
    expect(hit?.text, suffix).toContain("--fs-code");
    expect(hit?.text, suffix).not.toMatch(/--fs-(?:2xs|xs|sm|md|base|lg|xl)\b/);
  }
});
