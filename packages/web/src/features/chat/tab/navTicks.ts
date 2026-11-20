// 左缘导航里每条横线的长度与文字的淡度（纯函数）。
// 平时都短，当前位置略长；展开后以鼠标所在那条为峰，长度按正态分布向两侧衰减，远处的文字逐级变淡。

const BASE = 12;
const ACTIVE = 16;
const PEAK = 28;
const SIGMA = 1.2;
const FLOOR = 0.45;

export interface TickLook {
  /** 线长（px） */
  width: number;
  /** 文字不透明度 */
  fade: number;
}

export function tickLook({
  index,
  hover,
  active,
  open,
}: {
  index: number;
  /** 鼠标所在那条；null = 没有 */
  hover: number | null;
  active: boolean;
  open: boolean;
}): TickLook {
  if (!open || hover === null)
    return { width: active ? ACTIVE : BASE, fade: 1 };
  const d = index - hover;
  return {
    width: BASE + (PEAK - BASE) * Math.exp(-(d * d) / (2 * SIGMA * SIGMA)),
    fade: active ? 1 : Math.max(FLOOR, 1 - 0.14 * Math.abs(d)),
  };
}
