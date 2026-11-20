// 右侧状态里的子代理树（纯函数）：执行体清单 → 树；结束够久的在「现状」视图里折起来。
// 折叠规则：自己结束满 FOLD_MIN 分钟才算过期；没看过的失败不折（点一下算看过）；
// 一个节点只有自己和所有后代都过期才折，还有后代要显示时祖先留着（变淡）；点开「已结束 N 个」的子树原样列全，不二次折叠。

import type { ExecutionBody } from "../../../api/flows";

/** 结束多久之后，在「现状」视图里自动折叠（分钟）；先写死，不做设置 */
export const FOLD_MIN = 10;

export type SubStatus = "live" | "idle" | "ok" | "error" | "stopped";

export interface SubNode {
  id: string;
  exec: ExecutionBody;
  status: SubStatus;
  /** 落终态的时间（毫秒）；没结束为 null */
  endedAt: number | null;
  kids: SubNode[];
}

export function statusOf(x: ExecutionBody): SubStatus {
  if (x.state === "run") return "live";
  if (x.state === "idle") return "idle";
  if (x.outcome === "failed") return "error";
  if (x.outcome === "interrupted") return "stopped";
  return "ok";
}

export const isEnded = (s: SubStatus): boolean =>
  s === "ok" || s === "error" || s === "stopped";

/**
 * 以 rootId 为根（主代理）的整棵树，返回它的直接子代理。只收模型自己派发的（source 为 task）：
 * 团队成员与工作流 agent 各有自己的块，它们名下再派的子代理也跟着不进树（找不到父节点就丢掉）。
 */
export function buildForest(
  allExecutions: readonly ExecutionBody[],
  rootId: string,
): SubNode[] {
  const executions = allExecutions.filter((x) => x.source === "task");
  const nodes = new Map<string, SubNode>(
    executions.map((x) => {
      const status = statusOf(x);
      const t = x.ended ? Date.parse(x.ended) : Number.NaN;
      return [
        x.id,
        {
          id: x.id,
          exec: x,
          status,
          endedAt: isEnded(status) && Number.isFinite(t) ? t : null,
          kids: [],
        },
      ];
    }),
  );
  const top: SubNode[] = [];
  for (const x of executions) {
    const n = nodes.get(x.id);
    if (!n) continue;
    if (x.parentId === rootId) top.push(n);
    else nodes.get(x.parentId)?.kids.push(n);
  }
  return top;
}

const flat = (n: SubNode): SubNode[] => [n, ...n.kids.flatMap(flat)];

/** 一棵子树里的节点总数（含自己） */
export const countOf = (n: SubNode): number => flat(n).length;

export const anyLive = (nodes: readonly SubNode[]): boolean =>
  nodes.some((n) => flat(n).some((x) => x.status === "live"));

/** 自己过期：结束满 FOLD_MIN 分钟，且不是没看过的失败。拿不到结束时间的一律不折 */
const expired = (n: SubNode, seen: ReadonlySet<string>, now: number) =>
  n.endedAt !== null &&
  !(n.status === "error" && !seen.has(n.id)) &&
  now - n.endedAt >= FOLD_MIN * 60_000;

/** 能折叠：自己和所有后代都过期 */
export const foldable = (
  n: SubNode,
  seen: ReadonlySet<string>,
  now: number,
): boolean =>
  expired(n, seen, now) && n.kids.every((k) => foldable(k, seen, now));

export interface Split {
  shown: SubNode[];
  folded: SubNode[];
  /** 折起来的节点总数（含后代） */
  count: number;
  /** 折起来的里面最近结束的 3 个 */
  latest: SubNode[];
}

/** 一个父节点的子节点：「现状」视图把能折叠的收起来，其余视图原样列出 */
export function splitKids(
  kids: readonly SubNode[],
  fold: boolean,
  seen: ReadonlySet<string>,
  now: number,
): Split {
  const folded = fold ? kids.filter((k) => foldable(k, seen, now)) : [];
  const shown = fold ? kids.filter((k) => !foldable(k, seen, now)) : [...kids];
  return {
    shown,
    folded,
    count: folded.reduce((a, k) => a + countOf(k), 0),
    latest: folded
      .flatMap(flat)
      .filter((x) => x.endedAt !== null)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 3),
  };
}

/** 「3 分钟前」「2 小时前」 */
export function agoText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "刚刚";
  return min < 60 ? `${min} 分钟前` : `${Math.floor(min / 60)} 小时前`;
}
