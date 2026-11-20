// 笔记 / 卡片「添加到对话」要带给 agent 的东西：内容，加上来源标签 `主机名:绝对路径:Lx-Ly`（与对话里的划选引用同一写法）。
import { fileLabel } from "../../../chat";
import { markdownOfSelection } from "../../../markdown/copySource";
import { joinPath } from "../files/paths";

export interface LineRange {
  from: number;
  to: number;
}

/** 笔记或卡片文件（路径相对 `.canvas/`）的来源标签；没有行号区间就只写路径 */
export function canvasFileLabel(
  hostName: string,
  dir: string,
  path: string,
  lines: LineRange | null,
): string {
  const abs = joinPath(joinPath(dir, ".canvas"), path);
  return lines
    ? fileLabel(hostName, abs, lines.from, lines.to)
    : `${hostName}:${abs}`;
}

/** 整个文件的行号区间（末尾的换行不算一行） */
export const wholeLines = (source: string): LineRange => ({
  from: 1,
  to: source.replace(/\n$/, "").split("\n").length,
});

/** text 在 source 里第一次出现的行号区间（从 1 起）；找不到是 null */
export function linesOf(source: string, text: string): LineRange | null {
  const t = text.trim();
  const at = t === "" ? -1 : source.indexOf(t);
  if (at < 0) return null;
  const lineAt = (i: number) => source.slice(0, i).split("\n").length;
  return { from: lineAt(at), to: lineAt(at + t.length - 1) };
}

/** 渲染出来的笔记里选中的内容：能还原成 Markdown 原文的给原文，否则给选中的文字；没有选区是 null */
export function previewSelection(
  root: Element,
  source: string,
): { text: string; lines: LineRange | null } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text =
    markdownOfSelection(root, range, source) ?? sel.toString().trim();
  return text === "" ? null : { text, lines: linesOf(source, text) };
}
