import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { QrCode, qrModules, qrPath } from "./QrCode";

afterEach(cleanup);

test("矩阵是方的，三个定位角在左上、右上、左下（7×7 的外框是深色），右下没有", () => {
  const m = qrModules("http://192.168.1.20:7431/m/?pair=ABCD2345");
  const n = m.length;
  expect(n).toBeGreaterThanOrEqual(21);
  expect(m.every((r) => r.length === n)).toBe(true);
  for (const [r0, c0] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ] as const) {
    for (let i = 0; i < 7; i++) {
      expect(m[r0]?.[c0 + i]).toBe(true);
      expect(m[r0 + 6]?.[c0 + i]).toBe(true);
      expect(m[r0 + i]?.[c0]).toBe(true);
      expect(m[r0 + i]?.[c0 + 6]).toBe(true);
    }
  }
  // 定位角中心的 3×3 也是深色，外框与它之间那一圈是浅色
  expect(m[3]?.[3]).toBe(true);
  expect(m[1]?.[1]).toBe(false);
});

test("路径：每个深色格一段，坐标加上 4 格静区；渲染出带名字的 SVG，颜色走令牌", () => {
  const path = qrPath([
    [true, false],
    [false, true],
  ]);
  expect(path).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");

  const { container } = render(<QrCode text="x" label="配对二维码" />);
  const svg = screen.getByRole("img", { name: "配对二维码" });
  const side = qrModules("x").length + 8;
  expect(svg.getAttribute("viewBox")).toBe(`0 0 ${side} ${side}`);
  expect(container.querySelector("rect")?.getAttribute("fill")).toBe(
    "var(--surface)",
  );
  expect(container.querySelector("path")?.getAttribute("fill")).toBe(
    "var(--ink)",
  );
});

test("不同内容生成不同的码", () => {
  expect(qrPath(qrModules("a"))).not.toBe(qrPath(qrModules("b")));
});
