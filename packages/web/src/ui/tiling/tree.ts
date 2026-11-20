// 分割树：叶子是任意对象（无 children 字段），分支带方向与权重。纯函数，不认识叶子是什么。

export type Dir = "row" | "col";
export type EdgeZone = "left" | "right" | "top" | "bottom";

/** 分支：dir 方向上排开 children，sizes 是与 children 等长的正数权重 */
export interface Branch<N> {
  dir: Dir;
  sizes: number[];
  children: N[];
}
export type Tree<L> = L | Branch<Tree<L>>;

export function isBranch<L extends object>(n: Tree<L>): n is Branch<Tree<L>> {
  return "children" in n;
}

/** 深度优先、从左到右的叶子 */
export function leaves<L extends object>(n: Tree<L> | null): L[] {
  if (!n) return [];
  if (!isBranch(n)) return [n];
  return n.children.flatMap((c) => leaves<L>(c));
}

const validSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** sizes 对齐 children：缺的补 1，非正数/非数字变 1，多的截掉 */
export function normSizes(b: {
  sizes?: unknown;
  children: readonly unknown[];
}): number[] {
  const src: unknown[] = Array.isArray(b.sizes) ? b.sizes : [];
  return b.children.map((_, i) => (validSize(src[i]) ? src[i] : 1));
}

/** 按叶子删除并折叠：分支剩 1 个孩子就提升，剩 0 个返回 null */
export function removeLeaf<L extends object>(
  n: Tree<L>,
  drop: (l: L) => boolean,
): Tree<L> | null {
  if (!isBranch(n)) return drop(n) ? null : n;
  const src = normSizes(n);
  const children: Tree<L>[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const kept = removeLeaf(c, drop);
    if (kept) {
      children.push(kept);
      sizes.push(src[i] ?? 1);
    }
  });
  if (children.length === 0) return null;
  const only = children[0];
  if (children.length === 1 && only) return only;
  return { dir: n.dir, sizes, children };
}

/**
 * 在命中叶子的某一侧插入新叶子。
 * - 目标叶子的父分支方向与落点一致：同层插入（不增加嵌套）
 * - 否则把目标叶子替换成一个新的二叉分支
 * 找不到目标时原样返回同一个引用，调用方可据此判断是否生效。
 */
export function insertBeside<L extends object>(
  n: Tree<L>,
  isTarget: (l: L) => boolean,
  zone: EdgeZone,
  leaf: L,
): Tree<L> {
  const horizontal = zone === "left" || zone === "right";
  const first = zone === "left" || zone === "top";
  if (!isBranch(n)) {
    if (!isTarget(n)) return n;
    return {
      dir: horizontal ? "row" : "col",
      sizes: [1, 1],
      children: first ? [leaf, n] : [n, leaf],
    };
  }
  const idx = n.children.findIndex((c) => leaves<L>(c).some(isTarget));
  const child = n.children[idx];
  if (!child) return n;

  if (!isBranch(child) && n.dir === (horizontal ? "row" : "col")) {
    const children = [...n.children];
    const sizes = normSizes(n);
    const at = first ? idx : idx + 1;
    children.splice(at, 0, leaf);
    sizes.splice(at, 0, 1);
    return { dir: n.dir, sizes, children };
  }
  const replaced = insertBeside(child, isTarget, zone, leaf);
  if (replaced === child) return n;
  const children = [...n.children];
  children[idx] = replaced;
  return { dir: n.dir, sizes: normSizes(n), children };
}

export function mapLeaves<L extends object>(
  n: Tree<L>,
  fn: (l: L) => L,
): Tree<L> {
  if (!isBranch(n)) return fn(n);
  return { ...n, children: n.children.map((c) => mapLeaves(c, fn)) };
}

/** 修改 path（从根起的 children 下标序列）所指分支的 sizes；路径或 sizes 非法返回 null */
export function setSizesAt<L extends object>(
  n: Tree<L>,
  path: readonly number[],
  sizes: readonly number[],
): Tree<L> | null {
  if (!isBranch(n)) return null;
  if (path.length === 0) {
    if (sizes.length !== n.children.length || !sizes.every(validSize))
      return null;
    return { ...n, sizes: [...sizes] };
  }
  const [i, ...rest] = path;
  const child = i === undefined ? undefined : n.children[i];
  if (i === undefined || !child) return null;
  const next = setSizesAt(child, rest, sizes);
  if (!next) return null;
  const children = [...n.children];
  children[i] = next;
  return { ...n, children };
}
