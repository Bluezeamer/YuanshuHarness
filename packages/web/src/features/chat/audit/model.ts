// 审计页的纯逻辑：筛选 / 搜索 / 分组 / 汇总 / 组成条 / 分页合并。与 React 解耦。
// 数据一律来自 api/calls.ts 的 CallSummary；这里不假设 request 的形状（见 payload.ts）。

import type { CallSummary, CallsPage, CallTokens } from "../../../api/calls";

// ── 筛选 ──

export type AuditFilter = "all" | "user" | "tool" | "call" | "sub";

export interface FilterDef {
  id: AuditFilter;
  label: string;
  test(c: CallSummary): boolean;
}

// 五档互斥展示，但「工具调用」按响应里是否发起了工具，与触发类型无关，所以计数之和可大于总数。
export const FILTERS: readonly FilterDef[] = [
  { id: "all", label: "全部", test: () => true },
  { id: "user", label: "用户", test: (c) => c.trigger === "user" },
  { id: "tool", label: "工具返回", test: (c) => c.trigger === "tool_result" },
  { id: "call", label: "工具调用", test: (c) => c.calledTools.length > 0 },
  { id: "sub", label: "子代理", test: (c) => c.trigger === "subagent" },
];

/** afx 里存的是任意字符串，落到合法档位，其余回退「全部」。 */
export const filterOf = (v: string | undefined): AuditFilter =>
  FILTERS.find((f) => f.id === v)?.id ?? "all";

export function countByFilter(
  calls: readonly CallSummary[],
): Record<AuditFilter, number> {
  const n = { all: 0, user: 0, tool: 0, call: 0, sub: 0 };
  for (const f of FILTERS) n[f.id] = calls.filter(f.test).length;
  return n;
}

// ── 搜索 ──

// 列表阶段只看摘要字段：只有点开过的调用才有正文，按正文匹配会让结果取决于看过哪几条。
export function matchesQuery(c: CallSummary, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [c.summary, c.toolName ?? "", ...c.calledTools].some((s) =>
    s.toLowerCase().includes(needle),
  );
}

export function selectCalls(
  calls: readonly CallSummary[],
  filter: AuditFilter,
  q: string,
): CallSummary[] {
  const test = FILTERS.find((f) => f.id === filter)?.test ?? (() => true);
  return calls.filter((c) => test(c) && matchesQuery(c, q));
}

// ── 分组与汇总 ──

export interface TurnGroup {
  turn: number | null;
  /** 子代理调用才有：这一组来自哪个子会话（轮次是它自己的） */
  source?: NonNullable<CallSummary["subagent"]>;
  calls: CallSummary[];
}

/** 输入倒序，相邻同来源（本会话 / 同一子会话）同轮次并成一组；组间、组内都保持输入顺序。 */
export function groupByTurn(calls: readonly CallSummary[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const c of calls) {
    const last = groups.at(-1);
    if (
      last &&
      last.turn === c.turn &&
      last.source?.sessionId === c.subagent?.sessionId
    )
      last.calls.push(c);
    else
      groups.push({
        turn: c.turn,
        ...(c.subagent ? { source: c.subagent } : {}),
        calls: [c],
      });
  }
  return groups;
}

/** 整次请求的输入量：四段之和（含缓存读写），与服务端 usage 口径一致。 */
export const inputOf = (t: CallTokens): number =>
  t.system + t.tools + t.history + t.current;

export interface Totals {
  count: number;
  input: number;
  output: number;
}

export function summarize(calls: readonly CallSummary[]): Totals {
  return {
    count: calls.length,
    input: calls.reduce((n, c) => n + inputOf(c.tokens), 0),
    output: calls.reduce((n, c) => n + c.tokens.out, 0),
  };
}

// ── 组成条 ──

export type SegmentId = "system" | "tools" | "history" | "current";

export interface Segment {
  id: SegmentId;
  label: string;
  tokens: number;
  /** 宽度百分比，两位小数；total > 0 时四段之和恰为 100 */
  pct: number;
}

const SEGMENTS: ReadonlyArray<{
  id: SegmentId;
  label: string;
  pick(t: CallTokens): number;
}> = [
  { id: "system", label: "系统", pick: (t) => t.system },
  { id: "tools", label: "工具定义", pick: (t) => t.tools },
  { id: "history", label: "历史", pick: (t) => t.history },
  { id: "current", label: "本轮", pick: (t) => t.current },
];

// 最大余数法按百分之一分配，避免四个 toFixed(2) 加起来 99.99 / 100.01。
export function composition(t: CallTokens): Segment[] {
  const vals = SEGMENTS.map((s) => s.pick(t));
  const total = vals.reduce((a, b) => a + b, 0);
  const units = vals.map((v) => (total > 0 ? (v * 10000) / total : 0));
  const floors = units.map(Math.floor);
  let rest = total > 0 ? 10000 - floors.reduce((a, b) => a + b, 0) : 0;
  const order = units
    .map((u, i) => [u - Math.floor(u), i] as const)
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    rest -= 1;
  }
  return SEGMENTS.map((s, i) => ({
    id: s.id,
    label: s.label,
    tokens: vals[i] ?? 0,
    pct: (floors[i] ?? 0) / 100,
  }));
}

// ── 分页合并 ──

/**
 * 刷新第一页后并入已载入的列表。页与已载入部分接得上（页内最小 seq ≤ 已载入最大 seq + 1）就合并去重，
 * 更早的游标沿用；两次刷新之间新增超过一页时接不上，直接以新页为准，避免列表里出现缺口。
 */
export function mergeFirstPage(prev: CallsPage, page: CallsPage): CallsPage {
  const newest = prev.calls[0]?.seq;
  const pageMin = page.calls.at(-1)?.seq;
  if (newest === undefined) return page;
  if (pageMin !== undefined && page.nextBefore !== null && pageMin > newest + 1)
    return page;
  const byId = new Map<string, CallSummary>();
  for (const c of [...prev.calls, ...page.calls]) byId.set(c.id, c);
  return {
    calls: [...byId.values()].sort((a, b) => b.seq - a.seq),
    nextBefore: page.nextBefore === null ? null : prev.nextBefore,
  };
}

// ── 分栏宽度 ──

export const SPLIT = { def: 248, min: 216, reserved: 320 } as const;
/** 窄于此宽度（按审计面板容器宽度）序列叠到详情上方 */
export const NARROW_BELOW = 620;

/** 详情至少留 SPLIT.reserved；容器宽度未知（0）时不设上限。 */
export const splitMax = (boxW: number): number =>
  boxW > 0 ? Math.max(SPLIT.min, boxW - SPLIT.reserved) : 4096;

export const clampSplit = (w: number, boxW: number): number =>
  Math.round(Math.min(Math.max(w, SPLIT.min), splitMax(boxW)));

// ── 展示格式 ──

export const pad2 = (n: number): string => String(n).padStart(2, "0");

export const fmtInt = (n: number): string => n.toLocaleString("en-US");

export const fmtK = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);

export const fmtSec = (ms: number, digits = 1): string =>
  `${(ms / 1000).toFixed(digits)}s`;

/** 本地时间 `MM-DD HH:MM:SS`；解析不了的原样返回。 */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 行尾第一段：做了什么。子代理优先，其次是发起的工具，否则是纯文本回复。 */
export function actionOf(c: CallSummary): string {
  if (c.trigger === "subagent") return "子代理";
  const [first, ...more] = c.calledTools;
  if (first === undefined) return "文本";
  return more.length ? `${first} +${more.length}` : first;
}

export const TRIGGER_LABEL: Record<CallSummary["trigger"], string> = {
  user: "用户输入",
  tool_result: "工具返回",
  subagent: "子代理请求",
};
