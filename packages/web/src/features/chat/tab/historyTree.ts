// B20 树视图的扁平化：服务端节点树 → 带缩进/连接线的行。
// 缩进口径参考 pi tree selector：单链不缩进，只在分叉点（多子节点）以及分叉后的第一代缩进；
// 当前 activePath 所在分支排在分叉处前面，默认就是展开可见的。
import type { TreeNode } from "../../../api/session-nav";

export interface TreeRow {
  node: TreeNode;
  /** 缩进层级（0 起）：渲染时由 prefix 体现 */
  indent: number;
  /** 是否是同一父节点下的最后一个子节点（连接线用 └ 而不是 ├） */
  isLast: boolean;
  /** 是否画连接线：只有父节点有多个子节点时才分叉 */
  connector: boolean;
  /** 连接线/缩进前缀（mono 字符，如 "│ ├─"） */
  prefix: string;
  /** 是否在当前 activePath 上 */
  active: boolean;
  /** 分叉点才有折叠按钮 */
  foldable: boolean;
  folded: boolean;
  /** 折叠时隐藏的子孙节点数 */
  hidden: number;
}

interface Frame {
  node: TreeNode;
  indent: number;
  /** 父节点是否刚分叉（分叉后的第一代再缩进一级） */
  justBranched: boolean;
  connector: boolean;
  isLast: boolean;
  /** 祖先层需要继续画的竖线：层级 → 是否显示 */
  gutters: ReadonlyMap<number, boolean>;
  /** 多根时根节点是虚拟根的孩子，不画自己的连接线 */
  virtualRootChild: boolean;
}

const NO_GUTTERS: ReadonlyMap<number, boolean> = new Map();

const countNodes = (nodes: readonly TreeNode[]): number =>
  nodes.reduce((n, c) => n + 1 + countNodes(c.children), 0);

const activeFirst = (
  nodes: readonly TreeNode[],
  containsActive: ReadonlyMap<string, boolean>,
): TreeNode[] =>
  [...nodes].sort(
    (a, b) =>
      Number(containsActive.get(b.id) ?? false) -
      Number(containsActive.get(a.id) ?? false),
  );

/**
 * 扁平化整棵树。folded 里的分叉点不展开子孙；隐藏数量记在 hidden 上供界面提示。
 * activePath 用于高亮并决定分叉处的排序（当前分支在前）。
 */
export function flattenTree(
  roots: readonly TreeNode[],
  activePath: readonly string[],
  folded: ReadonlySet<string> = new Set(),
): TreeRow[] {
  const active = new Set(activePath);
  // 后序遍历：每个节点是否包含当前 active 分支
  const containsActive = new Map<string, boolean>();
  const visit = (node: TreeNode): boolean => {
    let hit = active.has(node.id);
    for (const child of node.children) if (visit(child)) hit = true;
    containsActive.set(node.id, hit);
    return hit;
  };
  for (const root of roots) visit(root);

  const multipleRoots = roots.length > 1;
  const orderedRoots = activeFirst(roots, containsActive);
  const stack: Frame[] = [];
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    const node = orderedRoots[i] as TreeNode;
    stack.push({
      node,
      indent: multipleRoots ? 1 : 0,
      justBranched: multipleRoots,
      connector: multipleRoots,
      isLast: i === orderedRoots.length - 1,
      gutters: NO_GUTTERS,
      virtualRootChild: multipleRoots,
    });
  }

  const rows: TreeRow[] = [];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const { node } = frame;
    // 多根时根节点显示在第 0 层，子节点从第 1 层开始画连接线
    const displayIndent = multipleRoots
      ? Math.max(0, frame.indent - 1)
      : frame.indent;
    const connector = frame.connector && !frame.virtualRootChild;
    const connectorPosition = connector ? Math.max(0, displayIndent - 1) : -1;
    let prefix = "";
    for (let level = 0; level < displayIndent; level++) {
      const gutter = frame.gutters.get(level);
      if (gutter !== undefined) prefix += gutter ? "│ " : "  ";
      else if (level === connectorPosition)
        prefix += frame.isLast ? "└─" : "├─";
      else prefix += "  ";
    }

    // 折叠只发生在分叉点：单链上的节点没有折叠按钮，避免把当前分支藏起来。
    const foldable = node.children.length > 1;
    const isFolded = foldable && folded.has(node.id);
    rows.push({
      node,
      indent: displayIndent,
      isLast: frame.isLast,
      connector,
      prefix,
      active: active.has(node.id),
      foldable,
      folded: isFolded,
      hidden: isFolded ? countNodes(node.children) : 0,
    });
    if (isFolded) continue;

    const children = activeFirst(node.children, containsActive);
    const multipleChildren = children.length > 1;
    const childIndent = multipleChildren
      ? frame.indent + 1
      : frame.justBranched && frame.indent > 0
        ? frame.indent + 1
        : frame.indent;
    // 本行画了连接线时，子孙行要在同一列继续画竖线：本行不是最后一个子节点才往下连。
    const childGutters = connector
      ? new Map(frame.gutters).set(connectorPosition, !frame.isLast)
      : frame.gutters;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({
        node: children[i] as TreeNode,
        indent: childIndent,
        justBranched: multipleChildren,
        connector: multipleChildren,
        isLast: i === children.length - 1,
        gutters: childGutters,
        virtualRootChild: false,
      });
    }
  }
  return rows;
}
