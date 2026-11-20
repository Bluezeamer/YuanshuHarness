import { expect, test } from "vitest";
import { mixOklch, oklchToHex, parseOklch } from "./oklch";

test("解析 oklch 字面量", () => {
  expect(parseOklch("oklch(0.975 0.003 265)")).toEqual({
    l: 0.975,
    c: 0.003,
    h: 265,
  });
  expect(parseOklch("  oklch(100% 0% 0)  ")).toEqual({ l: 1, c: 0, h: 0 });
  expect(parseOklch("rgb(1 2 3)")).toBeNull();
  expect(parseOklch("oklch(1 2)")).toBeNull();
});

test("oklch → hex：黑白端点与越界裁剪", () => {
  expect(oklchToHex({ l: 0, c: 0, h: 0 })).toBe("#000000");
  expect(oklchToHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
  // 超出 sRGB 的彩度按通道裁剪，不抛错、不产出非法 hex
  expect(oklchToHex({ l: 0.6, c: 0.4, h: 20 })).toMatch(/^#[0-9a-f]{6}$/);
});

test("同空间混色：比例端点与中间值", () => {
  const black = { l: 0, c: 0, h: 0 };
  const white = { l: 1, c: 0, h: 0 };
  expect(mixOklch(black, white, 0).l).toBeCloseTo(0);
  expect(mixOklch(black, white, 1).l).toBeCloseTo(1);
  expect(mixOklch(black, white, 0.5).l).toBeCloseTo(0.5);
});
