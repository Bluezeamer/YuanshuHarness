import type { Rect, TreeNode } from "./types";

export const MIN_RATIO = 0.05;

const leaf = (paneId: string): TreeNode => ({ kind: "leaf", paneId });

export function paneIds(t: TreeNode | null): string[] {
  if (!t) return [];
  return t.kind === "leaf" ? [t.paneId] : t.children.flatMap(paneIds);
}

// 比例之和不为 1 或长度与子节点不符时按等分修复；返回是否修过。
export function repair(t: TreeNode): { tree: TreeNode; fixed: boolean } {
  if (t.kind === "leaf") return { tree: t, fixed: false };
  let fixed = false;
  const children = t.children.map((c) => {
    const r = repair(c);
    fixed ||= r.fixed;
    return r.tree;
  });
  const sum = t.ratios.reduce((a, b) => a + b, 0);
  const ok =
    t.ratios.length === children.length &&
    Math.abs(sum - 1) < 1e-6 &&
    t.ratios.every((r) => r > 0);
  if (ok) return { tree: { ...t, children }, fixed };
  const even = children.map(() => 1 / children.length);
  return { tree: { ...t, children, ratios: even }, fixed: true };
}

// 在 target 上分割，新 pane 放在 before ? 前 : 后。同向的父节点直接并入，避免无谓嵌套。
export function split(
  t: TreeNode,
  target: string,
  dir: "h" | "v",
  newId: string,
  before = false,
): TreeNode {
  if (t.kind === "leaf") {
    if (t.paneId !== target) return t;
    const kids = before ? [leaf(newId), t] : [t, leaf(newId)];
    return { kind: "split", dir, children: kids, ratios: [0.5, 0.5] };
  }
  const i = t.children.findIndex(
    (c) => c.kind === "leaf" && c.paneId === target,
  );
  if (i >= 0 && t.dir === dir) {
    const at = before ? i : i + 1;
    const children = [...t.children];
    children.splice(at, 0, leaf(newId));
    const r = t.ratios[i];
    if (r === undefined) return t;
    const half = r / 2;
    const ratios = [...t.ratios];
    ratios[i] = half;
    ratios.splice(at, 0, half);
    return { ...t, children, ratios };
  }
  return {
    ...t,
    children: t.children.map((c) => split(c, target, dir, newId, before)),
  };
}

// 关闭 pane：兄弟占满空出的位置；只剩一个孩子的分割节点折叠成该孩子。
export function remove(t: TreeNode | null, paneId: string): TreeNode | null {
  if (!t) return null;
  if (t.kind === "leaf") return t.paneId === paneId ? null : t;
  const kept: { node: TreeNode; ratio: number }[] = [];
  t.children.forEach((c, i) => {
    const n = remove(c, paneId);
    const r = t.ratios[i];
    if (n && r !== undefined) kept.push({ node: n, ratio: r });
  });
  if (kept.length === 0) return null;
  const only = kept[0];
  if (kept.length === 1 && only) return only.node;
  const total = kept.reduce((a, k) => a + k.ratio, 0);
  return {
    ...t,
    children: kept.map((k) => k.node),
    ratios: kept.map((k) => k.ratio / total),
  };
}

// 调整第 index 条分割线：只在相邻两块之间挪，两块都不小于 MIN_RATIO。
export function resize(
  t: TreeNode,
  path: number[],
  index: number,
  delta: number,
): TreeNode {
  if (t.kind === "leaf") return t;
  if (path.length > 0) {
    const [head, ...rest] = path;
    return {
      ...t,
      children: t.children.map((c, i) =>
        i === head ? resize(c, rest, index, delta) : c,
      ),
    };
  }
  const a = t.ratios[index];
  const b = t.ratios[index + 1];
  if (a === undefined || b === undefined) return t;
  const d = Math.max(MIN_RATIO - a, Math.min(b - MIN_RATIO, delta));
  const ratios = [...t.ratios];
  ratios[index] = a + d;
  ratios[index + 1] = b - d;
  return { ...t, ratios };
}

export function layout(t: TreeNode | null, box: Rect): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (n: TreeNode, r: Rect) => {
    if (n.kind === "leaf") {
      out.set(n.paneId, r);
      return;
    }
    let off = 0;
    n.children.forEach((c, i) => {
      const f = n.ratios[i];
      if (f === undefined) return;
      walk(
        c,
        n.dir === "h"
          ? { x: r.x + off * r.w, y: r.y, w: f * r.w, h: r.h }
          : { x: r.x, y: r.y + off * r.h, w: r.w, h: f * r.h },
      );
      off += f;
    });
  };
  if (t) walk(t, box);
  return out;
}

// 按位置找相邻 pane：从 from 的中心沿方向走，取最近且有重叠的矩形。
export function neighbor(
  rects: Map<string, Rect>,
  from: string,
  dir: "left" | "right" | "up" | "down",
): string | null {
  const r = rects.get(from);
  if (!r) return null;
  let best: { id: string; d: number } | null = null;
  for (const [id, o] of rects) {
    if (id === from) continue;
    const overlapY = o.y < r.y + r.h && o.y + o.h > r.y;
    const overlapX = o.x < r.x + r.w && o.x + o.w > r.x;
    let d: number | null = null;
    if (dir === "right" && overlapY && o.x >= r.x + r.w - 1e-9)
      d = o.x - (r.x + r.w);
    if (dir === "left" && overlapY && o.x + o.w <= r.x + 1e-9)
      d = r.x - (o.x + o.w);
    if (dir === "down" && overlapX && o.y >= r.y + r.h - 1e-9)
      d = o.y - (r.y + r.h);
    if (dir === "up" && overlapX && o.y + o.h <= r.y + 1e-9)
      d = r.y - (o.y + o.h);
    if (d !== null && (!best || d < best.d)) best = { id, d };
  }
  return best?.id ?? null;
}

export function containsPane(t: TreeNode | null, paneId: string): boolean {
  return paneIds(t).includes(paneId);
}

export interface Divider {
  // 分割节点在树里的路径，以及这条线隔开 children[index] 与 children[index + 1]。
  path: number[];
  index: number;
  dir: "h" | "v";
  // 线的位置（沿分割方向厚度为 0），坐标与 layout() 同一坐标系。
  rect: Rect;
  // 该分割节点自己的矩形，用来把像素位移换算成比例。
  parent: Rect;
  // children[index] 当前占父节点的比例。
  ratio: number;
}

export function dividers(t: TreeNode | null, box: Rect): Divider[] {
  const out: Divider[] = [];
  const walk = (n: TreeNode, r: Rect, path: number[]) => {
    if (n.kind === "leaf") return;
    let off = 0;
    n.children.forEach((c, i) => {
      const f = n.ratios[i];
      if (f === undefined) return;
      const childRect: Rect =
        n.dir === "h"
          ? { x: r.x + off * r.w, y: r.y, w: f * r.w, h: r.h }
          : { x: r.x, y: r.y + off * r.h, w: r.w, h: f * r.h };
      off += f;
      if (i < n.children.length - 1) {
        out.push({
          path,
          index: i,
          dir: n.dir,
          rect:
            n.dir === "h"
              ? { x: r.x + off * r.w, y: r.y, w: 0, h: r.h }
              : { x: r.x, y: r.y + off * r.h, w: r.w, h: 0 },
          parent: r,
          ratio: f,
        });
      }
      walk(c, childRect, [...path, i]);
    });
  };
  if (t) walk(t, box, []);
  return out;
}
