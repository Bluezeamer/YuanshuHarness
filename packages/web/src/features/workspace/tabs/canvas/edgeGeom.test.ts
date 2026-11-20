import { Position } from "@xyflow/react";
import { expect, test } from "vitest";
import { arrowPoints } from "./edgeGeom";

test("箭头：尖在目标点，底边在进入方向的反侧；连接点在左边 → 指向右，依此类推", () => {
  // len 10，半宽 4.5
  expect(arrowPoints(100, 50, Position.Left, 10)).toBe(
    "100,50 90,54.5 90,45.5",
  );
  expect(arrowPoints(100, 50, Position.Right, 10)).toBe(
    "100,50 110,45.5 110,54.5",
  );
  expect(arrowPoints(100, 50, Position.Top, 10)).toBe(
    "100,50 95.5,40 104.5,40",
  );
  expect(arrowPoints(100, 50, Position.Bottom, 10)).toBe(
    "100,50 104.5,60 95.5,60",
  );
});

test("箭头大小按长度走（画布单位 = 屏幕像素 / 缩放）：缩放 0.5 时长度 20，放大 4 倍时长度 2.5", () => {
  const tip = (s: string) => s.split(" ")[0];
  const base = (s: string) => Number(s.split(" ")[1]?.split(",")[0]);
  expect(tip(arrowPoints(0, 0, Position.Left, 10 / 0.5))).toBe("0,0");
  expect(base(arrowPoints(0, 0, Position.Left, 10 / 0.5))).toBe(-20);
  expect(base(arrowPoints(0, 0, Position.Left, 10 / 4))).toBe(-2.5);
});
