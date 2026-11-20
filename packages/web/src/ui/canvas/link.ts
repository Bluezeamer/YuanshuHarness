// 画布机制层：连线合法性。与业务节点解耦，靠调用方给"端点规则"。
//
// 机制层负责两条通用不变量：
//   1. 不成环
//   2. 单链：每个节点入度 ≤ 1、出度 ≤ 1（与 server parseGraph 的校验一致）
// 业务侧（哪种节点能做起点/终点）由 `rules` 提供。

import type { EdgeLike, NodeLike } from "./geometry.js";
import { edgeKey } from "./geometry.js";

/** 常见的拒绝原因；业务侧可以扩展自己的原因码 */
export type GenericReject = "self" | "duplicate" | "cycle" | "fanOut" | "fanIn";

export interface LinkRules<T extends NodeLike> {
  /** 不能作为起点（例如输出节点） */
  cannotSource?: (n: T) => boolean;
  /** 不能作为终点（例如注入节点） */
  cannotTarget?: (n: T) => boolean;
  /** 业务自定义的拒绝原因；返回非空则拒绝 */
  custom?: (from: T, to: T) => string | null;
}

export type LinkResult =
  | { ok: true }
  | { ok: false; reason: GenericReject | string };

/** to 能否沿着现有连线走回 from（成环检测） */
export function reaches(
  edges: readonly EdgeLike[],
  from: string,
  to: string,
): boolean {
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}

/** 加一条 from → to 是否合法 */
export function canLink<T extends NodeLike>(
  nodes: readonly T[],
  edges: readonly EdgeLike[],
  from: string,
  to: string,
  rules: LinkRules<T> = {},
): LinkResult {
  if (from === to) return { ok: false, reason: "self" };
  const a = nodes.find((n) => n.id === from);
  const b = nodes.find((n) => n.id === to);
  if (!a || !b) return { ok: false, reason: "self" };
  if (rules.cannotSource?.(a)) return { ok: false, reason: "source" };
  if (rules.cannotTarget?.(b)) return { ok: false, reason: "target" };
  if (edges.some((e) => e.from === from && e.to === to))
    return { ok: false, reason: "duplicate" };
  // 环是更根本的错误，先报它更有指导性
  if (reaches(edges, to, from)) return { ok: false, reason: "cycle" };
  // 单链：两端都不能已经有连线
  if (edges.some((e) => e.from === from))
    return { ok: false, reason: "fanOut" };
  if (edges.some((e) => e.to === to)) return { ok: false, reason: "fanIn" };
  const custom = rules.custom?.(a, b);
  if (custom) return { ok: false, reason: custom };
  return { ok: true };
}

/** 选中集合是否允许整体删除（机制层不拦，业务侧需要时自己判断） */
export const edgeKeys = (edges: readonly EdgeLike[]): string[] =>
  edges.map(edgeKey);
