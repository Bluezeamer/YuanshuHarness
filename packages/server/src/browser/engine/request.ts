// 以页面所在上下文的身份发一次 HTTP 请求（browser_request 的下层）：带这个上下文的 cookie 罐与代理出口。
// 给了命名的 identity 就换成同出口、同 UA 的隔离上下文：自己的 cookie 罐，与页面完全分开。
import {
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  request as httpClient,
} from "playwright-core";
import { denyText } from "../net/proxy.js";
import { firstLine } from "./assets.js";
import type { HttpRequestSpec, HttpResult } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
/** 每个浏览器上下文最多这么多个命名身份。 */
const IDENTITY_MAX = 8;

/**
 * 一个浏览器上下文（工作区的）的请求出口：页面自己的上下文，加最多 8 个命名身份的隔离罐。
 * 罐子只在内存里，跟上下文同寿，不落盘。
 */
export class RequestJars {
  private readonly identities = new Map<string, APIRequestContext>();

  constructor(
    private readonly ctx: BrowserContext,
    private readonly proxy: {
      server: string;
      username: string;
      password: string;
    },
    private readonly userAgent: string,
  ) {}

  /** 发一次请求：不跟随重定向（3xx 原样返回），状态码不判失败。 */
  async fetch(spec: HttpRequestSpec): Promise<HttpResult> {
    const api =
      spec.identity === undefined
        ? this.ctx.request
        : await this.identity(spec.identity);
    const started = Date.now();
    let res: APIResponse;
    try {
      res = await api.fetch(spec.url, {
        method: spec.method,
        headers: spec.headers,
        ...(spec.body === undefined ? {} : { data: spec.body }),
        // 0 在 Playwright 里表示不跟随：3xx 的响应与 location 头照原样交出，跟随由工具层逐跳做。
        maxRedirects: 0,
        timeout: REQUEST_TIMEOUT_MS,
        failOnStatusCode: false,
      });
    } catch (err) {
      return { ok: false, reason: firstLine(err) };
    }
    const ms = Date.now() - started;
    try {
      const deny = res.headers()["x-yuanshu-deny"];
      if (deny !== undefined) return { ok: false, reason: denyText(deny) };
      const bytes = await res.body().catch(() => null);
      if (bytes === null) return { ok: false, reason: "读取响应内容失败" };
      const headers = (await res.headersArray()).map((h): [string, string] => [
        h.name.toLowerCase(),
        h.value,
      ]);
      return {
        ok: true,
        status: res.status(),
        statusText: res.statusText(),
        headers,
        bytes,
        ms: Math.max(0, ms),
      };
    } finally {
      // Playwright 把响应体留在上下文里直到 dispose：不释放会一直占着内存。
      await res.dispose().catch(() => {});
    }
  }

  /** 命名身份罐里现在有哪些 cookie 的名字（没有这个身份返回 null）。 */
  async identityCookies(identity: string): Promise<string[] | null> {
    const api = this.identities.get(identity);
    if (api === undefined) return null;
    const state = await api.storageState();
    return state.cookies.map((c) => c.name);
  }

  /** 关掉所有命名身份的上下文（页面所在的那个由调用方关）。 */
  async close(): Promise<void> {
    const all = [...this.identities.values()];
    this.identities.clear();
    await Promise.all(all.map((api) => api.dispose().catch(() => {})));
  }

  /** 取或懒建一个命名身份的上下文：走同一个代理与 UA，罐子是空的。 */
  private async identity(name: string): Promise<APIRequestContext> {
    const existing = this.identities.get(name);
    if (existing !== undefined) return existing;
    if (this.identities.size >= IDENTITY_MAX)
      throw new Error(
        `最多 ${IDENTITY_MAX} 个命名身份：换一个已有的名字，或不用 identity`,
      );
    const api = await httpClient.newContext({
      proxy: this.proxy,
      userAgent: this.userAgent,
    });
    this.identities.set(name, api);
    return api;
  }
}
