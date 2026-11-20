// 连续同类的工具调用折成一组：对话流里一组只占一行摘要（「读取了 6 个文件 · 1.2s」）。
// 纯函数；分组只看相邻关系，中间隔了别的类就另起一组。

import { fmtMs } from "./format";
import { type ToolRow, viewOf } from "./toolRows";

type Kind = "read" | "search" | "bash" | "edit" | "subagent" | "other";

const KIND: Record<string, Kind> = {
  read: "read",
  grep: "search",
  find: "search",
  ls: "search",
  bash: "bash",
  edit: "edit",
  write: "edit",
  spawn_subagent: "subagent",
};

const kindOf = (name: string): Kind => KIND[name] ?? "other";

export interface ToolGroup {
  /** 组里第一行的 id；组长出新行时不变，界面据此保住展开状态 */
  id: string;
  label: string;
  rows: ToolRow[];
  /** 耗时合计；有一行没给耗时（历史块里没有）就不给 */
  ms: number | null;
  failed: boolean;
  running: boolean;
}

export function labelOf(kind: Kind, name: string, n: number): string {
  switch (kind) {
    case "read":
      return `读取了 ${n} 个文件`;
    case "search":
      return `搜索了 ${n} 次`;
    case "bash":
      return `运行了 ${n} 条命令`;
    case "edit":
      return `编辑了 ${n} 个文件`;
    case "subagent":
      return `派发了 ${n} 个子代理`;
    default:
      return n > 1 ? `调用了 ${name} ${n} 次` : `调用了 ${name}`;
  }
}

export function groupTools(rows: readonly ToolRow[]): ToolGroup[] {
  const runs: { kind: Kind; key: string; rows: ToolRow[] }[] = [];
  for (const r of rows) {
    const kind = kindOf(r.name);
    // 「其他」按工具名分，免得把毫不相干的工具并成一句「调用了 N 次」
    const key = kind === "other" ? r.name : kind;
    const last = runs.at(-1);
    if (last && last.key === key) last.rows.push(r);
    else runs.push({ kind, key, rows: [r] });
  }
  return runs.map(({ kind, rows: rs }) => {
    const known = rs.every((r) => r.durationMs !== undefined);
    return {
      id: rs[0]?.id ?? "",
      label: labelOf(kind, rs[0]?.name ?? "", rs.length),
      rows: rs,
      ms: known ? rs.reduce((a, r) => a + (r.durationMs ?? 0), 0) : null,
      failed: rs.some((r) => r.status === "error"),
      running: rs.some((r) => r.status === "running"),
    };
  });
}

/** 收起的组头上跟着的内容预览：第一行的命令 / 路径 / 检索词，组里还有别的就补一个 +N。 */
export function previewOf(g: ToolGroup): string {
  const first = g.rows[0];
  if (!first) return "";
  const primary = viewOf(first.name, first.args).primary;
  return g.rows.length > 1 && primary
    ? `${primary}  +${g.rows.length - 1}`
    : primary;
}

export const groupMeta = (g: ToolGroup): string =>
  g.ms === null ? "" : fmtMs(g.ms);
