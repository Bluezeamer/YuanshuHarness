// 窗格上的落点：顶部一条标签条高 = strip（并成标签页），距边 24% 内 = 四向拆分，其余 center（并入窗格）。
// 数值与 tiling.css 里叠层的几何一致（.u-dz），改这里要同步改那里。

import type { EdgeZone } from "./tree";

export type DropZone = EdgeZone | "center" | "strip";

export const DROP_ZONES: readonly DropZone[] = [
  "left",
  "right",
  "top",
  "bottom",
  "center",
  "strip",
];

export const isEdge = (z: DropZone): z is EdgeZone =>
  z === "left" || z === "right" || z === "top" || z === "bottom";

/** 窗格头（标签条）的高度，也是 strip 落点的高度 */
export const STRIP_HEIGHT = 36;
/** 四边拆分的宽度占窗格的比例 */
export const EDGE_RATIO = 0.24;

/** 指针在盒子内的位置（相对盒子左上角） */
export interface PointInBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 落点区域：指针离哪条边最近且在 edge 比例以内就是该边，否则 center。
 * 角上并列时按 left > right > top > bottom 取。
 */
export function edgeZone(p: PointInBox, edge: number): EdgeZone | "center" {
  const x = p.x / Math.max(1, p.width);
  const y = p.y / Math.max(1, p.height);
  const d = Math.min(x, 1 - x, y, 1 - y);
  if (d > edge) return "center";
  if (d === x) return "left";
  if (d === 1 - x) return "right";
  if (d === y) return "top";
  return "bottom";
}

/** 窗格落点：strip 优先于四边 */
export const dropZoneAt = (p: PointInBox): DropZone =>
  p.y < STRIP_HEIGHT ? "strip" : edgeZone(p, EDGE_RATIO);
