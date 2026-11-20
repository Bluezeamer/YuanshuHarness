// @vitest-environment node
// brand-spec（视觉规范）的静态可检部分：令牌值、对比度、字体、字号刻度、阴影、动效、圆角刻度、骨架尺寸、响应式断点。
// 编号 VR01–VR24 对应下表；需要真实布局/渲染的条目（VR19–VR24）在 scripts/verify-visual.mjs 里用真浏览器检查。
//
//  VR01 令牌值与规范表一致          VR13 非循环动效 ≤ 400ms，曲线只用 --ease
//  VR02 不新增色阶、派生色走 color-mix VR14 位移 ≤ 6px，不用弹跳
//  VR03 文字对比度达到规范数值       VR15 尊重 prefers-reduced-motion
//  VR04 除令牌外无裸色值            VR16 页面不横向滚动（无 100vw、根容器裁切）
//  VR05 无衬线字体栈                VR17 圆角只用刻度（微标 ≤3px、圆形 50%）
//  VR06 等宽字体栈                  VR18（已取消：旧左轨的蓝色激活态；新规格选中靠灰度）
//  VR07 字号 ≤ 8 档且只用刻度        —— 以下在 scripts/verify-visual.mjs（真浏览器）——
//  VR08 数字/命令用 mono + tabular-nums VR19 同屏只有一个蓝色实心按钮
//  VR09 分层靠发丝线：阴影只用白名单形态 VR20 1280/1024/780/560 四档视口无横向滚动
//  VR10 --elev-lg 只给浮层/悬浮件     VR21 rail 宽 252，≤1120 收为 62，≤900 转顶部 strip
//  VR11 绿色不做按钮底               VR22 左轨与工作区平铺（外缝内缝 0）
//  VR12 蓝色实心底只有白名单选择器     VR23 控件高度 24–32px（4px 基线）
//                                  VR24 无全局顶栏、无底部状态条
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { type Block, cssFiles, parseCss } from "./test/guard/css";

const srcDir = fileURLToPath(new URL("./", import.meta.url));

const files = ["features", "ui", "app"].flatMap((d) =>
  cssFiles(join(srcDir, d)),
);
const blocks = files.flatMap((f) =>
  parseCss(f.slice(srcDir.length), readFileSync(f, "utf8")),
);
const tokenBlocks = blocks.filter((b) => b.file === "ui/tokens.css");
const rootTokens = new Map<string, string>(
  tokenBlocks.filter((b) => b.selector === ":root").flatMap((b) => b.decls),
);
const decls = (prop: RegExp | string) =>
  blocks.flatMap((b) =>
    b.decls
      .filter(([p]) => (typeof prop === "string" ? p === prop : prop.test(p)))
      .map(([p, v]) => ({ b, p, v })),
  );
const where = (x: { b: Block; p: string; v: string }) =>
  `${x.b.file} ${x.b.selector} { ${x.p}: ${x.v} }`;

// ---------- OKLCH → WCAG 对比度 ----------
function parseOklch(v: string): [number, number, number] {
  const m = /oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(v);
  if (!m) throw new Error(`不是 oklch 字面量：${v}`);
  const L =
    v.includes("%") && Number(m[1]) > 1 ? Number(m[1]) / 100 : Number(m[1]);
  return [L, Number(m[2]), Number(m[3])];
}
function linear([L, C, h]: [number, number, number]): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
const lum = ([r, g, b]: [number, number, number]) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const tok = (name: string) => linear(parseOklch(rootTokens.get(name) ?? ""));

// ---------- 规则 ----------

const SPEC_TOKENS: Record<string, string> = {
  "--bg": "oklch(0.975 0.003 265)",
  "--surface": "oklch(1 0 0)",
  "--surface-2": "oklch(0.982 0.002 265)",
  "--surface-3": "oklch(0.962 0.004 265)",
  "--fg": "oklch(0.21 0.006 286)",
  "--muted": "oklch(0.5 0.012 265)",
  "--meta": "oklch(0.52 0.012 265)",
  "--border": "oklch(0.92 0.005 265)",
  "--border-strong": "oklch(0.86 0.007 265)",
  "--accent": "oklch(0.546 0.215 263)",
  "--accent-ink": "oklch(0.46 0.17 262)",
  "--live": "oklch(0.62 0.15 152)",
  "--live-ink": "oklch(0.52 0.14 152)",
  "--warn": "oklch(0.666 0.157 58)",
  "--warn-ink": "oklch(0.5 0.13 70)",
  "--danger": "oklch(0.577 0.215 27)",
};

test("VR01 令牌值与 brand-spec 的令牌表逐一一致", () => {
  const wrong = Object.entries(SPEC_TOKENS).filter(
    ([k, v]) => rootTokens.get(k) !== v,
  );
  expect(wrong).toEqual([]);
});

test("VR02 不新增色阶令牌；派生色一律 color-mix(in oklch, …)", () => {
  const scale = [...rootTokens.keys()].filter((k) => /-\d{2,3}$/.test(k));
  expect(scale).toEqual([]);
  const derived = ["--accent-line"];
  for (const k of derived)
    expect(rootTokens.get(k), k).toMatch(/^color-mix\(in oklch,/);
});

test("VR03 文字对比度达到规范数值（fg 16.5、muted 6.0、meta 5.1、accent 5.1、live-ink 4.6）", () => {
  const surface = tok("--surface");
  const rows: Array<[string, number, number]> = [
    ["fg/surface", contrast(tok("--fg"), surface), 16.4],
    ["muted/surface", contrast(tok("--muted"), surface), 5.9],
    ["meta/bg", contrast(tok("--meta"), tok("--bg")), 5.0],
    ["accent/surface", contrast(tok("--accent"), surface), 5.0],
    [
      "accent-text/accent-bg",
      contrast(tok("--accent-text"), tok("--accent-bg")),
      4.5,
    ],
    ["ok-text/surface", contrast(tok("--ok-text"), surface), 4.5],
    ["warn-text/surface", contrast(tok("--warn-text"), surface), 4.5],
  ];
  const low = rows
    .filter(([, got, min]) => got < min)
    .map(([n, got, min]) => `${n} ${got.toFixed(2)} < ${min}`);
  expect(low).toEqual([]);
});

test("VR04 除令牌外不出现裸色值（hex / rgb / hsl / oklch 字面量）", () => {
  const bare = decls(/./)
    .filter(
      (x) =>
        x.b.file !== "ui/tokens.css" && !x.b.file.endsWith("xterm-base.css"),
    )
    .filter((x) =>
      /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(x.v),
    )
    // color-mix 里的 oklch 是插值空间名，不是色值
    .filter((x) =>
      /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab)\(|(?<!in )oklch\(\s*[\d.]/i.test(
        x.v,
      ),
    );
  expect(bare.map(where)).toEqual([]);
});

test("VR05 无衬线字体栈与规范一致", () => {
  expect(rootTokens.get("--font-sans")?.replace(/\s+/g, " ")).toBe(
    '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  );
});

test("VR06 等宽字体栈与规范一致，且 font-family 只经由令牌引用", () => {
  expect(rootTokens.get("--font-mono")?.replace(/\s+/g, " ")).toBe(
    'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace',
  );
  const raw = decls("font-family").filter(
    (x) =>
      x.b.file !== "ui/tokens.css" &&
      !x.b.file.endsWith("xterm-base.css") &&
      !/var\(--font-(sans|mono)\)|inherit/.test(x.v),
  );
  expect(raw.map(where)).toEqual([]);
});

test("VR07 字号 ≤ 8 档，且 font-size 只用刻度令牌", () => {
  const scale = [...rootTokens.keys()].filter((k) => k.startsWith("--fs-"));
  expect(scale.length).toBeLessThanOrEqual(8);
  const raw = decls("font-size").filter(
    (x) =>
      x.b.file !== "ui/tokens.css" &&
      !x.b.file.endsWith("xterm-base.css") &&
      !/var\(--fs-[a-z0-9]+\)|calc\(var\(--fs-|inherit|em$|%$/.test(x.v),
  );
  expect(raw.map(where)).toEqual([]);
});

test("VR08 mono 元素带 tabular-nums（路径、命令、时间、id、数字）", () => {
  const mono = tokenBlocks.filter(
    (b) =>
      b.at.some((a) => a.startsWith("@layer")) &&
      /\.mono|code/.test(b.selector),
  );
  expect(mono.length).toBeGreaterThan(0);
  expect(
    mono.some((b) =>
      b.decls.some(
        ([p, v]) => p === "font-variant-numeric" && v.includes("tabular-nums"),
      ),
    ),
  ).toBe(true);
});

const SHADOW_OK = [
  /^none$/,
  /^var\(--elev-lg\)$/,
  /^var\(--sh-(?:sm|md|pop)\)$/, // 新视觉语言的阴影三档
  /^var\(--ring\)$/,
  /^inset\s/, // 发丝线 / 激活条
  /^0 0 0 [\d.]+px\s/, // 只有扩散没有偏移与模糊 = 描边环
  /^var\(--elev-lg\),\s*inset\s/,
];
// 旋钮与卡片抬升的微影不是层级阴影，逐条列出理由
const SHADOW_EXEMPT: Array<[file: string, why: string]> = [
  ["ui/styles/toggles.css", "开关旋钮的 1px 微影与浮起轨道"],
];

test("VR09 分层靠发丝线：box-shadow 只允许 none / elev-lg / ring / inset 发丝线 / 描边环", () => {
  const bad = decls("box-shadow")
    .filter((x) => !SHADOW_EXEMPT.some(([f]) => x.b.file === f))
    .filter((x) => {
      const v = x.v.replace(/\s+/g, " ").trim();
      return !SHADOW_OK.some((re) => re.test(v));
    });
  expect(bad.map(where)).toEqual([]);
});

// --elev-lg 只给浮层与悬浮件：以类名片段白名单约束，新增用法必须先在这里登记
const FLOATING =
  /(pop|float|fab|toast|mcard|panel|ghost|xfer|selbar|tobottom|hint|pagebox|wfcard)/;
test("VR10 --elev-lg 只用于浮层与悬浮件", () => {
  const bad = decls(/^box-shadow$/)
    .filter((x) => x.v.includes("--elev-lg") && x.b.file !== "ui/tokens.css")
    .filter((x) => !FLOATING.test(x.b.selector));
  expect(bad.map(where)).toEqual([]);
});

test("VR11 绿色（live）不做按钮底色", () => {
  const bad = decls(/^background(-color)?$/).filter(
    (x) =>
      /var\(--live\)\s*$/.test(x.v) &&
      /btn|button|send|primary/.test(x.b.selector),
  );
  expect(bad.map(where)).toEqual([]);
});

// 钴蓝实心底：只给「你」与「焦点」——选中/激活指示、进度、开关、主按钮、发送键；
// 白名单以文件为粒度，新增文件用蓝底需要先在这里登记（同屏只出现一个蓝色实心按钮由 VR19 在真浏览器里查）
const ACCENT_SOLID_FILES = new Set([
  "ui/styles/controls.css",
  "ui/styles/chips.css",
  "ui/styles/nav.css",
  "ui/styles/toggles.css",
  "ui/styles/tiling.css",
  "features/workspace/workspace.pane.css",
  "features/workspace/rail/rail.css",
  "features/workspace/rail/rail.l1.css",
  "features/chat/tab/chat.dock.css",
  "features/chat/tab/chat.composer.css",
  "features/chat/tab/chat.tools.css",
  "features/chat/audit/audit.css",
  "app/shell/shell.css",
]);
test("VR12 蓝色实心底只出现在登记过的文件里", () => {
  const bad = decls(/^background(-color)?$/).filter(
    (x) => /^var\(--accent\)$/.test(x.v) && !ACCENT_SOLID_FILES.has(x.b.file),
  );
  expect(bad.map(where)).toEqual([]);
});

const LOOP_OK = /(breathe|blink|spin|dot|slide|pulse|shimmer|run|step)/;
test("VR13 非循环动效 ≤ 400ms；曲线只用 --ease", () => {
  const dur = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g;
  const long: string[] = [];
  for (const x of decls(/^(transition|animation)(-duration)?$/)) {
    if (x.b.file.endsWith("xterm-base.css")) continue;
    const infinite = /infinite/.test(x.v) || x.p === "animation-duration";
    if (infinite && x.v.includes("infinite") && !LOOP_OK.test(x.v))
      long.push(where(x));
    if (infinite) continue;
    for (const m of x.v.matchAll(dur)) {
      const ms = Number(m[1]) * (m[2] === "s" ? 1000 : 1);
      if (ms > 400) long.push(where(x));
    }
  }
  expect(long).toEqual([]);
  const curves = decls(/./)
    .filter((x) => x.b.file !== "ui/tokens.css")
    .filter((x) => /cubic-bezier\(/.test(x.v));
  expect(curves.map(where)).toEqual([]);
});

test("VR14 位移 ≤ 6px，只动透明度与位移（keyframes 里没有大幅 translate / 回弹 scale）", () => {
  const bad: string[] = [];
  for (const b of blocks.filter((x) =>
    x.at.some((a) => a.startsWith("@keyframes")),
  )) {
    for (const [p, v] of b.decls) {
      if (p !== "transform" && p !== "translate") continue;
      for (const m of v.matchAll(/translate[XY]?\(\s*(-?[\d.]+)px/g)) {
        if (Math.abs(Number(m[1])) > 6)
          bad.push(`${b.file} ${b.at.at(-1)} ${v}`);
      }
      for (const m of v.matchAll(/scale\(\s*([\d.]+)/g)) {
        if (Number(m[1]) > 1.05) bad.push(`${b.file} ${b.at.at(-1)} ${v}`);
      }
    }
  }
  expect(bad).toEqual([]);
});

test("VR15 样式表尊重 prefers-reduced-motion（并把动画与过渡压到近 0）", () => {
  const reduce = blocks.filter((b) =>
    b.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)),
  );
  expect(reduce.length).toBeGreaterThan(0);
  const flattened = reduce
    .flatMap((b) => b.decls.map(([p, v]) => `${p}:${v}`))
    .join(" ");
  expect(flattened).toMatch(/animation(-duration)?:\s*(none|0|0\.01ms)/);
  expect(flattened).toMatch(/transition(-duration)?:\s*(none|0|0\.01ms)/);
});

test("VR16 页面不横向滚动：没有 100vw 宽度，应用根容器裁切溢出", () => {
  const vw = decls(/^(width|min-width)$/).filter((x) => /100vw/.test(x.v));
  expect(vw.map(where)).toEqual([]);
  const root = blocks.find(
    (b) => b.file === "app/shell/shell.css" && b.selector === ".sh-app",
  );
  expect(root?.decls.find(([p]) => p === "overflow")?.[1]).toBe("hidden");
});

test("VR17 圆角只用刻度（令牌或新刻度 6/8/12/14px；微标 ≤3px、圆形 50%、0 除外）", () => {
  const bad = decls(/^border(-[a-z]+)*-radius$/).filter((x) => {
    if (x.b.file.endsWith("xterm-base.css")) return false;
    const parts = x.v.split(/\s+/);
    return parts.some(
      (p) =>
        !/^var\(--r-[a-z]+\)$/.test(p) &&
        !/^(0|50%|inherit|initial|999px)$/.test(p) &&
        !/^(6|8|12|14)px$/.test(p) && // 新刻度的圆角；是否在表里由 design.guard 核对
        !/^calc\(var\(--r-[a-z]+\)$/.test(p) &&
        !/^[+-]$/.test(p) &&
        !/^\d+px\)$/.test(p) &&
        !(/^[\d.]+px$/.test(p) && Number.parseFloat(p) <= 3),
    );
  });
  expect(bad.map(where)).toEqual([]);
  const scale = ["--r-ctl", "--r-card", "--r-panel", "--r-bar", "--r-pill"].map(
    (k) => rootTokens.get(k),
  );
  expect(scale).toEqual(["7px", "10px", "12px", "14px", "999px"]);
});
