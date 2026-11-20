// 控制台缓冲 → 给模型看的文字（折叠组、单条截断、总量预算）与落文件的全文。
// 纯函数：不碰工具与引擎，便于单独推定格式（设计稿 §1.11）。
import type { ConsoleEntry } from "../engine/types.js";

/** 给模型看的单条文字上限。 */
const ENTRY_MAX = 500;
/** text 的总长度上限（含头行）。 */
const TOTAL_MAX = 6000;

export interface ConsoleView {
  /** 给模型看的文字（含头行与每组一行；不含文件标记行） */
  text: string;
  /** 有省略（单条截断、超预算丢组、缓冲挤掉过）：调用方要把全文落成附件 */
  elided: boolean;
  /** 全文：每组一行，不截断、不省略，含 ×n 与首末时间；给附件用 */
  full: string;
}

type Level = "warn" | "error";

/** 一条是否落在 level 门槛之上（失败请求与页面异常入缓冲时的级别就是 error）。 */
function above(entry: ConsoleEntry, level: Level): boolean {
  return level === "warn"
    ? entry.level === "warn" || entry.level === "error"
    : entry.level === "error";
}

/** 组标签：失败请求单独标出，其余按级别。 */
function label(entry: ConsoleEntry): string {
  return entry.kind === "request-failed" ? "request failed" : entry.level;
}

/** 换行折成一个空格：一条消息一行。 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

/** 把毫秒差写成 12s / 3m / 2h / 1d；负数按 0。 */
function ago(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  if (sec < 60) return `${Math.floor(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.floor(min)}m`;
  const hour = min / 60;
  if (hour < 24) return `${Math.floor(hour)}h`;
  return `${Math.floor(hour / 24)}d`;
}

/** 本地时间的 HH:MM:SS。 */
export function clock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 字数统计用：文字截到上限，超出标出被截掉的字符数。 */
function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= ENTRY_MAX) return { text, truncated: false };
  return {
    text: `${text.slice(0, ENTRY_MAX)}…(+${text.length - ENTRY_MAX} chars)`,
    truncated: true,
  };
}

/** 给模型看的一组：`[log] ×3 文字 (url) · last 2s ago`。 */
function viewLine(
  entry: ConsoleEntry,
  now: number,
): {
  line: string;
  truncated: boolean;
} {
  const { text, truncated } = clip(oneLine(entry.text));
  const count = entry.count > 1 ? `×${entry.count} ` : "";
  const where = entry.url === undefined ? "" : ` (${entry.url})`;
  const when = `${entry.count > 1 ? "last " : ""}${ago(now - entry.ts)} ago`;
  return {
    line: `[${label(entry)}] ${count}${text}${where} · ${when}`,
    truncated,
  };
}

/** 落文件的一组：`[error] ×61 文字 (url) · first 12:00:00 · last 12:00:05`。 */
function fullLine(entry: ConsoleEntry): string {
  const when =
    entry.count === 1
      ? `at ${clock(entry.ts)}`
      : `first ${clock(entry.firstTs)} · last ${clock(entry.ts)}`;
  const where = entry.url === undefined ? "" : ` (${entry.url})`;
  return `[${label(entry)}] ×${entry.count} ${oneLine(entry.text)}${where} · ${when}`;
}

/** 头行：N 是次数之和、M 是组数、K 是挤出次数；level 只在给模型看的那份里写。 */
function header(
  entries: readonly ConsoleEntry[],
  evicted: number,
  level?: Level,
): string {
  const total = entries.reduce((n, e) => n + e.count, 0);
  const tail = level === undefined ? "" : ` · level >= ${level}`;
  return `CONSOLE: ${total} entries · ${entries.length} distinct · ${evicted} evicted${tail}`;
}

export function renderConsole(
  entries: readonly ConsoleEntry[],
  opts: { evicted: number; level?: Level; now: number },
): ConsoleView {
  const shown =
    opts.level === undefined
      ? [...entries]
      : entries.filter((e) => above(e, opts.level as Level));
  const head = header(shown, opts.evicted, opts.level);

  let truncated = false;
  const lines: string[] = [];
  for (const entry of shown) {
    const one = viewLine(entry, opts.now);
    if (one.truncated) truncated = true;
    lines.push(one.line);
  }
  if (shown.length === 0) lines.push("(no console messages)");

  // 超预算时从最早的组开始整组丢；声明里写被丢的组数。
  let drop = 0;
  let text = [head, ...lines].join("\n");
  while (text.length > TOTAL_MAX && drop < lines.length) {
    drop += 1;
    const kept = lines.slice(drop);
    text = [head, `… ${drop} earlier entries omitted`, ...kept].join("\n");
  }

  const full = [header(entries, opts.evicted)];
  if (opts.evicted > 0)
    full.push(
      `(${opts.evicted} earlier occurrences were evicted from the buffer and are not in this file)`,
    );
  full.push(...entries.map(fullLine));

  return {
    text,
    elided: truncated || drop > 0 || opts.evicted > 0,
    full: full.join("\n"),
  };
}
