// 拖动与缩放卡片时的吸附：先贴齐其他卡片的边与中线（阈值按屏幕像素，不随缩放变），贴上了出一条参考线；
// 没贴上卡片的那个方向落到 8 单位网格上，所以是「卡片优先，其次网格」。
// 一起拖的多张卡片当成一个整体（外框）来吸，彼此的相对位置不变；缩放只吸被拖动的那条边。纯函数，不碰 xyflow。

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 参考线：axis x = 竖线（x 坐标 at，从 from 到 to 的 y 范围）；axis y = 横线 */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/** 离多近就吸（屏幕像素） */
export const SNAP_PX = 6;
/** 两条线差这么多（画布单位）以内算同一条，参考线才把对应的卡片连起来 */
const SAME = 0.5;

const xs = (r: Rect): number[] => [r.x, r.x + r.w / 2, r.x + r.w];
const ys = (r: Rect): number[] => [r.y, r.y + r.h / 2, r.y + r.h];

/** 一个方向上最近的对齐：box 的哪条线贴到别的卡片的哪条线要移动多少（没有够近的返回 null） */
function nearest(
  lines: readonly number[],
  targets: readonly number[],
  limit: number,
): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const t of targets)
    for (const l of lines) {
      const d = t - l;
      if (Math.abs(d) <= limit && (!best || Math.abs(d) < Math.abs(best.delta)))
        best = { delta: d, at: t };
    }
  return best;
}

/** 贴上了 at 这条线：线的范围由被吸的矩形与同样在这条线上的其他卡片一起决定 */
function guideAt(
  axis: "x" | "y",
  at: number,
  moved: Rect,
  others: readonly Rect[],
): Guide {
  const lines = axis === "x" ? xs : ys;
  const all = [
    moved,
    ...others.filter((r) => lines(r).some((v) => Math.abs(v - at) < SAME)),
  ];
  return axis === "x"
    ? {
        axis,
        at,
        from: Math.min(...all.map((r) => r.y)),
        to: Math.max(...all.map((r) => r.y + r.h)),
      }
    : {
        axis,
        at,
        from: Math.min(...all.map((r) => r.x)),
        to: Math.max(...all.map((r) => r.x + r.w)),
      };
}

export function unionRect(rs: readonly Rect[]): Rect {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * box 是被拖的外框（当前位置，已被网格吸过）；others 是其余卡片。
 * 返回要再挪的 dx、dy（没有够近的卡片线就是 0），以及贴上之后的参考线。
 */
export function snapToCards(
  box: Rect,
  others: readonly Rect[],
  zoom: number,
): { dx: number; dy: number; guides: Guide[] } {
  const limit = SNAP_PX / zoom;
  const sx = nearest(xs(box), others.flatMap(xs), limit);
  const sy = nearest(ys(box), others.flatMap(ys), limit);
  const dx = sx?.delta ?? 0;
  const dy = sy?.delta ?? 0;
  const moved = { ...box, x: box.x + dx, y: box.y + dy };
  const guides: Guide[] = [];
  if (sx) guides.push(guideAt("x", sx.at, moved, others));
  if (sy) guides.push(guideAt("y", sy.at, moved, others));
  return { dx, dy, guides };
}

/** 网格步长（画布单位）：没贴上其他卡片的方向，位置落到最近的网格点 */
export const GRID_STEP = 8;

/**
 * 卡片优先、其次网格：先看贴不贴得上别的卡片（出参考线）；贴不上的那个方向落到网格上。
 * box 是被拖外框此刻的原始位置（没吸过网格）。返回要加到每张被拖卡片位置上的偏移。
 */
export function snapBox(
  box: Rect,
  others: readonly Rect[],
  zoom: number,
  grid = GRID_STEP,
): { dx: number; dy: number; guides: Guide[] } {
  const card = snapToCards(box, others, zoom);
  const onGrid = (v: number) => Math.round(v / grid) * grid - v;
  const hasX = card.guides.some((g) => g.axis === "x");
  const hasY = card.guides.some((g) => g.axis === "y");
  return {
    dx: hasX ? card.dx : onGrid(box.x),
    dy: hasY ? card.dy : onGrid(box.y),
    guides: card.guides,
  };
}

// ── 缩放 ──

/** 一个方向上的两条边（x 方向是左、右，y 方向是上、下） */
interface Span {
  lo: number;
  hi: number;
}

type Edge = "lo" | "hi" | "both" | "none";

const EPS = 1e-6;

/** 缩放时这个方向上动了哪条边；两条都动（比例锁定时对侧跟着动）或都没动是 both / none */
function movedEdge(start: Span, next: Span): Edge {
  const lo = Math.abs(next.lo - start.lo) > EPS;
  const hi = Math.abs(next.hi - start.hi) > EPS;
  return lo && hi ? "both" : lo ? "lo" : hi ? "hi" : "none";
}

/** 把一个方向的大小改成 size：动了 lo 就让 hi 不动，动了 hi 就让 lo 不动，两条都动以中心为准，都没动 lo 不动 */
function resizedSpan(next: Span, edge: Edge, size: number): Span {
  const lo =
    edge === "lo"
      ? next.hi - size
      : edge === "both"
        ? (next.lo + next.hi) / 2 - size / 2
        : next.lo;
  return { lo, hi: lo + size };
}

/**
 * 缩放时的吸附：start 是这次缩放开始时的矩形，next 是库按指针算出的新矩形。动了的那条边先贴齐其他卡片的边与中线
 * （贴上出参考线），贴不上落到网格；另一条边不动。吸完比 minW / minH 还小就不吸。
 * keepAspect（图片、视频只能等比例缩放）：只在贴得上卡片时吸，吸完另一个方向按比例跟，不吸网格。
 */
export function snapResize(
  start: Rect,
  next: Rect,
  others: readonly Rect[],
  zoom: number,
  opts: { minW: number; minH: number; keepAspect: boolean; grid?: number },
): { rect: Rect; guides: Guide[] } {
  const grid = opts.grid ?? GRID_STEP;
  const limit = SNAP_PX / zoom;
  const nx: Span = { lo: next.x, hi: next.x + next.w };
  const ny: Span = { lo: next.y, hi: next.y + next.h };
  const ex = movedEdge({ lo: start.x, hi: start.x + start.w }, nx);
  const ey = movedEdge({ lo: start.y, hi: start.y + start.h }, ny);
  const targets = { x: others.flatMap(xs), y: others.flatMap(ys) };
  const axes = [
    { axis: "x" as const, span: nx, edge: ex, min: opts.minW },
    { axis: "y" as const, span: ny, edge: ey, min: opts.minH },
  ];

  if (!opts.keepAspect) {
    const out = { x: nx, y: ny };
    const at: { x?: number; y?: number } = {};
    for (const { axis, span, edge, min } of axes) {
      if (edge !== "lo" && edge !== "hi") continue;
      const v = span[edge];
      const hit = nearest([v], targets[axis], limit);
      const snapped = hit ? hit.at : Math.round(v / grid) * grid;
      const moved = { ...span, [edge]: snapped };
      if (moved.hi - moved.lo < min) continue;
      out[axis] = moved;
      if (hit) at[axis] = hit.at;
    }
    const rect = {
      x: out.x.lo,
      y: out.y.lo,
      w: out.x.hi - out.x.lo,
      h: out.y.hi - out.y.lo,
    };
    const guides: Guide[] = [];
    if (at.x !== undefined) guides.push(guideAt("x", at.x, rect, others));
    if (at.y !== undefined) guides.push(guideAt("y", at.y, rect, others));
    return { rect, guides };
  }

  // 比例锁定：动了的边里贴得上卡片的取最近的一条，吸完另一个方向按比例跟
  const ratio = next.w / next.h;
  let best: { axis: "x" | "y"; at: number; size: number; d: number } | null =
    null;
  for (const { axis, span, edge } of axes) {
    if (edge !== "lo" && edge !== "hi") continue;
    const hit = nearest([span[edge]], targets[axis], limit);
    if (!hit || (best && Math.abs(hit.delta) >= best.d)) continue;
    const size = edge === "lo" ? span.hi - hit.at : hit.at - span.lo;
    best = { axis, at: hit.at, size, d: Math.abs(hit.delta) };
  }
  if (!best) return { rect: next, guides: [] };
  const w = best.axis === "x" ? best.size : best.size * ratio;
  const h = best.axis === "y" ? best.size : best.size / ratio;
  if (w < opts.minW || h < opts.minH) return { rect: next, guides: [] };
  const px = resizedSpan(nx, ex, w);
  const py = resizedSpan(ny, ey, h);
  const rect = { x: px.lo, y: py.lo, w, h };
  return { rect, guides: [guideAt(best.axis, best.at, rect, others)] };
}
