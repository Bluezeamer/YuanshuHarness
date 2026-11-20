// 设计规则的扫描器：数出 src/ 里每条规则、每个文件的违规处数。
// 规则来源：ys-ui-design 与 ys-ui-build 的 references。design.guard.test.ts 拿它和基线比。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Block, parseCss } from "./css";

export type Rule = "type" | "scale" | "color" | "control" | "tag";

export interface Hit {
  rule: Rule;
  file: string;
  what: string;
}

// 排版：这几个文件之外不得再写字号 / 字重 / 字体族 / 行高
const TYPE_FILES = new Set(["ui/type.css", "ui/tokens.css"]);
const TYPE_PROPS = /^(font|font-size|font-weight|font-family|line-height)$/;
// 第三方画面：xterm 的样式表是上游拷贝，只要求颜色取令牌
const THIRD_PARTY = /xterm-base\.css$/;
// PDF 文本层是盖在画布上的透明几何层，line-height: 1 是文字与画面对位所需，不是版面排版
const TYPE_EXEMPT = /^\.ws-pv-text$/;
// xterm 画在 canvas 上，字体与字号只能当构造选项传；值来自 --font-mono 与字号设置（--fs-code）
const TYPE_EXEMPT_FILES = /(?:^|\/)terminal\/TerminalTab\.tsx$/;

// 刻度（ys-ui-design 的 visual-language §3）
const SPACING = new Set([0, 4, 6, 8, 12, 16, 24, 32, 48]);
const HEIGHT = new Set([20, 28, 32, 36, 40, 44]);
const RADIUS = new Set([0, 6, 8, 12, 14, 999]);
const Z = new Set([0, 10, 20, 30, 40]);
const SCALES: Array<[RegExp, Set<number>]> = [
  [/^(gap|row-gap|column-gap|padding(-[a-z]+)*|margin(-[a-z]+)*)$/, SPACING],
  [/^(height|min-height)$/, HEIGHT],
  [/^border(-[a-z]+)*-radius$/, RADIUS],
];
// 组件自身的固有尺寸（图标、状态点、细进度条、开关拨块……）不归刻度管：
// 选择器最后一段是这些，或在下面登记的选择器里，放行。登记要写理由。
const INTRINSIC_LAST =
  /(?:^|[\s>+~])(?:svg|img|canvas|video)(?:[:.[]|$)|::?(?:before|after)$/;
const INTRINSIC_SELECTORS: RegExp[] = [
  // 远程连接的拓扑连线与节点点；技能分发的细进度条；文件 / 预览工具条与窗格头里的主机色点
  /^\.st-rc-node-(?:line|dot)$/,
  /^\.st-tl-dbar$/,
  /^\.ws-(?:fm|pv)-host i$/,
  /^\.ws-hdot$/,
  // 对话流「正在输入」的三个跳动圆点
  /^\.ch-typing i$/,
  // 共享件里的固有尺寸：状态点 8 / 6、滑块的轨道与拇指、细进度条与读条、菜单分隔线、页签墨线、复选框、分隔条的拖动热区
  /^\.u-dot(?:\[data-size="sm"\])?$/,
  /^\.u-range(?:::-(?:webkit-slider-(?:runnable-track|thumb)|moz-range-(?:track|thumb)))?$/,
  /^\.u-(?:progress|readbar)$/,
  /^\.u-(?:menu-sep|tab-ink|check-box)$/,
  /^\.u-split\[data-orientation="horizontal"\]$/,
];

// 颜色：淡色底令牌与对语义色铺底的 color-mix
const SOFT_TOKEN = /var\(--(?:accent|danger|warn|live|ok)-soft\b/;
const SEMANTIC_MIX =
  /color-mix\([^)]*var\(--(?:danger|warn|live|ok)(?:-ink|-text)?\)/;
const BACKGROUNDS = /^(background|background-color)$/;

// 控件与标签默认样式（只扫 ui/ 之外的 TSX）
const NATIVE_CONTROL =
  /<select[\s>]|<button[\s>]|type=["'](?:range|checkbox)["']/g;
const SHADOW_COMPONENT = /(?:function|const|class)\s+(?:ConfirmModal)\b/g;
// 标题标签带了字样角色类（或 sr-only）就不是靠默认外观：语义标题保留，长相由角色类给
const DEFAULT_TAG =
  /<(?:b|strong|h[1-6])(?=[\s>])(?![^>]*\b(?:t-(?:page|block|group|entry|plain|aux|mono|read|code)|sr-only)\b)/g;
const INLINE_TYPE = /\b(?:fontSize|fontWeight|fontFamily|lineHeight)\s*:/g;
const TW_TYPE =
  /\b(?:text-(?:2xs|xs|sm|md|base|lg|xl)|font-(?:sans|mono|medium|semibold|bold|normal|light)|leading-[\w[\].]+)\b/g;

const walk = (dir: string, prefix = ""): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) return walk(full, rel);
    return [rel];
  });

const isFixture = (rel: string) =>
  rel.startsWith("test/") || /(^|\/)(testkit|harness)(\.\w+)*\.tsx?$/.test(rel);
const isTest = (rel: string) => /\.test\.tsx?$/.test(rel);

const pxValues = (v: string): number[] =>
  [...v.matchAll(/(?<![\w.#-])(-?\d*\.?\d+)px/g)].map((m) =>
    Math.abs(Number(m[1])),
  );

function scanCss(file: string, blocks: Block[], out: Hit[]): void {
  const push = (rule: Rule, what: string) => out.push({ rule, file, what });
  for (const b of blocks) {
    const intrinsic =
      INTRINSIC_LAST.test(b.selector) ||
      INTRINSIC_SELECTORS.some((re) => re.test(b.selector));
    for (const [prop, value] of b.decls) {
      if (
        !TYPE_FILES.has(file) &&
        !THIRD_PARTY.test(file) &&
        !TYPE_EXEMPT.test(b.selector) &&
        TYPE_PROPS.test(prop)
      )
        push("type", `${b.selector} { ${prop}: ${value} }`);
      if (
        SOFT_TOKEN.test(value) ||
        (BACKGROUNDS.test(prop) && SEMANTIC_MIX.test(value))
      )
        push("color", `${b.selector} { ${prop}: ${value} }`);
      if (file === "ui/tokens.css" || THIRD_PARTY.test(file) || intrinsic)
        continue;
      if (/\b(?:calc|clamp|min|max)\(/.test(value)) continue;
      if (prop === "z-index") {
        if (!Z.has(Number(value)))
          push("scale", `${b.selector} { z-index: ${value} }`);
        continue;
      }
      const set = SCALES.find(([re]) => re.test(prop))?.[1];
      if (set && pxValues(value).some((n) => !set.has(n)))
        push("scale", `${b.selector} { ${prop}: ${value} }`);
    }
  }
}

function scanTsx(file: string, text: string, out: Hit[]): void {
  const count = (rule: Rule, re: RegExp) => {
    for (const m of text.matchAll(re)) out.push({ rule, file, what: m[0] });
  };
  if (!TYPE_EXEMPT_FILES.test(file)) count("type", INLINE_TYPE);
  count("type", TW_TYPE);
  count("tag", DEFAULT_TAG);
  if (!file.startsWith("ui/")) {
    count("control", NATIVE_CONTROL);
    count("control", SHADOW_COMPONENT);
  }
}

export function scan(srcDir: string): Hit[] {
  const out: Hit[] = [];
  for (const rel of walk(srcDir)) {
    if (isTest(rel) || isFixture(rel)) continue;
    const full = join(srcDir, rel);
    if (rel.endsWith(".css"))
      scanCss(rel, parseCss(rel, readFileSync(full, "utf8")), out);
    else if (rel.endsWith(".tsx"))
      scanTsx(rel, readFileSync(full, "utf8"), out);
  }
  return out;
}

export type Counts = Record<Rule, Record<string, number>>;

export function countsOf(hits: Hit[]): Counts {
  const c: Counts = { type: {}, scale: {}, color: {}, control: {}, tag: {} };
  for (const h of hits) c[h.rule][h.file] = (c[h.rule][h.file] ?? 0) + 1;
  return c;
}
