// 浏览器画面的缩放与平移：纯函数，不碰 DOM。画面固定 1280×800，view 是「画面左上角在容器里的位置 + 每个画面像素对应几个 CSS 像素」，
// 画面按 translate(x, y) scale(s) 摆放（transform-origin 在左上角）。

export const PAGE_W = 1280;
export const PAGE_H = 800;
/** 放大上限：每个画面像素 2 个 CSS 像素 */
export const MAX_SCALE = 2;

export interface Box {
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}
export interface View {
  scale: number;
  x: number;
  y: number;
}

/** 适应宽度时的比例；也是缩小的下限（再小只是多出空白） */
export const fitScale = (box: Box): number => box.w / PAGE_W;

// 画面比容器小的方向居中，比容器大的方向不许露出空白
const clampAxis = (pos: number, content: number, box: number): number =>
  content <= box
    ? (box - content) / 2
    : Math.min(0, Math.max(box - content, pos));

export function clampView(v: View, box: Box): View {
  const scale = Math.min(MAX_SCALE, Math.max(fitScale(box), v.scale));
  return {
    scale,
    x: clampAxis(v.x, PAGE_W * scale, box.w),
    y: clampAxis(v.y, PAGE_H * scale, box.h),
  };
}

/** 适应宽度：宽度铺满，顶端对齐 */
export const fitView = (box: Box): View =>
  clampView({ scale: fitScale(box), x: 0, y: 0 }, box);

/** 单指平移：从按下时的 view 加上手指走过的位移 */
export const panView = (start: View, dx: number, dy: number, box: Box): View =>
  clampView({ ...start, x: start.x + dx, y: start.y + dy }, box);

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** 双指缩放：按两指间距的比例缩放，开始时两指中点下的那个画面点跟着两指中点走 */
export function pinchView(
  start: View,
  from: [Pt, Pt],
  to: [Pt, Pt],
  box: Box,
): View {
  const d0 = dist(...from);
  if (d0 < 1) return start;
  const scale = Math.min(
    MAX_SCALE,
    Math.max(fitScale(box), start.scale * (dist(...to) / d0)),
  );
  const c0 = mid(...from);
  const c1 = mid(...to);
  // c0 下面的画面点
  const qx = (c0.x - start.x) / start.scale;
  const qy = (c0.y - start.y) / start.scale;
  return clampView({ scale, x: c1.x - qx * scale, y: c1.y - qy * scale }, box);
}

/** 放大到某个比例，以容器中心为不动点（「100%」按钮） */
export function zoomTo(v: View, scale: number, box: Box): View {
  const cx = box.w / 2;
  const cy = box.h / 2;
  const qx = (cx - v.x) / v.scale;
  const qy = (cy - v.y) / v.scale;
  const s = Math.min(MAX_SCALE, Math.max(fitScale(box), scale));
  return clampView({ scale: s, x: cx - qx * s, y: cy - qy * s }, box);
}
