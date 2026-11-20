import { expect, test } from "vitest";
import {
  clampWidth,
  MAIN_MIN,
  mustFloat,
  RAIL_W,
  readPrefs,
  TREE_DEFAULT,
  TREE_MAX,
  TREE_MIN,
  writePrefs,
} from "./treePrefs";

const KEY = "ys.canvas.tree";

test("偏好：没有存过用默认（固定、240）；存了读回来；宽度夹在 160 到 480", () => {
  expect(readPrefs()).toEqual({ mode: "fixed", width: TREE_DEFAULT });
  writePrefs({ mode: "float", width: 300 });
  expect(readPrefs()).toEqual({ mode: "float", width: 300 });
  expect(clampWidth(50)).toBe(TREE_MIN);
  expect(clampWidth(9999)).toBe(TREE_MAX);
  expect(clampWidth(255.6)).toBe(256);
  localStorage.setItem(KEY, JSON.stringify({ width: 9999 }));
  expect(readPrefs().width).toBe(TREE_MAX);
});

test("偏好：存坏了、字段类型不对、取值不认识，都退回默认，不抛错", () => {
  for (const raw of ["{oops", "null", '"x"', "[]"]) {
    localStorage.setItem(KEY, raw);
    expect(readPrefs()).toEqual({ mode: "fixed", width: TREE_DEFAULT });
  }
  localStorage.setItem(KEY, JSON.stringify({ mode: "weird", width: "wide" }));
  expect(readPrefs()).toEqual({ mode: "fixed", width: TREE_DEFAULT });
});

test("mustFloat：标签宽度放不下窄栏加树栏加最小主区就强制悬浮；量不到宽度（0）时不强制", () => {
  const need = RAIL_W + 240 + MAIN_MIN;
  expect(mustFloat(need, 240)).toBe(false);
  expect(mustFloat(need - 1, 240)).toBe(true);
  expect(mustFloat(RAIL_W + 480 + MAIN_MIN - 1, 480)).toBe(true);
  expect(mustFloat(RAIL_W + 480 + MAIN_MIN, 480)).toBe(false);
  expect(mustFloat(0, 240)).toBe(false);
});
