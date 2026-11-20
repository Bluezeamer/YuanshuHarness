// 画布视口（缩放 / 平移）的纯计算，以及撤销栈。与 React 解耦。
import { boundsOf, type Pt, type Rect } from "./geometry";

export interface View {
  zoom: number;
  pan: Pt;
}
export const ZOOM_MIN = 0.45;
export const ZOOM_MAX = 1.8;
export const HOME: View = { zoom: 1, pan: { x: 0, y: 0 } };

export const clampZoom = (z: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** 屏幕点（相对画布左上角）→ 平面坐标。 */
export const toPlane = (v: View, p: Pt): Pt => ({
  x: (p.x - v.pan.x) / v.zoom,
  y: (p.y - v.pan.y) / v.zoom,
});

/** 以屏幕点 `at` 为锚点缩放：锚点下的平面坐标不动。 */
export function zoomAt(v: View, at: Pt, factor: number): View {
  const zoom = clampZoom(v.zoom * factor);
  const plane = toPlane(v, at);
  return { zoom, pan: { x: at.x - plane.x * zoom, y: at.y - plane.y * zoom } };
}

/** 适应视图：把所有节点放进视口（不放大超过 100%），居中。 */
export function fitView(
  rects: readonly Rect[],
  size: { w: number; h: number },
  pad = 40,
): View {
  if (rects.length === 0 || size.w <= 0 || size.h <= 0) return HOME;
  const b = boundsOf(rects);
  const zoom = clampZoom(
    Math.min(1, (size.w - pad * 2) / b.w, (size.h - pad * 2) / b.h),
  );
  return {
    zoom,
    pan: {
      x: (size.w - b.w * zoom) / 2 - b.x * zoom,
      y: (size.h - b.h * zoom) / 2 - b.y * zoom,
    },
  };
}

/** 平面上的点滚进视口里（用于「在结果面点某一行，画布跳到该节点」）。 */
export function reveal(
  v: View,
  r: Rect,
  size: { w: number; h: number },
  pad = 24,
): View {
  // 还没有布局尺寸（未挂载 / 无头环境）时不动
  if (size.w <= 0 || size.h <= 0) return v;
  const x0 = r.x * v.zoom + v.pan.x;
  const y0 = r.y * v.zoom + v.pan.y;
  const x1 = x0 + r.w * v.zoom;
  const y1 = y0 + r.h * v.zoom;
  let dx = 0;
  let dy = 0;
  if (x0 < pad) dx = pad - x0;
  else if (x1 > size.w - pad) dx = size.w - pad - x1;
  if (y0 < pad) dy = pad - y0;
  else if (y1 > size.h - pad) dy = size.h - pad - y1;
  return dx || dy
    ? { zoom: v.zoom, pan: { x: v.pan.x + dx, y: v.pan.y + dy } }
    : v;
}

export const HISTORY_LIMIT = 30;

/**
 * 撤销栈：记录「操作前」的快照。新操作清掉重做栈；上限 30，超出丢最旧的。
 * `undo(current)` 返回要恢复成的快照（并把 current 压入重做栈）；没有可撤销的返回 undefined。
 */
export function createHistory<T>(limit = HISTORY_LIMIT) {
  let past: T[] = [];
  let future: T[] = [];
  return {
    push(before: T) {
      past.push(before);
      if (past.length > limit) past.shift();
      future = [];
    },
    undo(current: T): T | undefined {
      const prev = past.pop();
      if (prev === undefined) return undefined;
      future.push(current);
      return prev;
    },
    redo(current: T): T | undefined {
      const next = future.pop();
      if (next === undefined) return undefined;
      past.push(current);
      return next;
    },
    get undoSize() {
      return past.length;
    },
    get redoSize() {
      return future.length;
    },
    clear() {
      past = [];
      future = [];
    },
  };
}
export type History<T> = ReturnType<typeof createHistory<T>>;
