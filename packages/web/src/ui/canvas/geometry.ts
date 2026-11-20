// 画布机制层：几何与命中判定。与 React、与具体业务节点解耦。
//
// 约定：调用方提供 `sizeOf(node)`，机制层不认识任何节点种类。
// 坐标系是"平面坐标"（未缩放平移），DOM 上的缩放/平移由调用方套一层 transform —— 这样
// 命中判定可以纯计算，不依赖 DOM 测量（jsdom 里 getBoundingClientRect 全 0，靠它测不了）。

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 机制层只要求节点有 id 与左上角坐标 */
export interface NodeLike {
  id: string;
  x: number;
  y: number;
}

export interface EdgeLike {
  from: string;
  to: string;
}

export type Size = { w: number; h: number };
export type SizeOf<T extends NodeLike> = (n: T) => Size;

export const nodeRect = <T extends NodeLike>(
  n: T,
  sizeOf: SizeOf<T>,
): Rect => ({ x: n.x, y: n.y, ...sizeOf(n) });

/** 端口在上下边中点：in 在上边，out 在下边 */
export const portOf = <T extends NodeLike>(
  n: T,
  side: "in" | "out",
  sizeOf: SizeOf<T>,
): Pt => {
  const { w, h } = sizeOf(n);
  return { x: n.x + w / 2, y: side === "in" ? n.y : n.y + h };
};

export const rectBetween = (a: Pt, b: Pt): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
});

export const touches = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap &&
  a.x + a.w + gap > b.x &&
  a.y < b.y + b.h + gap &&
  a.y + a.h + gap > b.y;

export const edgeKey = (e: EdgeLike): string => `${e.from}>${e.to}`;

/** 一组框的包围盒（空集返回零尺寸） */
export function boundsOf(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 四次三次贝塞尔的控制点：纵向拉开，横向跟随端点 */
const controlPoints = (p: Pt, q: Pt) => {
  const dy = Math.max(26, Math.abs(q.y - p.y) * 0.42);
  return { c1: { x: p.x, y: p.y + dy }, c2: { x: q.x, y: q.y - dy } };
};

const bezierAt = (p: Pt, c1: Pt, c2: Pt, q: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x:
      u * u * u * p.x +
      3 * u * u * t * c1.x +
      3 * u * t * t * c2.x +
      t * t * t * q.x,
    y:
      u * u * u * p.y +
      3 * u * u * t * c1.y +
      3 * u * t * t * c2.y +
      t * t * t * q.y,
  };
};

/** 连线的采样点（与 edgePath 同一条曲线），供命中测试用 */
export function sampleEdge<T extends NodeLike>(
  a: T,
  b: T,
  sizeOf: SizeOf<T>,
  steps = 16,
): Pt[] {
  const p = portOf(a, "out", sizeOf);
  const q = portOf(b, "in", sizeOf);
  const { c1, c2 } = controlPoints(p, q);
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) out.push(bezierAt(p, c1, c2, q, i / steps));
  return out;
}

/**
 * 与框相交的节点。`exclude` 用来排除不可框选的节点（例如输出节点：只能点选）。
 */
export function nodesInRect<T extends NodeLike>(
  nodes: readonly T[],
  r: Rect,
  sizeOf: SizeOf<T>,
  exclude?: (n: T) => boolean,
): string[] {
  return nodes
    .filter((n) => !exclude?.(n) && touches(nodeRect(n, sizeOf), r))
    .map((n) => n.id);
}

/** 与框相交的连线：采样点落在框内，或相邻两点包围盒与框相交 */
export function edgesInRect<T extends NodeLike>(
  nodes: readonly T[],
  edges: readonly EdgeLike[],
  r: Rect,
  sizeOf: SizeOf<T>,
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges
    .filter((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return false;
      const pts = sampleEdge(a, b, sizeOf);
      return pts.some((p, i) => {
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)
          return true;
        const q = pts[i - 1];
        return (
          q !== undefined &&
          touches(
            {
              x: Math.min(p.x, q.x),
              y: Math.min(p.y, q.y),
              w: Math.abs(p.x - q.x),
              h: Math.abs(p.y - q.y),
            },
            r,
          )
        );
      });
    })
    .map(edgeKey);
}

/** 落点所在的节点（后画的在上层），可向外扩 pad。按平面坐标判定，不依赖 DOM 命中。 */
export function hitNode<T extends NodeLike>(
  nodes: readonly T[],
  p: Pt,
  sizeOf: SizeOf<T>,
  pad = 0,
): T | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i] as T;
    const r = nodeRect(n, sizeOf);
    if (
      p.x >= r.x - pad &&
      p.x <= r.x + r.w + pad &&
      p.y >= r.y - pad &&
      p.y <= r.y + r.h + pad
    )
      return n;
  }
  return null;
}

// ---- 对齐吸附 ----

export const SNAP = 6;

export interface Snap {
  dx: number;
  dy: number;
  /** 参考线（平面坐标）：x 是竖线、y 是横线 */
  guides: { x?: number; y?: number }[];
}

/** 被拖动的框与其他框的边/中线相差不超过 th 就吸过去，每轴取最近的一条 */
export function snapBox(box: Rect, others: readonly Rect[], th = SNAP): Snap {
  const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  let bestX: { d: number; line: number } | null = null;
  let bestY: { d: number; line: number } | null = null;
  for (const o of others) {
    for (const bx of xs(box))
      for (const ox of xs(o)) {
        const d = ox - bx;
        if (Math.abs(d) <= th && (!bestX || Math.abs(d) < Math.abs(bestX.d)))
          bestX = { d, line: ox };
      }
    for (const by of ys(box))
      for (const oy of ys(o)) {
        const d = oy - by;
        if (Math.abs(d) <= th && (!bestY || Math.abs(d) < Math.abs(bestY.d)))
          bestY = { d, line: oy };
      }
  }
  const guides: { x?: number; y?: number }[] = [];
  if (bestX) guides.push({ x: bestX.line });
  if (bestY) guides.push({ y: bestY.line });
  return { dx: bestX?.d ?? 0, dy: bestY?.d ?? 0, guides };
}
