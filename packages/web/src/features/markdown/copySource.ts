// 复制渲染出来的 Markdown 时给原文：选区碰到的块（段落、标题、列表、代码块、表格……）整块复制它在原文里的写法，
// 只选了某块的一部分时那一段还是纯文字。选区整个落在一个块的内部（选一句话）不接管，照浏览器默认复制。
// 渲染时由 rehypeSourceRange 给块级元素带上它在原文里的起止偏移（data-md-s / data-md-e）；
// 渲染容器的 onCopy 调 copyAsMarkdown，容器里拿不准的元素（没有标注）一律放弃接管。
// 对话流这类一串渲染块（回复正文、用户消息、中间夹着工具行）的容器用 copyStreamAsMarkdown：每个渲染块在
// `sourceRef` 里登记自己的原文，选区跨过多块时各自还原，块与块之间的内容（工具行的文字）照常带上。
import type { ClipboardEvent } from "react";

const S = "data-md-s";
const E = "data-md-e";

// 块级元素：偏移取自 remark 解析时的位置信息（所以原文要与交给 react-markdown 的是同一份）
const BLOCKS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "hr",
]);

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: HastNode[];
}

/** rehype 插件：块级元素带上它在原文里的起止偏移 */
export function rehypeSourceRange() {
  const walk = (node: HastNode) => {
    const s = node.position?.start.offset;
    const e = node.position?.end.offset;
    if (
      node.type === "element" &&
      node.tagName &&
      BLOCKS.has(node.tagName) &&
      s !== undefined &&
      e !== undefined
    )
      node.properties = { ...node.properties, dataMdS: s, dataMdE: e };
    for (const c of node.children ?? []) walk(c);
  };
  return walk;
}

/** 自定义块组件（代码卡片等）把标注原样带到自己的根元素上：从传给它的 props 里取 */
export const srcAttrs = (props: object): Record<string, string> => {
  const p = props as Record<string, unknown>;
  return p[S] === undefined ? {} : { [S]: String(p[S]), [E]: String(p[E]) };
};

type Piece = { s: number; e: number } | { text: string };

const pointBefore = (n: Node): Range => {
  const r = document.createRange();
  r.setStartBefore(n);
  r.collapse(true);
  return r;
};
const pointAfter = (n: Node): Range => {
  const r = document.createRange();
  r.setStartAfter(n);
  r.collapse(true);
  return r;
};

// 选区与「从 from 的起点到 to 的终点」重叠的那一段；没有重叠是 null
function slice(range: Range, from: Range, to: Range): Range | null {
  const part = range.cloneRange();
  if (part.compareBoundaryPoints(Range.START_TO_START, from) < 0)
    part.setStart(from.startContainer, from.startOffset);
  if (part.compareBoundaryPoints(Range.END_TO_END, to) > 0)
    part.setEnd(to.endContainer, to.endOffset);
  return part.collapsed ? null : part;
}

// 选区落在 el 内的那一段（选区端点超出 el 的部分截掉）
function clipTo(range: Range, el: Element): Range | null {
  const whole = document.createRange();
  whole.selectNodeContents(el);
  return slice(range, whole, whole);
}

const partOf = (range: Range, el: Element): string =>
  clipTo(range, el)?.toString() ?? "";

// 把 el 里的文字全选中了（选区端点常落在首尾文本节点里，所以比文字而不比端点）
const covers = (range: Range, el: Element): boolean =>
  partOf(range, el).trim() === (el.textContent ?? "").trim();

/** 选区碰到的块，依次是整块的原文区间或某块被选中的那一段文字；碰到没有标注的元素返回 null */
function collect(parent: Element, range: Range): Piece[] | null {
  const out: Piece[] = [];
  for (const el of parent.children) {
    if (!range.intersectsNode(el)) continue;
    const s = el.getAttribute(S);
    const e = el.getAttribute(E);
    const nested = el.querySelector(`[${S}]`) !== null;
    if (s !== null && e !== null && covers(range, el)) {
      out.push({ s: Number(s), e: Number(e) });
    } else if (nested) {
      // 容器（列表、引用，或没有标注的包装元素）：往里找被选中的块
      const inner = collect(el, range);
      if (!inner) return null;
      out.push(...inner);
    } else if (s !== null) {
      out.push({ text: partOf(range, el) });
    } else {
      // 没有标注、里面也没有标注的块：拿不准是什么，放弃
      return null;
    }
  }
  return out;
}

/** 选区对应的 Markdown 原文；没有可接管的（选区在一个块内部、碰到没标注的元素）返回 null */
export function markdownOfSelection(
  root: Element,
  range: Range,
  source: string,
): string | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  const pieces = collect(root, range);
  if (!pieces || pieces.every((p) => "text" in p)) return null;
  let out = "";
  let prev: Piece | null = null;
  for (const p of pieces) {
    const text = "text" in p ? p.text.trim() : source.slice(p.s, p.e);
    if (prev) {
      // 相邻两块都是整块：沿用原文里它们之间的空白（紧凑列表的单换行、块之间的空行）；其余统一空一行
      const gap =
        !("text" in prev) && !("text" in p) ? source.slice(prev.e, p.s) : "";
      out += gap !== "" && gap.trim() === "" ? gap : "\n\n";
    }
    out += text;
    prev = p;
  }
  return out;
}

/** 渲染容器的 onCopy：能接管就把剪贴板里的文字换成原文 */
export function copyAsMarkdown(
  e: ClipboardEvent<HTMLElement>,
  source: string,
): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const text = markdownOfSelection(e.currentTarget, sel.getRangeAt(0), source);
  if (text === null) return;
  e.clipboardData.setData("text/plain", text);
  e.preventDefault();
}

// 对话流里每个 Markdown 渲染块的原文：块渲染时登记，容器的 onCopy 据此还原
const SOURCES = new WeakMap<Element, string>();
const ROOT = "data-md-root";

/** Markdown 渲染块的 ref：登记原文（每次渲染都带最新的），并打上标记供 copyStreamAsMarkdown 找到 */
export function sourceRef(text: string): (el: HTMLElement | null) => void {
  return (el) => {
    if (!el) return;
    el.setAttribute(ROOT, "");
    SOURCES.set(el, text);
  };
}

/**
 * 对话流容器的 onCopy：选区碰到的每个渲染块还原成 Markdown 原文（块内只选了一句话的那块仍是选中的文字），
 * 渲染块之间的内容（工具行等）取选中的文字，各部分用空行连起来。没有任何渲染块能还原成原文就不接管。
 */
export function copyStreamAsMarkdown(e: ClipboardEvent<HTMLElement>): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const roots = e.currentTarget.querySelectorAll<HTMLElement>(`[${ROOT}]`);

  const parts: string[] = [];
  let tookOver = false;
  const gap = (from: Range, to: Range) => {
    const text = slice(range, from, to)?.toString().trim();
    if (text) parts.push(text);
  };
  let cursor = range;
  for (const r of roots) {
    gap(cursor, pointBefore(r));
    const part = clipTo(range, r);
    if (part) {
      const md = markdownOfSelection(r, part, SOURCES.get(r) as string);
      if (md !== null) tookOver = true;
      const text = md ?? part.toString().trim();
      if (text) parts.push(text);
    }
    cursor = pointAfter(r);
  }
  gap(cursor, range);
  if (!tookOver) return;
  e.clipboardData.setData("text/plain", parts.join("\n\n"));
  e.preventDefault();
}
