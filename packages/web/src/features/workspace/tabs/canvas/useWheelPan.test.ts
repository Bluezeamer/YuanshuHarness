import { expect, test } from "vitest";
import { looksLikeTrackpad } from "./useWheelPan";

test("触控板：横向有位移或像素步长很小；物理滚轮：一格上百、整数、没有横向", () => {
  expect(looksLikeTrackpad({ deltaX: 0, deltaY: 4, deltaMode: 0 })).toBe(true);
  expect(looksLikeTrackpad({ deltaX: 3, deltaY: 120, deltaMode: 0 })).toBe(
    true,
  );
  expect(looksLikeTrackpad({ deltaX: 0, deltaY: 100, deltaMode: 0 })).toBe(
    false,
  );
  expect(looksLikeTrackpad({ deltaX: 0, deltaY: -120, deltaMode: 0 })).toBe(
    false,
  );
  // 按「行」计的滚轮（Firefox）不管步长多小都是滚轮
  expect(looksLikeTrackpad({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(false);
});
