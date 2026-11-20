import { expect, test } from "vitest";
import {
  clampView,
  fitScale,
  fitView,
  MAX_SCALE,
  PAGE_H,
  PAGE_W,
  panView,
  pinchView,
  zoomTo,
} from "./viewTransform";

const box = { w: 390, h: 600 };

test("适应宽度：宽度铺满、顶端对齐；高度不够容器时在竖直方向居中", () => {
  const v = fitView(box);
  expect(v.scale).toBeCloseTo(390 / PAGE_W);
  expect(v.x).toBe(0);
  // 画面高 800 × 0.3047 ≈ 244 < 600：居中
  expect(v.y).toBeCloseTo((600 - PAGE_H * v.scale) / 2);
});

test("缩放比例夹在 [适应宽度, MAX_SCALE]", () => {
  expect(clampView({ scale: 0.01, x: 0, y: 0 }, box).scale).toBeCloseTo(
    fitScale(box),
  );
  expect(clampView({ scale: 9, x: 0, y: 0 }, box).scale).toBe(MAX_SCALE);
});

test("放大后平移不会露出空白：四边都贴着容器", () => {
  const big = { scale: 1, x: 0, y: 0 };
  // 往右拖：左边不能露出空白
  expect(panView(big, 500, 0, box).x).toBe(0);
  // 往左拖过头：右边贴齐
  expect(panView(big, -9999, 0, box).x).toBe(box.w - PAGE_W);
  // 竖直同理（画面 800 > 容器 600）
  expect(panView(big, 0, 9999, box).y).toBe(0);
  expect(panView(big, 0, -9999, box).y).toBe(box.h - PAGE_H);
});

test("双指张开：比例按间距之比放大，起始中点下的画面点跟着中点走", () => {
  const start = { scale: 0.5, x: 0, y: 0 };
  const from: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: 100, y: 200 },
    { x: 200, y: 200 },
  ];
  const to: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: 50, y: 200 },
    { x: 250, y: 200 },
  ];
  const v = pinchView(start, from, to, box);
  expect(v.scale).toBeCloseTo(1);
  // 起始中点 (150, 200) 下的画面点是 (300, 400)；结束中点还是 (150, 200)
  expect(v.x + 300 * v.scale).toBeCloseTo(150);
  expect(v.y + 400 * v.scale).toBeCloseTo(200);
});

test("双指捏合缩不到适应宽度以下；两指重合（间距≈0）不动", () => {
  const start = { scale: 1, x: 0, y: 0 };
  const v = pinchView(
    start,
    [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ],
    [
      { x: 150, y: 0 },
      { x: 151, y: 0 },
    ],
    box,
  );
  expect(v.scale).toBeCloseTo(fitScale(box));
  expect(
    pinchView(
      start,
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      box,
    ),
  ).toBe(start);
});

test("放大到 100%：以容器中心为不动点", () => {
  const fit = fitView(box);
  const v = zoomTo(fit, 1, box);
  expect(v.scale).toBe(1);
  // 容器中心下原来的画面点现在仍在中心（竖直方向画面被夹到贴边时除外，这里只看水平）
  const qx = (box.w / 2 - fit.x) / fit.scale;
  expect(v.x + qx * v.scale).toBeCloseTo(box.w / 2);
});
