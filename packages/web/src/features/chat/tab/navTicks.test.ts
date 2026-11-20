import { expect, test } from "vitest";
import { tickLook } from "./navTicks";

const look = (
  index: number,
  hover: number | null,
  active = false,
  open = true,
) => tickLook({ index, hover, active, open });

test("没展开 / 没有鼠标所在：都是短线，当前位置略长，文字不淡", () => {
  expect(look(3, null)).toEqual({ width: 12, fade: 1 });
  expect(look(3, null, true)).toEqual({ width: 16, fade: 1 });
  expect(look(3, 3, false, false)).toEqual({ width: 12, fade: 1 });
});

test("鼠标所在那条最长，向两侧按正态分布衰减、左右对称", () => {
  expect(look(5, 5).width).toBe(28);
  const w = [0, 1, 2, 3, 4].map((d) => look(5 + d, 5).width);
  for (let i = 1; i < w.length; i++) expect(w[i]).toBeLessThan(w[i - 1] ?? 0);
  expect(look(4, 5).width).toBeCloseTo(look(6, 5).width, 6);
  expect(look(5 + 20, 5).width).toBeGreaterThanOrEqual(12);
});

test("远处文字逐级变淡但不低于 0.45；当前位置不淡", () => {
  expect(look(5, 5).fade).toBe(1);
  expect(look(6, 5).fade).toBeLessThan(1);
  expect(look(5 + 40, 5).fade).toBe(0.45);
  expect(look(9, 5, true).fade).toBe(1);
});
