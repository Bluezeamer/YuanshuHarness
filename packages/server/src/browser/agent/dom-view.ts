// 读到的 DOM → 给模型看的文字（一行一个元素、缩进表示层级）与落文件的全文。
// 纯函数：不碰工具与引擎，渲染规则固定，方便单独推定格式。
import { describeSrc } from "../engine/img-src.js";
import type {
  DomCapture,
  DomElement,
  DomTarget,
  DomText,
} from "../engine/types.js";
import { type Budgeted, budgetLines } from "./budget.js";

/** 单个属性值 / 文本节点的显示上限。 */
const VALUE_MAX = 300;

export interface DomQuery {
  title: string;
  url: string;
  target: DomTarget;
}

/** 超长的截断并标出剩下的字符数；length 是原长（页面里已按属性 4000 / 文本 2000 截过）。 */
function clip(value: string, length: number): string {
  if (length <= VALUE_MAX) return value;
  return `${value.slice(0, VALUE_MAX)}…(+${length - VALUE_MAX} chars)`;
}

/** 属性值规整：data: 地址只写 mime 与长度，其余同文本。 */
function short(value: string, length: number): string {
  return value.startsWith("data:") ? describeSrc(value) : clip(value, length);
}

function isElement(node: DomElement | DomText): node is DomElement {
  return "tag" in node;
}

/** `<tag attrs>`；没有属性就是 `<tag>`。 */
function open(el: DomElement): string {
  const attrs = el.attrs
    .map((a) =>
      a.value === ""
        ? a.name
        : `${a.name}="${short(a.value, a.length).replace(/"/g, '\\"')}"`,
    )
    .join(" ");
  return `<${el.tag}${attrs === "" ? "" : ` ${attrs}`}>`;
}

/** 浏览器算出来的值：`@` 前缀与真属性区分开，顺序固定；`@box` 只给根元素。 */
function computed(el: DomElement, root: boolean): string {
  const parts: string[] = [];
  if (root && el.box)
    parts.push(`@box=${el.box.x},${el.box.y},${el.box.width},${el.box.height}`);
  if (el.natural)
    parts.push(`@natural=${el.natural.width}x${el.natural.height}`);
  if (el.currentSrc)
    parts.push(`@src=${short(el.currentSrc, el.currentSrc.length)}`);
  return parts.join(" ");
}

function withComputed(el: DomElement, root: boolean): string {
  const tail = computed(el, root);
  return tail === "" ? open(el) : `${open(el)} ${tail}`;
}

/** 一个元素的渲染（含缩进）；孩子与 shadow 内容各缩进两格。 */
function renderElement(
  el: DomElement,
  indent: string,
  root: boolean,
  out: string[],
): void {
  const line = `${indent}${withComputed(el, root)}`;
  if (el.summary !== undefined) {
    out.push(`${line} (${el.summary})`);
    return;
  }
  const shadow = el.shadow ?? [];
  const hasElementKid = el.kids.some(isElement);
  if (!hasElementKid && shadow.length === 0) {
    // 叶子：文字写在标签行里（没有文字就不闭合）；计算值仍然放在行末。
    const words = el.kids
      .filter((k): k is DomText => !isElement(k))
      .map((k) => clip(k.text, k.length))
      .join(" ");
    const body = words === "" ? open(el) : `${open(el)}${words}</${el.tag}>`;
    const tail = computed(el, root);
    out.push(`${indent}${body}${tail === "" ? "" : ` ${tail}`}`);
    return;
  }
  out.push(line);
  for (const kid of el.kids) {
    if (isElement(kid)) renderElement(kid, `${indent}  `, false, out);
    else out.push(`${indent}  "${clip(kid.text, kid.length)}"`);
  }
  if (shadow.length > 0) {
    out.push(`${indent}  #shadow-root`);
    for (const kid of shadow) {
      if (isElement(kid)) renderElement(kid, `${indent}    `, false, out);
      else out.push(`${indent}    "${clip(kid.text, kid.length)}"`);
    }
  }
}

const NORMALIZED =
  "comments dropped; script/style bodies, svg internals and templates summarized; long attribute values and data: URLs shortened; open shadow roots expanded; iframe contents are not included in ref/document views; hidden elements are included";

function shellLines(query: DomQuery): string[] {
  const t = query.target;
  const where =
    t === null
      ? "document"
      : "selector" in t
        ? `selector "${t.selector}"`
        : `ref ${t.ref}`;
  return [
    `DOM: ${query.title} | ${query.url}`,
    `QUERY: ${where}`,
    `NORMALIZED: ${NORMALIZED}`,
  ];
}

/** 内容：selector 模式每个 group 一段（FRAME 行 + 连续编号的根元素）。 */
function bodyLines(capture: DomCapture, bySelector: boolean): string[] {
  const body: string[] = [];
  let n = 0;
  for (const group of capture.groups) {
    if (bySelector)
      body.push(
        group.frame.main
          ? "FRAME main:"
          : `FRAME ${group.frame.url} (positions are inside the frame):`,
      );
    for (const root of group.roots) {
      n += 1;
      const lines: string[] = [];
      renderElement(root, "", true, lines);
      const [first, ...rest] = lines;
      body.push(`${bySelector ? `[${n}] ` : ""}${first ?? ""}`, ...rest);
    }
    if (group.total > group.roots.length)
      body.push(
        `… ${group.total - group.roots.length} more matches not listed (narrow the selector)`,
      );
  }
  if (capture.groups.length === 0) body.push("No elements matched.");
  if (capture.nodeCapHit)
    body.push(
      "TRUNCATED: node cap reached; the rest of the page was not read (narrow the selector or use ref)",
    );
  return body;
}

export function renderDom(capture: DomCapture, query: DomQuery): Budgeted {
  const t = query.target;
  const bySelector = t !== null && "selector" in t;
  const shell = shellLines(query);
  const body = bodyLines(capture, bySelector);
  return budgetLines(shell, body, "full text");
}
