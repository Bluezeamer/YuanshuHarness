import { describe, expect, it } from "vitest";
import { dropZoneAt, edgeZone, STRIP_HEIGHT } from "./zones";

const at = (x: number, y: number, width = 1000, height = 700) => ({
  x,
  y,
  width,
  height,
});

describe("edgeZone", () => {
  it("四条边与中心", () => {
    expect(edgeZone(at(990, 350), 0.22)).toBe("right");
    expect(edgeZone(at(10, 350), 0.22)).toBe("left");
    expect(edgeZone(at(500, 20), 0.22)).toBe("top");
    expect(edgeZone(at(500, 690), 0.22)).toBe("bottom");
    expect(edgeZone(at(500, 350), 0.22)).toBe("center");
  });

  it("阈值边界：恰好等于阈值算贴边", () => {
    expect(edgeZone(at(220, 350), 0.22)).toBe("left");
    expect(edgeZone(at(221, 350), 0.22)).toBe("center");
  });

  it("四个角上左右优先于上下", () => {
    expect(edgeZone(at(0, 0), 0.22)).toBe("left");
    expect(edgeZone(at(0, 700), 0.22)).toBe("left");
    expect(edgeZone(at(1000, 0), 0.22)).toBe("right");
    expect(edgeZone(at(1000, 700), 0.22)).toBe("right");
  });

  it("盒子尺寸为 0 时不抛、不出 NaN", () => {
    expect(() => edgeZone(at(0, 0, 0, 0), 0.22)).not.toThrow();
  });
});

describe("dropZoneAt", () => {
  it("顶部标签条高度内是 strip，其余按四边与中心", () => {
    expect(dropZoneAt(at(500, STRIP_HEIGHT - 1))).toBe("strip");
    expect(dropZoneAt(at(5, 5))).toBe("strip");
    expect(dropZoneAt(at(20, 350))).toBe("left");
    expect(dropZoneAt(at(980, 350))).toBe("right");
    expect(dropZoneAt(at(500, 690))).toBe("bottom");
    expect(dropZoneAt(at(500, 350))).toBe("center");
  });
});
