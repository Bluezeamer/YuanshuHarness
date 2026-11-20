// browser_request 的结果 → 给模型看的文字。纯函数：不碰工具与引擎，渲染规则固定，方便单独推定格式。
// 外壳是固定的英文，地址、头与响应体保持原文（不打码）。
import type { BodyPresentation } from "./body.js";
import { sizeText } from "./network-view.js";

/** 头部值的显示上限。 */
const HEADER_VALUE_MAX = 300;

/** 响应体的整理结果：presentBody 给的，加上它的 mime。 */
export interface RequestBody extends BodyPresentation {
  mime: string;
}

export interface RequestQuery {
  pageId: string;
  method: string;
  url: string;
  /** 用了命名身份才有 */
  identity?: string;
  /** 命名身份罐里此刻的 cookie 名字（有身份才有；没有这个身份是 null） */
  jar: string[] | null;
  ms: number;
  status: number;
  statusText: string;
  /** 响应头，顺序与重复都保持 */
  headers: [string, string][];
}

/** 跟随重定向走过的一跳：状态码、方法、地址与下一跳（最后一跳没有 →）。 */
export interface RedirectHop {
  status: number;
  method: string;
  url: string;
  location?: string;
}

function clip(value: string): string {
  if (value.length <= HEADER_VALUE_MAX) return value;
  return `${value.slice(0, HEADER_VALUE_MAX)}…(+${value.length - HEADER_VALUE_MAX} chars)`;
}

function headerLines(headers: readonly [string, string][]): string[] {
  if (headers.length === 0) return ["RESPONSE HEADERS: (none)"];
  return [
    "RESPONSE HEADERS:",
    ...headers.map(([n, v]) => `  ${n}: ${clip(v)}`),
  ];
}

function redirectLines(
  hops: readonly RedirectHop[],
  stopped: string | null,
): string[] {
  // 没有跟随（一步都没有跳）就不写这一段：那只是这一次请求本身。
  const followed = hops.some((h) => h.location !== undefined);
  if (!followed && stopped === null) return [];
  return [
    "REDIRECTS:",
    ...hops.map((h) =>
      h.location === undefined
        ? `  ${h.status} ${h.method} ${h.url}`
        : `  ${h.status} ${h.method} ${h.url} → ${h.location}`,
    ),
    ...(stopped === null ? [] : [`  (stopped: ${stopped})`]),
  ];
}

function jarLine(identity: string, jar: string[] | null): string {
  const none = jar === null || jar.length === 0;
  return `JAR ${identity}: ${none ? "none" : `${jar.length} cookies (${jar.join(", ")})`}`;
}

function bodyLines(body: RequestBody | string): string[] {
  // 固定的一行说明（空体、HEAD、存不上）。
  if (typeof body === "string") return [body];
  const head = `BODY: ${body.mime === "" ? "-" : body.mime} · ${sizeText(body.size)} · ${body.text === null ? "binary (not shown)" : "text"}`;
  if (body.text === null)
    return [
      head,
      ...(body.marker === null ? [] : [`FULL BODY: ${body.marker}`]),
    ];
  const hidden = body.totalChars - body.shownChars;
  return [
    head,
    body.text,
    ...(hidden > 0 ? [`… (+${hidden} chars not shown)`] : []),
    ...(body.marker === null ? [] : [`FULL BODY: ${body.marker}`]),
  ];
}

/**
 * 请求的结果：头行、命名身份罐、重定向各跳、状态、响应头、响应体。
 * body 是整理好的响应体，或一句固定说明（`BODY: empty`、`BODY: none (HEAD)`、`BODY: not saved — …`）。
 */
export function renderRequest(
  query: RequestQuery,
  hops: readonly RedirectHop[],
  stopped: string | null,
  body: RequestBody | string,
): string {
  const via =
    query.identity === undefined
      ? `page ${query.pageId}`
      : `identity ${query.identity}`;
  return [
    `REQUEST: ${query.method} ${query.url}  (via ${via}, ${query.ms} ms)`,
    ...redirectLines(hops, stopped),
    `STATUS: ${query.status} ${query.statusText}`,
    ...headerLines(query.headers),
    ...bodyLines(body),
    // 命名身份的罐是这次请求（含它自己的 Set-Cookie）之后的状态，写在末尾。
    ...(query.identity === undefined
      ? []
      : [jarLine(query.identity, query.jar)]),
  ].join("\n");
}
