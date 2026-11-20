// 画布机制层：几何、命中、连线不变量。不含任何业务节点语义，用最朴素的节点验证。
import { expect, test } from "vitest";
import {
  boundsOf,
  edgeKey,
  edgesInRect,
  hitNode,
  type NodeLike,
  nodeRect,
  nodesInRect,
  overlaps,
  portOf,
  rectBetween,
  type SizeOf,
  sampleEdge,
  snapBox,
} from "./geometry";
import { canLink, reaches } from "./link";

/** 所有节点同尺寸，机制层不认识种类 */
const SIZE = { w: 100, h: 50 };
const sizeOf: SizeOf<NodeLike> = () => SIZE;
const at = (id: string, x: number, y: number): NodeLike => ({ id, x, y });
const edge = (from: string, to: string) => ({ from, to });

test("端口在上下边中点", () => {
  const n = at("a", 10, 20);
  expect(portOf(n, "in", sizeOf)).toEqual({ x: 60, y: 20 });
  expect(portOf(n, "out", sizeOf)).toEqual({ x: 60, y: 70 });
});

test("矩形、包围盒、框选命中都按平面坐标算，不依赖 DOM", () => {
  expect(
    overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
  ).toBe(true);
  expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 5, y: 5, w: 4, h: 4 })).toBe(
    false,
  );
  const a = at("a", 0, 0);
  const b = at("b", 300, 0);
  expect(nodeRect(a, sizeOf)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  expect(boundsOf([nodeRect(a, sizeOf), nodeRect(b, sizeOf)])).toEqual({
    x: 0,
    y: 0,
    w: 400,
    h: 50,
  });
  const r = rectBetween({ x: -10, y: -10 }, { x: 120, y: 60 });
  expect(nodesInRect([a, b], r, sizeOf)).toEqual(["a"]);
  // 排除规则：例如"输出节点不可框选"
  expect(
    nodesInRect(
      [a, b],
      rectBetween({ x: 0, y: 0 }, { x: 400, y: 60 }),
      sizeOf,
      (n) => n.id === "a",
    ),
  ).toEqual(["b"]);
});

test("命中：后画的在上层，可外扩 pad", () => {
  const a = at("a", 0, 0);
  const top = at("top", 0, 0);
  expect(hitNode([a, top], { x: 5, y: 5 }, sizeOf)?.id).toBe("top");
  expect(hitNode([a], { x: -6, y: 0 }, sizeOf)).toBeNull();
  expect(hitNode([a], { x: -6, y: 0 }, sizeOf, 8)?.id).toBe("a");
});

test("连线命中：采样点落在框内即算相交", () => {
  const a = at("a", 0, 0);
  const b = at("b", 0, 200);
  const mid = sampleEdge(a, b, sizeOf)
    .slice(4, 12)
    .map((p) => ({ x: p.x, y: p.y }));
  const box = {
    x: Math.min(...mid.map((p) => p.x)) - 2,
    y: Math.min(...mid.map((p) => p.y)) - 2,
    w: 4,
    h: 4,
  };
  expect(edgesInRect([a, b], [edge("a", "b")], box, sizeOf)).toEqual(["a>b"]);
  expect(edgeKey(edge("a", "b"))).toBe("a>b");
});

test("吸附：靠近别节点的中线时对齐，并给出参考线", () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };
  const other = { x: 103, y: 40, w: 100, h: 50 };
  const s = snapBox(box, [other], 6);
  expect(s.dx).toBe(3);
  expect(s.guides.some((g) => g.x !== undefined)).toBe(true);
});

test("连线不变量：自连 / 重复 / 成环 / 分叉 / 汇合 都被拒", () => {
  const nodes = [at("a", 0, 0), at("b", 0, 100), at("c", 0, 200)];
  expect(canLink(nodes, [], "a", "a")).toEqual({ ok: false, reason: "self" });
  expect(canLink(nodes, [edge("a", "b")], "a", "b")).toEqual({
    ok: false,
    reason: "duplicate",
  });
  expect(canLink(nodes, [edge("a", "b"), edge("b", "c")], "c", "a")).toEqual({
    ok: false,
    reason: "cycle",
  });
  expect(canLink(nodes, [edge("a", "b")], "a", "c")).toEqual({
    ok: false,
    reason: "fanOut",
  });
  expect(canLink(nodes, [edge("a", "b")], "c", "b")).toEqual({
    ok: false,
    reason: "fanIn",
  });
  expect(canLink(nodes, [], "a", "b")).toEqual({ ok: true });
});

test("连线不变量可被业务规则覆盖：端点角色 + 自定义原因", () => {
  const nodes = [at("out", 0, 0), at("a", 0, 100), at("m", 0, 200)];
  const rules = {
    cannotSource: (n: NodeLike) => n.id === "out",
    cannotTarget: (n: NodeLike) => n.id === "m",
  };
  expect(canLink(nodes, [], "out", "a", rules)).toEqual({
    ok: false,
    reason: "source",
  });
  expect(canLink(nodes, [], "a", "m", rules)).toEqual({
    ok: false,
    reason: "target",
  });
  expect(
    canLink(nodes, [], "a", "m", {
      custom: (from, to) => (from.id === "a" && to.id === "m" ? "nope" : null),
    }),
  ).toEqual({ ok: false, reason: "nope" });
});

test("reaches：沿双向无关，只看 from 能否到达 to", () => {
  const edges = [edge("a", "b"), edge("b", "c")];
  expect(reaches(edges, "a", "c")).toBe(true);
  expect(reaches(edges, "c", "a")).toBe(false);
});
