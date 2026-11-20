// 指针展开与投影（设计稿 §5–§7）：辅助模型只给编号与行号，事实（名字、目标、文字、编号）
// 一律从原始快照展开取，不经过模型；任何省略都写明怎么取回。
import { borrowName } from "./diff-tree.js";
import { CLEAN_LIMITS } from "./limits.js";
import { fixUrl } from "./mech.js";
import {
  fieldValue,
  nodeName,
  parseSnapshot,
  type SnapNode,
  splitLine,
} from "./parse.js";
import type { IntentPointers, OverviewPointers } from "./pointers.js";
import { FIELD_ROLES, INTERACTIVE_ROLES } from "./roles.js";

/** 容器类：只写角色与编号，不写名字（更不能借子孙的：待办页的 listitem 会变成「Toggle Todo」）。 */
const CONTAINER_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "list",
  "listitem",
  "row",
  "rowgroup",
  "cell",
  "columnheader",
  "rowheader",
  "table",
  "caption",
  "article",
  "main",
  "region",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "form",
  "search",
  "toolbar",
  "figure",
  "dialog",
  "group",
  "menu",
  "menubar",
  "tablist",
  "tabpanel",
  "tree",
  "document",
  "application",
  "feed",
]);

/** 展开出来的文字（容器正文、控件值）最多留多少字符。 */
const EXPAND_TEXT_MAX = 120;

export interface RawIndex {
  origin: string;
  byRef: Map<string, SnapNode>;
}

export interface Projection {
  /** 不含外壳（PAGE / SNAPSHOT 行由调用方加） */
  text: string;
  /** 被丢弃的无效指针个数 */
  invalid: number;
}

const bodyOf = (n: SnapNode): string => splitLine(n.text).body;

/** 地址子行：链接的 `/url`、图片的 `/src`（展开时写成 `→ 地址`）。 */
const ADDRESS_ROLES: ReadonlySet<string> = new Set(["/url", "/src"]);

const urlOf = (n: SnapNode): string | null => {
  const u = n.children.find((c) => ADDRESS_ROLES.has(c.role));
  return u ? bodyOf(u) : null;
};

/** 直接子节点里的第一段文字（容器自己的文字可能就是这些 text 子行）。 */
const firstTextOf = (n: SnapNode): string => {
  const t = n.children.find((c) => c.role === "text");
  return t ? bodyOf(t) : "";
};

/** 文字过长按字符截断（不写补了多少字，调用方按行号取回原文）。 */
const cut = (s: string): string =>
  s.length > EXPAND_TEXT_MAX ? `${s.slice(0, EXPAND_TEXT_MAX)}…` : s;

/** 解析一次原始快照，建立「编号 → 节点」索引（原始快照里的每个 [ref=…]）。 */
export function indexRaw(raw: string, origin: string): RawIndex {
  const byRef = new Map<string, SnapNode>();
  const walk = (ns: SnapNode[]): void => {
    for (const n of ns) {
      if (n.ref !== null) byRef.set(n.ref, n);
      walk(n.children);
    }
  };
  walk(parseSnapshot(raw));
  return { origin, byRef };
}

/**
 * 把一个元素编号展开成一行事实（设计稿 §6）：`<编号> <角色> "<名字>" [状态…] [→ 目标 / 地址]`，
 * 表单控件末尾带当前值。名字只有 link / button 在为空时向下借；容器类只写角色，
 * 有自己的文字（行尾正文或直接子节点的第一段 text）才追加 `: 文字`。编号不存在返回 null。
 */
export function expandRef(idx: RawIndex, ref: string): string | null {
  const n = idx.byRef.get(ref);
  if (!n) return null;
  const ctl = n.role === "link" || n.role === "button";
  const container = CONTAINER_ROLES.has(n.role);
  const own = nodeName(n);
  const segs = [ref, n.role];
  if (ctl) {
    const name = own || borrowName(n) || "(unnamed)";
    segs.push(name === "(unnamed)" ? name : JSON.stringify(name));
  } else if (own && !container) {
    segs.push(JSON.stringify(own));
  }
  for (const f of n.flags) if (!f.startsWith("cursor=")) segs.push(`[${f}]`);
  const url = urlOf(n);
  if (url !== null) segs.push(`→ ${fixUrl(url, idx.origin) ?? url}`);
  // 自己的文字：行尾正文，或直接子节点里的第一段 text（不借子孙的名字）。
  const text = cut(bodyOf(n) || firstTextOf(n));
  // 链接 / 按钮的名字已是它自己的文字，不再重复；控件的行尾文字是当前值（引号包住），
  // 其余节点的是正文。冒号紧贴前一段（`e19 listitem: x`）。
  const tail =
    !text || ctl
      ? ""
      : FIELD_ROLES.has(n.role)
        ? `: ${JSON.stringify(fieldValue(text))}`
        : `: ${text}`;
  return `${segs.join(" ")}${tail}`;
}

/** 行号区间：先交换，再夹到 [1, 总行数]。 */
function clampRange(a: number, b: number, total: number): [number, number] {
  return [
    Math.min(Math.max(Math.min(a, b), 1), total),
    Math.min(Math.max(Math.max(a, b), 1), total),
  ];
}

const rangeText = (a: number, b: number): string => `L${a}-${b}`;

/** [1, total] 里没被这些区间覆盖的行段（区间可以重叠、可以不相邻）。 */
function uncovered(
  ranges: [number, number][],
  total: number,
): [number, number][] {
  const out: [number, number][] = [];
  let at = 1;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a > at) out.push([at, a - 1]);
    at = Math.max(at, b + 1);
  }
  if (at <= total) out.push([at, total]);
  return out;
}

/** 行里的编号：`[ref=e12]` 与行内记号 `{e12}`（机械层把并成一行的链接编号写成 `{…}`）。 */
function refsIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\[ref=([^\]\s]+)\]|\{([^}\s]+)\}/g))
    out.push((m[1] ?? m[2]) as string);
  return out;
}

/** [a, b] 里出现的可操作元素个数（按编号去重，角色查原始快照）。 */
function countInteractive(
  idx: RawIndex,
  lines: string[],
  a: number,
  b: number,
): number {
  const refs = new Set<string>();
  const end = Math.min(b, lines.length);
  for (const line of lines.slice(a - 1, end))
    for (const r of refsIn(line)) refs.add(r);
  let n = 0;
  for (const r of refs) {
    const node = idx.byRef.get(r);
    if (node && INTERACTIVE_ROLES.has(node.role)) n++;
  }
  return n;
}

/** 模型自由写的文字：超过上限截到上限以内（含末尾的 `…`）。 */
const modelText = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** 逐字引用的一行：去掉缩进，过长截断并写补了多少字。 */
function quoteRow(n: number, line: string): string {
  const body = line.trimStart();
  const max = CLEAN_LIMITS.quoteLineChars;
  return body.length > max
    ? `  L${n}| ${body.slice(0, max)} …(+${body.length - max} chars)`
    : `  L${n}| ${body}`;
}

/** 一个部分的正文：代表元素、逐字引用、引用截断声明、取回游标。 */
function partBody(
  part: OverviewPointers["parts"][number],
  idx: RawIndex,
  lines: string[],
  total: number,
  shown: Set<string>,
  budget: { quote: number },
): { rows: string[]; invalid: number } {
  const rows: string[] = [];
  let invalid = 0;
  let kept = 0;
  for (const ref of part.refs) {
    // 整个输出里编号只出现一次（后面的重复忽略，不算无效）。
    if (shown.has(ref)) continue;
    const line = expandRef(idx, ref);
    if (line === null) {
      invalid++;
      continue;
    }
    // 超出本部分名额的也忽略，同样不算无效。
    if (kept >= CLEAN_LIMITS.refsPerPartMax) continue;
    shown.add(ref);
    kept++;
    rows.push(`  ${line}`);
  }
  let dropped = 0;
  for (const [qa, qb] of part.quote) {
    const [a, b] = clampRange(qa, qb, total);
    for (let n = a; n <= b; n++) {
      if (budget.quote === 0) {
        dropped++;
        continue;
      }
      budget.quote--;
      rows.push(quoteRow(n, lines[n - 1] ?? ""));
    }
  }
  if (dropped > 0) rows.push(`  … quote truncated (${dropped} more lines)`);
  const [a, b] = clampRange(part.lines[0], part.lines[1], total);
  rows.push(`  … more in ${rangeText(a, b)}`);
  return { rows, invalid };
}

/** overview 的投影：GIST + 各部分 + 覆盖声明 + 无效指针声明。 */
export function projectOverview(
  p: OverviewPointers,
  idx: RawIndex,
  mech: string,
): Projection {
  const lines = (mech.endsWith("\n") ? mech.slice(0, -1) : mech).split("\n");
  const total = lines.length;
  const out: string[] = [];
  const shown = new Set<string>();
  const budget = { quote: CLEAN_LIMITS.quoteMaxLines };
  const covered: [number, number][] = [];
  let invalid = 0;

  if (p.gist)
    out.push(
      `GIST (model-written, navigation only): ${modelText(p.gist, CLEAN_LIMITS.gistMaxChars)}`,
    );

  p.parts.slice(0, CLEAN_LIMITS.partsMax).forEach((part, i) => {
    const [a, b] = clampRange(part.lines[0], part.lines[1], total);
    covered.push([a, b]);
    out.push(
      `[${i + 1}] ${modelText(part.caption, CLEAN_LIMITS.captionMaxChars)} · ${rangeText(a, b)}`,
    );
    const body = partBody(part, idx, lines, total, shown, budget);
    invalid += body.invalid;
    out.push(...body.rows);
  });

  const gaps = uncovered(covered, total);
  if (gaps.length > 0)
    out.push(
      `UNDESCRIBED: ${gaps
        .map(
          ([a, b]) =>
            `${rangeText(a, b)} (${countInteractive(idx, lines, a, b)} interactive elements)`,
        )
        .join(", ")}`,
    );
  if (invalid > 0) out.push(`NOTE: ${invalid} invalid pointers dropped`);
  return { text: out.join("\n"), invalid };
}

/** intent 的投影：每个分组的有效元素各一行，组间空一行；整个输出里编号去重。 */
export function projectIntent(
  p: IntentPointers,
  idx: RawIndex,
  intent: string,
): Projection {
  const shown = new Set<string>();
  const groups: string[] = [];
  let invalid = 0;
  for (const g of p.groups) {
    const rows: string[] = [];
    for (const ref of g.refs) {
      if (shown.has(ref)) continue;
      const line = expandRef(idx, ref);
      if (line === null) {
        invalid++;
        continue;
      }
      shown.add(ref);
      rows.push(`  ${line}`);
    }
    if (rows.length > 0) groups.push(rows.join("\n"));
  }

  const out = [`INTENT: ${modelText(intent, CLEAN_LIMITS.gistMaxChars)}`];
  if (groups.length > 0) out.push(groups.join("\n\n"));
  // 没有有效元素时在正文位置声明一行，缩进与元素行一致。
  else out.push("  (no matching elements found)");
  if (p.unresolved)
    out.push(
      `UNRESOLVED (model-written): ${modelText(p.unresolved, CLEAN_LIMITS.gistMaxChars)}`,
    );
  if (invalid > 0) out.push(`NOTE: ${invalid} invalid pointers dropped`);
  return { text: out.join("\n"), invalid };
}
