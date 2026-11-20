// diff 的渲染（设计稿 §8.2）：一条一行，按树的层级缩进；块级增删标上下文与折叠的未变兄弟。
// `+ ` 新增、`~ ` 变化、`- ` 消失（编号只给新增与变化的控件），`@ ` 上下文、`= ` 折叠的未变。
// 渲染本身不截断：内联预算由调用方的 fitDiff 按行截。
import { type DiffItem, type DNode, transparent } from "./diff-tree.js";
import type { ElemDiff, Op } from "./elemdiff.js";
import { fixUrl } from "./mech.js";

/** 渲染时文字的上限（链接目标不截断）。 */
const TEXT_MAX = 200;
/** 上下文 / 折叠行的标签上限。 */
const LABEL_MAX = 60;
const IMG = "img";

const cut = (s: string): string =>
  s.length > TEXT_MAX
    ? `${s.slice(0, TEXT_MAX)}…(+${s.length - TEXT_MAX} chars)`
    : s;

/** 目标的写法：链接是 href 原样；图片读到的是绝对地址，同源的写成根相对，与机械层一致。 */
const urlText = (x: DiffItem, origin: string): string =>
  x.role === IMG ? (fixUrl(x.url, origin) ?? "") : (x.url ?? "");

/** 控件的一行：角色 + 名字 + 状态 + 目标 + 值（不带前缀与编号）。 */
const ctlBody = (x: DiffItem, withUrl: boolean, origin: string): string =>
  [
    x.role,
    JSON.stringify(cut(x.label)),
    ...(x.states.length > 0 ? [`[${x.states.join(",")}]`] : []),
    ...(withUrl && x.url !== null ? [`→ ${urlText(x, origin)}`] : []),
    ...(x.value ? [`: ${JSON.stringify(cut(x.value))}`] : []),
  ].join(" ");

const txtBody = (x: DiffItem): string => `${x.role}: ${cut(x.label)}`;

const statesOf = (x: DiffItem): string => `[${x.states.join(",") || "-"}]`;

/** 变化的一行：名字变了写成 `"旧" → "新"`，状态紧跟在名字后面，值的变化带冒号
 *  （`… "…": "" → "demo-user"`），目标的变化（链接的查询串 / 片段、图片地址）写成 `→ 新的 (was 旧的)`。 */
function changedBody(
  before: DiffItem,
  after: DiffItem,
  origin: string,
): string {
  const renamed = after.label !== before.label;
  const head = renamed
    ? after.kind === "ctl"
      ? `${after.role} ${JSON.stringify(cut(before.label))} → ${JSON.stringify(cut(after.label))}`
      : `${after.role}: ${cut(before.label)} → ${cut(after.label)}`
    : after.kind === "ctl"
      ? `${after.role} ${JSON.stringify(cut(after.label))}`
      : `${after.role}: ${cut(after.label)}`;
  if (after.kind !== "ctl") return head;
  const stateSeg =
    after.states.join() === before.states.join()
      ? ""
      : `${statesOf(before)} → ${statesOf(after)}`;
  const urlSeg =
    after.url !== before.url
      ? `→ ${cut(urlText(after, origin))} (was ${cut(urlText(before, origin))})`
      : "";
  if (after.value === before.value)
    return [head, urlSeg, stateSeg].filter(Boolean).join(" ");
  const valueSeg = `${JSON.stringify(cut(before.value))} → ${JSON.stringify(cut(after.value))}`;
  return `${head}${urlSeg ? ` ${urlSeg}` : ""}: ${[valueSeg, stateSeg].filter(Boolean).join(" ")}`;
}

/** 渲染表的一行：缩进层数、符号、编号、正文。 */
interface Row {
  depth: number;
  sign: "+" | "~" | "-" | "@" | "=";
  ref: string | null;
  body: string;
  /** 叶子行才相邻合并；带子节点的行后面跟着自己的子树，不合并 */
  leaf: boolean;
}

export interface RenderedDiff {
  lines: string[];
  added: number;
  removed: number;
  changed: number;
}

/** 子树里前序第一个有标签的条目（容器自己没条目时用它说明这是哪一块）。 */
function firstLabel(ns: DNode[]): string {
  for (const n of ns) {
    const label = n.item?.label ?? firstLabel(n.children);
    if (label) return label;
  }
  return "";
}

/** 头：`role` 或 `role "标签"`（标签截 60 字符）。 */
function headOf(n: DNode): string {
  const label = n.item?.label ?? firstLabel(n.children);
  if (!label) return n.role;
  return `${n.role} ${JSON.stringify(label.slice(0, LABEL_MAX))}`;
}

/** after 一侧的节点：用来数同一层里有没有别的同角色节点。 */
function afterNodes(op: Op): DNode[] {
  if (op.kind === "same") return op.nodes;
  if (op.kind === "add") return [op.node];
  if (op.kind === "mod") return [op.after];
  return [];
}

/** 这一块是不是「块级」的：渲染出来不止一行。透明容器拆开再看，一层 generic 包着的叶子还是叶子。 */
function blocky(node: DNode): boolean {
  if (transparent(node)) return node.children.some(blocky);
  return node.children.length > 0;
}

/** 一个新增子树：自己一行，子节点各缩进一层（透明容器不加缩进）。 */
function addRows(
  node: DNode,
  depth: number,
  origin: string,
  rows: Row[],
): void {
  const kids = transparent(node) ? depth : depth + 1;
  if (node.item !== null)
    rows.push({
      depth,
      sign: "+",
      ref: node.item.kind === "ctl" ? node.item.ref : null,
      body:
        node.item.kind === "ctl"
          ? ctlBody(node.item, true, origin)
          : txtBody(node.item),
      leaf: node.children.length === 0,
    });
  else if (!transparent(node))
    rows.push({
      depth,
      sign: "+",
      ref: null,
      body: headOf(node),
      leaf: node.children.length === 0,
    });
  for (const kid of node.children) addRows(kid, kids, origin, rows);
}

/** 消失只写一行：不展开子树，有子树的写出条目个数。 */
function delRow(node: DNode, depth: number, origin: string, rows: Row[]): void {
  const body =
    node.item === null
      ? headOf(node)
      : node.item.kind === "ctl"
        ? // 消失的有名图片只写名字（地址已经不在了）；无名图片只有地址能说明是哪一张。
          ctlBody(
            node.item,
            node.item.role !== IMG || node.item.label === "",
            origin,
          )
        : txtBody(node.item);
  rows.push({
    depth,
    sign: "-",
    ref: null,
    body: node.elements > 1 ? `${body} (${node.elements} elements)` : body,
    // 整块消失的行不合并：合并后分不清「几块」还是「几个元素」
    leaf: node.children.length === 0,
  });
}

/** 一层兄弟序列的渲染。 */
function renderOps(
  ops: Op[],
  depth: number,
  origin: string,
  rows: Row[],
): void {
  // 这一层有块级的增删（渲染出来不止一行的），才给未变的兄弟标位置。
  const block = ops.some(
    (op) => (op.kind === "add" || op.kind === "del") && blocky(op.node),
  );
  // 同一层里出现不止一次的角色：「一串同类里的某一个」才写上下文行。
  const roles = new Map<string, number>();
  for (const op of ops)
    for (const n of afterNodes(op))
      roles.set(n.role, (roles.get(n.role) ?? 0) + 1);

  for (const op of ops) {
    switch (op.kind) {
      case "same":
        if (!block) break;
        rows.push({
          depth,
          sign: "=",
          ref: null,
          body:
            op.nodes.length === 1
              ? `1 unchanged (${headOf(op.nodes[0] as DNode)})`
              : `${op.nodes.length} unchanged (${headOf(op.nodes[0] as DNode)} … ${headOf(op.nodes[op.nodes.length - 1] as DNode)})`,
          leaf: true,
        });
        break;
      case "add":
        addRows(op.node, depth, origin, rows);
        break;
      case "del":
        delRow(op.node, depth, origin, rows);
        break;
      case "mod": {
        const own = op.own;
        const head = own !== null;
        const noisy = !head && !op.kids.every((k) => k.kind === "same");
        const contextual =
          noisy &&
          !transparent(op.after) &&
          (roles.get(op.after.role) ?? 0) > 1;
        if (own !== null)
          rows.push({
            depth,
            sign: "~",
            ref: own.after.kind === "ctl" ? own.after.ref : null,
            body: changedBody(own.before, own.after, origin),
            leaf: true,
          });
        else if (contextual)
          rows.push({
            depth,
            sign: "@",
            ref: null,
            body: headOf(op.after),
            leaf: true,
          });
        // 自己变了的、写了上下文行的，子树缩进一层；其余与它同缩进（块级结构本身不算变化）。
        renderOps(
          op.kids,
          head || contextual ? depth + 1 : depth,
          origin,
          rows,
        );
        break;
      }
    }
  }
}

/** 相邻的同符号、同缩进、同正文（不含编号）的叶子行合并成一行，末尾写多出来的个数。 */
function mergeAdjacent(rows: Row[]): string[] {
  const text = (r: Row): string =>
    `${"  ".repeat(r.depth)}${r.sign} ${[r.ref, r.body].filter(Boolean).join(" ")}`;
  const out: string[] = [];
  /** 上一行可合并的键、它在 out 里的下标、合并后的正文 */
  let prev: { key: string; at: number; more: number; base: string } | null =
    null;
  for (const r of rows) {
    const key = r.leaf ? `${r.depth}|${r.sign}|${r.body}` : "";
    if (prev !== null && key !== "" && prev.key === key) {
      prev.more += 1;
      // 保留第一项的编号，要点的话至少点得到它。
      out[prev.at] = `${prev.base} (×${prev.more} more)`;
      continue;
    }
    prev = key === "" ? null : { key, at: out.length, more: 0, base: text(r) };
    out.push(text(r));
  }
  return out;
}

/** 统计：新增 / 消失的子树条目数、自己变化的个数。 */
function count(ops: Op[]): { added: number; removed: number; changed: number } {
  let added = 0;
  let removed = 0;
  let changed = 0;
  const walk = (list: Op[]): void => {
    for (const op of list) {
      if (op.kind === "add") added += op.node.elements;
      else if (op.kind === "del") removed += op.node.elements;
      else if (op.kind === "mod") {
        if (op.own !== null) changed += 1;
        walk(op.kids);
      }
    }
  };
  walk(ops);
  return { added, removed, changed };
}

/** 完整渲染（不截断）。origin 是页面源：图片的同源绝对地址与机械层一样写成根相对。 */
export function renderDiff(d: ElemDiff, origin = ""): RenderedDiff {
  const rows: Row[] = [];
  renderOps(d.ops, 0, origin, rows);
  return { lines: mergeAdjacent(rows), ...count(d.ops) };
}

/** 按行取最长前缀，使其总字符数不超过 maxChars（至少留 1 行，哪怕它自己就超了）。 */
export function fitDiff(
  lines: string[],
  maxChars: number,
): { text: string; hidden: number } {
  let at = 0;
  let chars = 0;
  for (const line of lines) {
    // 行之间还有一个换行符
    const size = line.length + (at === 0 ? 0 : 1);
    if (at > 0 && chars + size > maxChars) break;
    chars += size;
    at += 1;
  }
  return { text: lines.slice(0, at).join("\n"), hidden: lines.length - at };
}
