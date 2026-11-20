// mermaid 主题：从 ui/tokens.css 的 oklch 令牌生成 themeVariables（khroma 只认 hex）。
// 只在浏览器里可用；拿不到令牌时抛错，调用方回落到 mermaid 的 base 默认主题。
import { mixOklch, type Oklch, oklchToHex, parseOklch } from "./oklch";

const tokenCache = new Map<string, string>();

function token(name: string): string {
  const hit = tokenCache.get(name);
  if (hit) return hit;
  const raw =
    typeof getComputedStyle === "function"
      ? getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      : "";
  if (raw === "") throw new Error(`missing token ${name}`);
  tokenCache.set(name, raw);
  return raw;
}

const color = (name: string): Oklch => {
  const parsed = parseOklch(token(name));
  if (!parsed) throw new Error(`bad token ${name}`);
  return parsed;
};

/** 与 tokens.css 对应的十六进制调色板；soft 底色按令牌的 color-mix 比例现算。 */
function palette() {
  const surface = color("--surface");
  return {
    paper: oklchToHex(color("--bg")),
    surface: oklchToHex(surface),
    surface2: oklchToHex(color("--surface-2")),
    surface3: oklchToHex(color("--surface-3")),
    ink: oklchToHex(color("--fg")),
    muted: oklchToHex(color("--muted")),
    meta: oklchToHex(color("--meta")),
    border: oklchToHex(color("--border")),
    borderStrong: oklchToHex(color("--border-strong")),
    accent: oklchToHex(color("--accent")),
    accentInk: oklchToHex(color("--accent-ink")),
    danger: oklchToHex(color("--danger")),
    accentSoft: oklchToHex(mixOklch(color("--accent"), surface, 0.09)),
    dangerSoft: oklchToHex(mixOklch(color("--danger"), surface, 0.08)),
  };
}

/** 字体取自令牌，保证图和正文同一套排版；字号与 type.css 的普通字（t-plain）一致。 */
function typography() {
  const family = token("--font-sans");
  const size = "13px";
  return { family, size };
}

export interface MermaidTheme {
  /** 直接交给 mermaid.initialize 的配置 */
  config: Record<string, unknown>;
  /** 主题指纹，参与 SVG 缓存键 */
  version: string;
}

// 12 槽低饱和色板：mindmap / timeline / pie 需要，否则会按主色做色相旋转，全是灰。
function scaleOf(p: ReturnType<typeof palette>): string[] {
  return [
    p.surface,
    p.surface3,
    p.accentSoft,
    p.surface2,
    p.surface3,
    p.surface2,
    p.accentSoft,
    p.surface,
    p.surface3,
    p.surface2,
    p.accentSoft,
    p.surface,
  ];
}

export function buildMermaidTheme(): MermaidTheme {
  const p = palette();
  const font = typography();
  const scale = scaleOf(p);
  const scaleVars = Object.fromEntries(
    scale.flatMap((fill, i) => [
      [`cScale${i}`, fill],
      [`cScaleLabel${i}`, p.ink],
      [`cScaleInv${i}`, p.muted],
    ]),
  );

  const variables = {
    darkMode: false,
    background: p.paper,
    fontFamily: font.family,
    fontSize: font.size,

    primaryColor: p.surface,
    primaryTextColor: p.ink,
    primaryBorderColor: p.borderStrong,
    secondaryColor: p.accentSoft,
    secondaryTextColor: p.ink,
    secondaryBorderColor: p.accent,
    tertiaryColor: p.surface3,
    tertiaryTextColor: p.ink,
    tertiaryBorderColor: p.border,

    mainBkg: p.surface,
    lineColor: p.muted,
    textColor: p.ink,
    nodeBkg: p.surface,
    nodeBorder: p.borderStrong,
    nodeTextColor: p.ink,
    clusterBkg: p.surface2,
    clusterBorder: p.border,
    titleColor: p.ink,
    edgeLabelBackground: p.surface,
    defaultLinkColor: p.muted,
    arrowheadColor: p.muted,
    border2: p.border,

    strokeWidth: 1,
    radius: 8,
    useGradient: false,
    dropShadow: "none",

    noteBkgColor: p.surface3,
    noteTextColor: p.ink,
    noteBorderColor: p.borderStrong,
    errorBkgColor: p.dangerSoft,
    errorTextColor: p.danger,

    // sequence
    actorBkg: p.surface,
    actorBorder: p.borderStrong,
    actorTextColor: p.ink,
    actorLineColor: p.border,
    signalColor: p.muted,
    signalTextColor: p.ink,
    labelBoxBkgColor: p.surface3,
    labelBoxBorderColor: p.border,
    labelTextColor: p.ink,
    loopTextColor: p.ink,
    activationBkgColor: p.accentSoft,
    activationBorderColor: p.accent,
    sequenceNumberColor: p.accentInk,

    // state（stateLabelColor 必须显式设：省略时会回落到 stateBkg，文字会消失）
    stateBkg: p.surface,
    stateBorder: p.borderStrong,
    stateLabelColor: p.ink,
    labelBackgroundColor: p.surface,
    compositeBackground: p.surface2,
    compositeTitleBackground: p.surface3,
    compositeBorder: p.border,
    altBackground: p.surface3,
    innerEndBackground: p.border,
    specialStateColor: p.accent,
    transitionColor: p.muted,
    transitionLabelColor: p.ink,

    // class / ER
    classText: p.ink,
    rowOdd: p.surface,
    rowEven: p.surface2,
    attributeBackgroundColorOdd: p.surface,
    attributeBackgroundColorEven: p.surface2,
    erEdgeLabelBackground: p.surface,

    // gantt
    sectionBkgColor: p.surface3,
    sectionBkgColor2: p.surface2,
    altSectionBkgColor: p.surface,
    taskBkgColor: p.accentSoft,
    taskBorderColor: p.accent,
    taskTextColor: p.ink,
    taskTextOutsideColor: p.ink,
    doneTaskBkgColor: p.border,
    doneTaskBorderColor: p.muted,
    critBkgColor: p.dangerSoft,
    critBorderColor: p.danger,
    todayLineColor: p.danger,
    gridColor: p.border,
    excludeBkgColor: p.surface2,
    vertLineColor: p.borderStrong,

    // pie
    pie1: p.accent,
    pie2: p.muted,
    pie3: p.accentInk,
    pie4: p.meta,
    pie5: p.borderStrong,
    pieStrokeColor: p.surface,
    pieStrokeWidth: "1px",
    pieOuterStrokeColor: p.border,
    pieOuterStrokeWidth: "1px",
    pieTitleTextColor: p.ink,
    pieSectionTextColor: p.surface,
    pieLegendTextColor: p.ink,

    // mindmap / timeline
    git0: p.accent,
    gitBranchLabel0: p.surface,
    ...scaleVars,
  };

  const config = {
    theme: "base",
    // 纸面风格：圆角 + 发丝线，关掉 v12 的渐变与投影
    look: "neo",
    layout: "elk",
    htmlLabels: true,
    fontFamily: font.family,
    themeVariables: variables,
  };

  return { config, version: JSON.stringify(config) };
}
