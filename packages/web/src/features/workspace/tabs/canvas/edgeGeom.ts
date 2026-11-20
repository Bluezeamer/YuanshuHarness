// 画布上连线的几何：箭头与感应宽度按「屏幕像素」给，换算成画布单位（除以缩放）后画，所以缩放时它们大小不变。
import { Position } from "@xyflow/react";

/** 箭头长（屏幕像素） */
export const ARROW_PX = 10;
/** 连线的点击感应宽度（屏幕像素） */
export const EDGE_HIT_PX = 12;
/** 缩小到这个倍数以下，卡片上方的名字就不显示了（太小也看不清，还互相叠） */
export const LOW_ZOOM = 0.3;

/**
 * 箭头三角形的三个点（SVG points）：尖在 (x, y)，朝向由目标连接点所在的边定——
 * 线是垂直于那条边进来的，所以箭头指向「进入卡片」的方向。len 是画布单位下的长度。
 */
export function arrowPoints(
  x: number,
  y: number,
  to: Position,
  len: number,
): string {
  // 进入方向：连接点在左边 → 线从左往右进来，依此类推
  const [dx, dy] =
    to === Position.Left
      ? [1, 0]
      : to === Position.Right
        ? [-1, 0]
        : to === Position.Top
          ? [0, 1]
          : [0, -1];
  const half = len * 0.45;
  const bx = x - dx * len;
  const by = y - dy * len;
  const px = -dy * half;
  const py = dx * half;
  const f = (n: number) => Math.round(n * 100) / 100;
  return `${f(x)},${f(y)} ${f(bx + px)},${f(by + py)} ${f(bx - px)},${f(by - py)}`;
}
