// 工具调用一行的数据形状与「怎么读」：服务端块 / 实时帧 → ToolRow，参数 → 一行摘要，输出 → 回显。
// 纯函数，对话流与执行体视图共用；分组见 toolGroups.ts。

import type { Block } from "../../../api";
import type { Tool } from "../model/conversation";
import {
  argSummary,
  fmtMs,
  lineDelta,
  parseArgs,
  parsePartialArgs,
} from "./format";

export interface ToolRow {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
  args?: unknown;
  output?: string;
  durationMs?: number;
  /** 嵌套调用（如 call_tool 转发的），渲染在父调用内部而不是并列 */
  children?: ToolRow[];
}

type ToolBlock = Extract<Block, { type: "tool" }>;

export const rowOfBlock = (b: ToolBlock): ToolRow => ({
  id: b.id,
  name: b.name,
  status: b.result === undefined ? "running" : b.isError ? "error" : "ok",
  args: b.args,
  ...(b.result !== undefined
    ? { output: b.result }
    : b.live
      ? { output: b.live }
      : {}),
  // 历史里已经带下来的嵌套调用（服务端挂在父块上）
  ...(b.children?.length
    ? {
        children: b.children.map((c) => ({
          id: c.id,
          name: c.name,
          status: (c.isError
            ? "error"
            : c.result === undefined
              ? "running"
              : "ok") as ToolRow["status"],
          ...(c.args === undefined ? {} : { args: c.args }),
          ...(c.result === undefined ? {} : { output: c.result }),
          ...(c.durationMs === undefined ? {} : { durationMs: c.durationMs }),
        })),
      }
    : {}),
});

export const rowOfTool = (t: Tool): ToolRow => ({ ...t });

const textOf = (v: unknown): string => (typeof v === "string" ? v : "");

const objOf = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

// 文件类工具的位置：host 参数与路径合起来读（没写 host 就是当前目录，只显示路径）。
const placeOf = (host: unknown, path: unknown): string =>
  [textOf(host), textOf(path)].filter(Boolean).join(" · ");

const oneLine = (s: string): string =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

/** 文本里最后一个非空行。 */
export const lastLine = (s: string): string =>
  s
    .split("\n")
    .filter((l) => l.trim() !== "")
    .at(-1)
    ?.trim() ?? "";

function editText(a: Record<string, unknown>): {
  oldText: string;
  newText: string;
} {
  const edits = Array.isArray(a.edits) ? a.edits : [];
  if (edits.length > 0)
    return {
      oldText: edits.map((e) => textOf(objOf(e)?.oldText)).join("\n"),
      newText: edits.map((e) => textOf(objOf(e)?.newText)).join("\n"),
    };
  return { oldText: textOf(a.oldText), newText: textOf(a.newText) };
}

export interface ToolView {
  kind: "bash" | "code" | "diff" | "plain";
  /** 行上的那段摘要：路径、命令、检索词 */
  primary: string;
  /** write 的内容 / edit 的 diff */
  body?: string;
}

// 按工具类型决定「调用方法」怎么显示：write/edit 是代码块，bash 是命令，其余是参数摘要。
export function viewOf(name: string, args: unknown): ToolView {
  const a = parseArgs(args) ?? parsePartialArgs(textOf(args));
  const path = placeOf(a.host, a.path);
  if (name === "write")
    return { kind: "code", primary: path, body: textOf(a.content) };
  if (name === "edit") {
    const { oldText, newText } = editText(a);
    const diff = [
      ...oldText.split("\n").map((l) => `- ${l}`),
      ...newText.split("\n").map((l) => `+ ${l}`),
    ].join("\n");
    return { kind: "diff", primary: path, body: diff };
  }
  if (name === "bash")
    return {
      kind: "bash",
      primary: [textOf(a.host), oneLine(textOf(a.command))]
        .filter(Boolean)
        .join(" · "),
    };
  if (name === "read") return { kind: "plain", primary: path };
  if (name === "ls") return { kind: "plain", primary: path };
  if (name === "grep" || name === "find")
    return {
      kind: "plain",
      primary: [textOf(a.pattern), path].filter(Boolean).join(" in "),
    };
  if (name === "transfer_files")
    return {
      kind: "plain",
      primary: `${placeOf(a.from_host, a.from)} → ${placeOf(a.to_host, a.to)}`,
    };
  return { kind: "plain", primary: argSummary(args) };
}

export interface ToolResult {
  kind: "code" | "diff" | "result" | "error";
  text: string;
}

// 点开一行看到的东西：write/edit 是写入的代码 / diff，其它工具是输出。参数的原文去审计页看。
export function resultOf(t: ToolRow): ToolResult | null {
  const view = viewOf(t.name, t.args);
  if (view.kind === "code" || view.kind === "diff")
    return view.body ? { kind: view.kind, text: view.body } : null;
  if (!t.output) return null;
  return { kind: t.status === "error" ? "error" : "result", text: t.output };
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  sql: "sql",
  toml: "toml",
  xml: "xml",
  svg: "xml",
};

// write 按文件后缀高亮，edit 显示 diff
export function langOf(name: string, path: string): string {
  if (name === "edit") return "diff";
  const dot = path.lastIndexOf(".");
  return dot >= 0
    ? (EXT_LANG[path.slice(dot + 1).toLowerCase()] ?? "text")
    : "text";
}

const linesOf = (s: string): number => (s === "" ? 0 : s.split("\n").length);

/** 行右侧的辅助信息：edit 的增删行单独给（界面按字色着色），其余是一小段文字（行数 / 耗时）。 */
export function rowMeta(t: ToolRow): {
  delta: { add: number; del: number } | null;
  text: string;
} {
  if (t.name === "write") {
    const n = linesOf(textOf(objOf(parseArgs(t.args))?.content));
    return { delta: null, text: n > 1 ? `${n} 行` : "" };
  }
  const ms = t.durationMs === undefined ? "" : fmtMs(t.durationMs);
  if (t.name === "edit") return { delta: lineDelta(t.args), text: ms };
  if (t.name === "read" && t.output !== undefined && t.status !== "running")
    return { delta: null, text: `${linesOf(t.output)} 行` };
  return { delta: null, text: ms };
}

// 工具参数还在流式生成时，行预览要看哪个字段：write 看正文，edit 看新文，bash 看命令。
const PARTIAL_KEYS: Record<string, string[]> = {
  write: ["content", "path"],
  edit: ["newText", "path"],
  bash: ["command"],
};
const ANY_KEYS = [
  "command",
  "content",
  "path",
  "pattern",
  "query",
  "url",
  "task",
  "description",
  "name",
];

/** 还没生成完的参数 JSON 里，要看的那个字段目前生成的全部内容。 */
export function partialText(name: string, args: string): string {
  const a = parsePartialArgs(args);
  for (const k of PARTIAL_KEYS[name] ?? ANY_KEYS) {
    const text = a[k] ?? "";
    if (lastLine(text)) return text;
  }
  return "";
}

/** 还没生成完的参数 JSON 里，最新到达的一行（给运行态的一行预览）。 */
export const partialLine = (name: string, args: string): string =>
  lastLine(partialText(name, args));
