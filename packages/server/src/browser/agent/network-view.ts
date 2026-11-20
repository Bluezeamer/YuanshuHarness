// 网络请求缓冲 → 给模型看的列表与单条详情。纯函数：不碰工具与引擎，渲染规则固定，方便单独推定格式。
// 外壳是固定的英文，页面内容（地址、头的值、正文）保持原文。
import type { NetworkDetail, NetworkEntry } from "../engine/types.js";
import type { BodyPresentation } from "./body.js";
import { clock } from "./console-view.js";

/** 地址的显示上限。 */
const URL_MAX = 300;
/** 头部值的显示上限。 */
const VALUE_MAX = 300;
/** 条目部分的总长度上限：超过就把最新的整行留给模型，全文落附件。 */
const TOTAL_MAX = 6000;

export interface NetworkFilters {
  type?: string;
  url?: string;
  failed?: boolean;
  after?: number;
}

export interface NetworkQuery {
  title: string;
  url: string;
  /** 缓冲里现有的条数、其中最大的 id（没有是 0）、累计被挤出的条数：都不受过滤影响，由调用方取 */
  total: number;
  lastId: number;
  evicted: number;
  filters: NetworkFilters;
}

export interface NetworkView {
  text: string;
  elided: boolean;
  full: string;
}

/** 超过上限就截断并标出剩下的字符数。 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

/** 字节数：不到 1 KB 写 B，否则一位小数的 KB / MB。 */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 失败的状态写法：有 failure 就是 FAILED，没响应的就是 pending，否则是数字。 */
function statusText(entry: NetworkEntry): string {
  if (entry.failure !== null) return `FAILED ${entry.failure}`;
  if (entry.status === null) return "pending";
  return String(entry.status);
}

/** 过滤：几个条件都要满足。 */
export function filterNetwork(
  entries: readonly NetworkEntry[],
  filters: NetworkFilters,
): NetworkEntry[] {
  const type = filters.type?.toLowerCase();
  const url = filters.url?.toLowerCase();
  return entries.filter((e) => {
    if (type !== undefined && e.type.toLowerCase() !== type) return false;
    if (url !== undefined && !e.url.toLowerCase().includes(url)) return false;
    if (filters.failed === true) {
      if (e.failure === null && (e.status === null || e.status < 400))
        return false;
    }
    if (filters.after !== undefined && e.id <= filters.after) return false;
    return true;
  });
}

/** 一行一条请求：`#41 GET xhr 200 application/json 4.1 KB 230 ms <url>`。 */
function entryLine(entry: NetworkEntry): string {
  const mime = entry.mime === "" ? "-" : entry.mime;
  const size = entry.size === null ? "-" : sizeText(entry.size);
  const ms = entry.ms === null ? "-" : `${entry.ms} ms`;
  const where = entry.frame === "sub" ? " [iframe]" : "";
  return `#${entry.id} ${entry.method} ${entry.type} ${statusText(entry)} ${mime} ${size} ${ms} ${clip(entry.url, URL_MAX)}${where}`;
}

/** 只写给了的过滤项。 */
function filterText(filters: NetworkFilters): string | null {
  const parts: string[] = [];
  if (filters.type !== undefined) parts.push(`type=${filters.type}`);
  if (filters.url !== undefined) parts.push(`url~"${filters.url}"`);
  if (filters.failed === true) parts.push("failed");
  if (filters.after !== undefined) parts.push(`after=${filters.after}`);
  return parts.length === 0 ? null : `FILTER: ${parts.join(", ")}`;
}

function shellLines(query: NetworkQuery, shown: number): string[] {
  const filter = filterText(query.filters);
  return [
    `NETWORK: ${query.title} | ${query.url}`,
    `REQUESTS: ${query.total} in buffer · ${shown} shown · last id ${query.lastId} · ${query.evicted} older entries dropped`,
    ...(filter === null ? [] : [filter]),
  ];
}

export function renderNetwork(
  shown: readonly NetworkEntry[],
  query: NetworkQuery,
): NetworkView {
  const body =
    shown.length === 0
      ? ["No requests matched."]
      : shown.map((e) => entryLine(e));
  const head = shellLines(query, shown.length);
  const full = [...head, ...body].join("\n");
  if (body.join("\n").length <= TOTAL_MAX)
    return { text: full, elided: false, full };

  // 超预算：从最新的整行往前装，仍按升序打印；被丢掉的行数写在条目部分最前面。
  const kept: string[] = [];
  let used = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const line = body[i] ?? "";
    const cost = line.length + 1;
    if (used + cost > TOTAL_MAX) break;
    kept.unshift(line);
    used += cost;
  }
  const rest = body.length - kept.length;
  const text = [
    ...head,
    `… ${rest} earlier entries omitted (${body.length} shown in total); full list is saved as an attachment`,
    ...kept,
  ].join("\n");
  return { text, elided: true, full };
}

/** 详情里的头：一个头一行，值超上限截断；没有头就是空段。 */
function headerLines(name: string, headers: Record<string, string>): string[] {
  const entries = Object.entries(headers);
  if (entries.length === 0) return [`${name}: (none)`];
  const out = [`${name}:`];
  for (const [key, value] of entries)
    out.push(`  ${key}: ${clip(value, VALUE_MAX)}`);
  return out;
}

export function renderRequest(
  detail: NetworkDetail,
  query: { title: string; url: string },
): string {
  const e = detail.entry;
  const lines = [
    `REQUEST #${e.id}: ${query.title} | ${query.url}`,
    `${e.method} ${e.url}`,
    `STATUS: ${statusText(e)} · TYPE: ${e.type} · MIME: ${e.mime === "" ? "-" : e.mime} · FRAME: ${e.frame === "main" ? "main" : "iframe"}`,
    `TIME: started ${clock(e.ts)} · ${e.ms === null ? "-" : `${e.ms} ms`}`,
    `SIZE: response body ${e.size === null ? "-" : sizeText(e.size)} · request body ${detail.requestBodyBytes === null ? "-" : sizeText(detail.requestBodyBytes)}`,
    ...headerLines("REQUEST HEADERS", detail.requestHeaders),
    ...(detail.responseHeaders === null
      ? ["RESPONSE HEADERS: (none)"]
      : headerLines("RESPONSE HEADERS", detail.responseHeaders)),
    'NOTE: URLs and header values are shown exactly as sent and received (credentials included); use body="request" or body="response" with this id to read a body',
  ];
  return lines.join("\n");
}

/** renderBody 的入参：哪一条的哪一侧、它的 mime，加上整理好的内容。 */
export interface BodyInfo extends BodyPresentation {
  id: number;
  which: "request" | "response";
  mime: string;
}

/** 一条请求某一侧的内容：外壳固定，正文原样；被截断的字符数与附件标记行跟在后面。 */
export function renderBody(
  info: BodyInfo,
  query: { title: string; url: string },
): string {
  const lines = [
    `BODY #${info.id} ${info.which}: ${query.title} | ${query.url}`,
    `MIME: ${info.mime === "" ? "-" : info.mime} · SIZE: ${sizeText(info.size)} · ${info.text === null ? "binary (not shown)" : "text"}`,
  ];
  if (info.text !== null) {
    lines.push(info.text);
    const hidden = info.totalChars - info.shownChars;
    if (hidden > 0) lines.push(`… (+${hidden} chars not shown)`);
  }
  if (info.marker !== null) lines.push(`FULL BODY: ${info.marker}`);
  return lines.join("\n");
}
