// 请求拦截与改写（browser_route 的下层）：每条规则单独 page.route，命中后按动作处理。
// 只有这个文件与 page.ts 碰 Playwright 的拦截；规则挂在页面上，页面关闭或休眠后唤醒就没了。
import type { Page, Route } from "playwright-core";
import type { RouteAction, RouteInfo, RouteRule } from "./types.js";

/** 每个页面最多几条规则。 */
export const ROUTE_MAX = 20;
/** delayMs 的上限：造慢响应用。 */
export const DELAY_MAX_MS = 10_000;

const noop = () => {};

/** 装了一条规则：glob 与它自己的 handler（删除时 page.unroute 要成对给）。 */
interface Registered {
  info: RouteInfo;
  handler: (route: Route) => Promise<void>;
}

export interface RouteTable {
  add(rule: RouteRule): Promise<RouteInfo>;
  remove(id: number): Promise<boolean>;
  list(): RouteInfo[];
  clear(): Promise<number>;
}

/** 头名小写：与 Playwright 的 headers() 一致，规则里的设置 / 删除也按小写比较。 */
const lower = (name: string): string => name.toLowerCase();

/** 等这么多毫秒（不拖住进程）。 */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * 头按规则改：base 是原样的头，值是 null 的删掉（名字大小写不敏感），其余覆盖 / 新增。
 * 结果的名字小写。
 */
function mergeHeaders(
  base: Record<string, string>,
  change: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) out[lower(name)] = value;
  for (const [name, value] of Object.entries(change)) {
    if (value === null) delete out[lower(name)];
    else out[lower(name)] = value;
  }
  return out;
}

/** 文本响应体按顺序做全部出现处的字面量替换；二进制（解码失败）原样。 */
function replaceText(
  body: Buffer,
  pairs: { find: string; with: string }[],
): { bytes: Buffer; replaced: boolean } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { bytes: body, replaced: false };
  }
  let replaced = false;
  let out = text;
  for (const { find, with: to } of pairs) {
    if (find === "" || !out.includes(find)) continue;
    out = out.split(find).join(to);
    replaced = true;
  }
  return { bytes: Buffer.from(out, "utf8"), replaced };
}

/** 按动作处理一条已命中的请求；任何一步抛错都由调用方吞掉。 */
async function handle(route: Route, action: RouteAction): Promise<void> {
  if (action.kind === "block") {
    await route.abort(action.error ?? "failed");
    return;
  }
  if (action.kind === "mock") {
    await route.fulfill({
      status: action.status,
      headers: action.headers,
      body: action.body,
    });
    return;
  }
  if (action.kind === "modify") {
    // 拦截时请求还没发出：只能用同步的 headers()（allHeaders() 会一直等响应）。
    const headers =
      action.headers === undefined
        ? undefined
        : mergeHeaders(route.request().headers(), action.headers);
    await route.continue({
      ...(action.method === undefined ? {} : { method: action.method }),
      ...(action.url === undefined ? {} : { url: action.url }),
      ...(action.body === undefined ? {} : { postData: action.body }),
      ...(headers === undefined ? {} : { headers }),
    });
    return;
  }
  // patch：用本上下文发出真实请求，再改写拿到的响应。
  const res = await route.fetch();
  const patched = replaceText(await res.body(), action.replace ?? []);
  const merged = mergeHeaders(res.headers(), action.headers ?? {});
  // 体被替换过就删掉 content-length，让 Playwright 按改过的体重算。
  if (patched.replaced) delete merged["content-length"];
  await route.fulfill({
    response: res,
    ...(action.status === undefined ? {} : { status: action.status }),
    headers: merged,
    ...(patched.replaced ? { body: patched.bytes } : {}),
  });
}

export function watchRoutes(page: Page): RouteTable {
  const rules: Registered[] = [];
  let nextId = 1;

  return {
    async add(rule) {
      if (rules.length >= ROUTE_MAX)
        throw new Error(`每个页面最多 ${ROUTE_MAX} 条拦截规则：先删掉不用的`);
      if (
        rule.delayMs !== undefined &&
        (!Number.isInteger(rule.delayMs) ||
          rule.delayMs < 0 ||
          rule.delayMs > DELAY_MAX_MS)
      )
        throw new Error(`delayMs 要在 0–${DELAY_MAX_MS} 之间（整数毫秒）`);
      // 登记成功才占用编号：glob 不合法的规则不留在表里，也不占号。
      const info: RouteInfo = { ...rule, id: nextId, hits: 0 };
      const handler = async (route: Route): Promise<void> => {
        try {
          const req = route.request();
          // 过滤没命中：交给下一条规则 / 网络，不计命中。
          if (rule.method !== undefined && req.method() !== rule.method)
            return await route.fallback();
          if (rule.type !== undefined && req.resourceType() !== rule.type)
            return await route.fallback();
          info.hits += 1;
          if (rule.delayMs !== undefined) await sleep(rule.delayMs);
          await handle(route, rule.action);
        } catch {
          // 页面关了、请求已被别处处理都是正常的；处理没走完就交回网络。
          await route.fallback().catch(noop);
        }
      };
      try {
        await page.route(rule.pattern, handler);
      } catch (err) {
        // glob 不合法：Playwright 的报错第一行原样给模型，不登记。
        throw new Error(
          err instanceof Error
            ? (err.message.split("\n")[0] ?? "")
            : String(err),
        );
      }
      rules.push({ info, handler });
      nextId += 1;
      return { ...info };
    },

    async remove(id) {
      const at = rules.findIndex((r) => r.info.id === id);
      if (at < 0) return false;
      const [gone] = rules.splice(at, 1);
      if (gone) await page.unroute(gone.info.pattern, gone.handler).catch(noop);
      return true;
    },

    list: () => rules.map((r) => ({ ...r.info })),

    async clear() {
      const all = rules.splice(0, rules.length);
      for (const r of all)
        await page.unroute(r.info.pattern, r.handler).catch(noop);
      return all.length;
    },
  };
}
