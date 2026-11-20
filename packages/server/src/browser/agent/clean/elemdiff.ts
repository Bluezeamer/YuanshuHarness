// 块级对齐的元素级 diff（设计稿 §8.2）：按元素树的结构比，同级兄弟序列做最长公共子序列，
// 配上的一对再递归比子树。身份 = 角色 + 名字（链接加路径，忽略查询串与片段；纯文字加内容）；
// 编号不算身份——整块重绘后编号会整体变。对调两块就是「一块消失 + 同一块在新位置新增」，不另报重排。
import {
  buildTree,
  type DiffItem,
  type DNode,
  transparent,
} from "./diff-tree.js";

export interface OwnChange {
  before: DiffItem;
  after: DiffItem;
}

export type Op =
  /** 一串对齐上且完全没变的兄弟（取 after 一侧的节点） */
  | { kind: "same"; nodes: DNode[] }
  | { kind: "add"; node: DNode }
  | { kind: "del"; node: DNode }
  /** 配上了、但自己或子树里有变化 */
  | {
      kind: "mod";
      before: DNode;
      after: DNode;
      own: OwnChange | null;
      kids: Op[];
    };

export interface ElemDiff {
  ops: Op[];
}

/** LCS 的格子上限：超过就不做 DP，中间段整体当一个缺口，不抛错、不卡。 */
const CELLS_MAX = 4_000_000;

/** 两份**原始**快照（引擎原文，未经机械层）的块级比较。 */
export function diffElements(beforeRaw: string, afterRaw: string): ElemDiff {
  return { ops: alignSeq(buildTree(beforeRaw), buildTree(afterRaw)) };
}

export function isUnchanged(d: ElemDiff): boolean {
  return d.ops.every((op) => op.kind === "same");
}

/** 配上的这一对里自己有没有变化：名字、文字、状态、目标任一不同。 */
function ownChange(before: DNode, after: DNode): OwnChange | null {
  const b = before.item;
  const a = after.item;
  if (b === null || a === null) return null;
  if (
    b.label === a.label &&
    b.value === a.value &&
    b.states.join() === a.states.join() &&
    b.url === a.url
  )
    return null;
  return { before: b, after: a };
}

/** 配上的这一对：自己与子树都没变化，就退回一个 same（调用方合并相邻的）。 */
function pairOp(before: DNode, after: DNode): Op {
  const own = ownChange(before, after);
  const kids = alignSeq(before.children, after.children);
  if (own === null && kids.every((k) => k.kind === "same"))
    return { kind: "same", nodes: [after] };
  return { kind: "mod", before, after, own, kids };
}

/** 缺口里能逐位置配对的条件：角色相同、都有条目或都没有、条目的 kind 相同。 */
const pairable = (b: DNode, a: DNode): boolean =>
  b.role === a.role &&
  (b.item === null) === (a.item === null) &&
  (b.item === null || a.item === null || b.item.kind === a.item.kind);

/** 把透明的 generic 包装层拆开，换成它的孩子（嵌套的一并拆）。 */
const unwrap = (ns: DNode[]): DNode[] =>
  ns.flatMap((n) => (transparent(n) ? unwrap(n.children) : [n]));

/**
 * 缺口（两个锚点之间、或前后缀与锚点之间剩下的节点）：两边个数相等且不为 0 才逐位置配对
 * （配不上的那对拆成 del + add）；个数不等就整体当「先全删、后全加」，不猜。
 * 例外：两边都有节点、且有透明包装层时，先拆开包装层再对齐——
 * 容器里的元素个数在 1 与多个之间变化时，包装层会时有时无，不拆就把没变的那个也报成消失 + 新增。
 */
function gap(before: DNode[], after: DNode[]): Op[] {
  if (
    before.length > 0 &&
    after.length > 0 &&
    (before.some(transparent) || after.some(transparent))
  )
    return alignSeq(unwrap(before), unwrap(after));
  if (
    before.length === 0 ||
    after.length === 0 ||
    before.length !== after.length
  )
    return [
      ...before.map((node): Op => ({ kind: "del", node })),
      ...after.map((node): Op => ({ kind: "add", node })),
    ];
  const out: Op[] = [];
  before.forEach((b, i) => {
    const a = after[i] as DNode;
    if (pairable(b, a)) out.push(pairOp(b, a));
    else out.push({ kind: "del", node: b }, { kind: "add", node: a });
  });
  return out;
}

/** sig → 整数（两份快照共用一套编号），LCS 的 DP 表按整数比。 */
const interner = () => {
  const ids = new Map<string, number>();
  return (sig: string): number => {
    const hit = ids.get(sig);
    if (hit !== undefined) return hit;
    const next = ids.size;
    ids.set(sig, next);
    return next;
  };
};

/** 中间段的 LCS：返回配对下标（相对中间段）。格子太多就不做，返回空（整个中间段当一个缺口）。 */
function lcs(pre: string[], post: string[]): [number, number][] {
  const n = pre.length;
  const m = post.length;
  if (n === 0 || m === 0 || n * m > CELLS_MAX) return [];
  const id = interner();
  const b = pre.map(id);
  const a = post.map(id);
  const w = m + 1;
  // dp[i][j]：pre[i..] 与 post[j..] 的 LCS 长度（从后往前填）
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] =
        b[i] === a[j]
          ? (dp[(i + 1) * w + j + 1] as number) + 1
          : Math.max(
              dp[(i + 1) * w + j] as number,
              dp[i * w + j + 1] as number,
            );
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (b[i] === a[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number))
      i++;
    else j++;
  }
  return out;
}

/** 同一层的兄弟序列对齐：公共前后缀按序配对，中间段取 LCS 锚点，锚点之间按缺口处理。 */
function alignSeq(before: DNode[], after: DNode[]): Op[] {
  const sb = before.map((n) => n.sig);
  const sa = after.map((n) => n.sig);
  let head = 0;
  while (head < sb.length && head < sa.length && sb[head] === sa[head]) head++;
  let tail = 0;
  while (
    tail < sb.length - head &&
    tail < sa.length - head &&
    sb[sb.length - 1 - tail] === sa[sa.length - 1 - tail]
  )
    tail++;
  /** 中间段的起止：前后缀之外的都算中间。 */
  const endB = sb.length - tail;
  const endA = sa.length - tail;

  const out: Op[] = [];
  let run: DNode[] = [];
  const flush = (): void => {
    if (run.length > 0) out.push({ kind: "same", nodes: run });
    run = [];
  };
  const emit = (ops: Op[]): void => {
    for (const op of ops) {
      if (op.kind === "same") run.push(...op.nodes);
      else {
        flush();
        out.push(op);
      }
    }
  };

  for (let i = 0; i < head; i++)
    emit([pairOp(before[i] as DNode, after[i] as DNode)]);
  const anchors = lcs(sb.slice(head, endB), sa.slice(head, endA));
  let bi = head;
  let ai = head;
  for (const [i, j] of anchors) {
    const pb = head + i;
    const pa = head + j;
    emit(gap(before.slice(bi, pb), after.slice(ai, pa)));
    emit([pairOp(before[pb] as DNode, after[pa] as DNode)]);
    bi = pb + 1;
    ai = pa + 1;
  }
  emit(gap(before.slice(bi, endB), after.slice(ai, endA)));
  for (let t = 0; t < tail; t++)
    emit([pairOp(before[endB + t] as DNode, after[endA + t] as DNode)]);
  flush();
  return out;
}
