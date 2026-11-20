// 拦截规则 → 给模型看的文字。纯函数：不碰工具与引擎，渲染规则固定，方便单独推定格式。
// 外壳是固定的英文，pattern 与页面内容原样。
import type { RouteInfo, RouteRule } from "../engine/types.js";

/** 与引擎的 ROUTE_MAX 一致：只用来印表格（agent 不 import 引擎的实现）。 */
const ROUTE_MAX = 20;

/** 一行的描述：`<action> <METHOD|*> <type|*> <pattern> <细节>`，有 delayMs 时末尾再加。 */
export function routeSummary(rule: RouteRule): string {
  const head = `${rule.action.kind} ${rule.method ?? "*"} ${rule.type ?? "*"} ${rule.pattern} ${actionDetail(rule)}`;
  return rule.delayMs === undefined ? head : `${head} delay ${rule.delayMs} ms`;
}

/** 动作的细节：每种动作只写它自己那几项。 */
function actionDetail(rule: RouteRule): string {
  const action = rule.action;
  if (action.kind === "block") return `error=${action.error ?? "failed"}`;
  if (action.kind === "mock") {
    const headers = Object.keys(action.headers).length;
    return `→ ${action.status} ${action.body.length} chars, ${headers} headers`;
  }
  if (action.kind === "modify") {
    const parts: string[] = [];
    if (action.method !== undefined) parts.push(`method=${action.method}`);
    if (action.url !== undefined) parts.push(`url=${action.url}`);
    if (action.body !== undefined)
      parts.push(`body=${action.body.length} chars`);
    const changed = headerChangeText(action.headers);
    if (changed !== null) parts.push(changed);
    return parts.join(" ");
  }
  const parts: string[] = [];
  if (action.status !== undefined) parts.push(`status=${action.status}`);
  const changed = headerChangeText(action.headers);
  if (changed !== null) parts.push(changed);
  if (action.replace !== undefined)
    parts.push(`replace ×${action.replace.length}`);
  return parts.join(" ");
}

/** `headers +2 -1`：设置几个、删除几个；没给 headers 就是 null。 */
function headerChangeText(
  headers: Record<string, string | null> | undefined,
): string | null {
  if (headers === undefined) return null;
  const values = Object.values(headers);
  const sets = values.filter((v) => v !== null).length;
  const drops = values.length - sets;
  return `headers +${sets} -${drops}`;
}

/** 列表：头两行是页面与条数，之后一行一条规则（带命中次数）。 */
export function renderRoutes(
  rules: readonly RouteInfo[],
  query: { title: string; url: string },
): string {
  const head = [
    `ROUTES: ${query.title} | ${query.url}`,
    `RULES: ${rules.length} (max ${ROUTE_MAX})`,
  ];
  if (rules.length === 0) return [...head, "No rules."].join("\n");
  return [
    ...head,
    ...rules.map((r) => `#${r.id} ${routeSummary(r)} (hits ${r.hits})`),
  ].join("\n");
}
