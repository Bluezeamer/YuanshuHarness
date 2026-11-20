// 对话流用到的纯格式化与解析：时间、引用块还原、工具参数摘要。

/** 附件体积，与文件管理器的 sizeText 同口径。 */
export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// 服务端会往消息原文里注入附件标记行；字符串队列里可能还残留，展示前剥掉。
const ATTACH_LINE = /^\s*\[attach_file\]\s/;

export const stripAttachLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !ATTACH_LINE.test(line))
    .join("\n")
    .trim();

export function fmtClock(at: Date | string | number | undefined): string {
  const d = at === undefined ? new Date() : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 预览取开头/最新 n 行：运行中看尾部，结束后看开头。 */
export function headLines(text: string, n: number): string {
  return text.split("\n").slice(0, n).join("\n");
}

export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

export const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

export interface QuoteView {
  label: string;
  text: string;
}

// 与 model/draft.ts 的 withQuotes 互逆：发送时每条引用拼成「Quote 标签 + 围栏块」，空行后接问题。
const QUOTE_HEAD = /^Quote ([^\n]+)\n(`{3,})\n([\s\S]*?)\n\2(?:\n\n|$)/;

export function splitQuotes(text: string): {
  quotes: QuoteView[];
  body: string;
} {
  const quotes: QuoteView[] = [];
  let rest = text;
  for (;;) {
    const m = QUOTE_HEAD.exec(rest);
    if (!m) break;
    quotes.push({ label: m[1] ?? "", text: m[3] ?? "" });
    rest = rest.slice(m[0].length);
  }
  return { quotes, body: quotes.length ? rest : text };
}

/**
 * 从「正在流式生成、可能还不完整」的工具参数 JSON 里提取已经到达的字符串字段。
 * 只用于展示预览；解析失败/残缺都尽量给出已收到的内容。
 */
export function parsePartialArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /"([A-Za-z0-9_.-]+)"\s*:\s*"/g;
  for (;;) {
    const m = re.exec(raw);
    if (!m) break;
    const key = m[1];
    let i = re.lastIndex;
    let text = "";
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === undefined) break;
        text += ch + next;
        i += 2;
        continue;
      }
      if (ch === '"') break;
      text += ch;
      i += 1;
    }
    let value: string;
    try {
      value = JSON.parse(`"${text}"`) as string;
    } catch {
      value = text
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"');
    }
    if (key !== undefined) out[key] = value;
    if (i >= raw.length) break;
    re.lastIndex = i + 1;
  }
  return out;
}

// 工具参数在历史里是 JSON 串，实时帧里是对象。
export function parseArgs(args: unknown): Record<string, unknown> | null {
  let v = args;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const SUMMARY_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
  "task",
  "description",
  "name",
];

// 一行参数摘要：优先取常见主字段，否则第一个字符串值，实在没有就是原文。
export function argSummary(args: unknown, max = 120): string {
  const o = parseArgs(args);
  let s = "";
  if (o) {
    const key =
      SUMMARY_KEYS.find((k) => typeof o[k] === "string" && o[k] !== "") ??
      Object.keys(o).find((k) => typeof o[k] === "string" && o[k] !== "");
    s = key ? String(o[key]) : "";
  } else if (typeof args === "string") s = args;
  s = firstLine(s);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const lines = (v: unknown): number =>
  typeof v === "string" && v !== "" ? v.split("\n").length : 0;

// 写入类工具的增删行：write 只有新增；edit 取旧文与新文的行数。认不出来返回 null。
export function lineDelta(args: unknown): { add: number; del: number } | null {
  const o = parseArgs(args);
  if (!o) return null;
  const add = lines(o.content) || lines(o.newText) || lines(o.new_string);
  const del = lines(o.oldText) || lines(o.old_string);
  return add || del ? { add, del } : null;
}

export const fmtMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
