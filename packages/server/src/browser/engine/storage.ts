// Cookie 与 Web 存储的读写（browser_storage 的下层）。Cookie 走 context（页面脚本读不到的
// HttpOnly 也能读），Web 存储走页面里一个自包含函数。只有这个文件与 page.ts 碰 Playwright。
import type { BrowserContext, Frame, Page } from "playwright-core";
import type {
  CookieInput,
  PageCookie,
  WebStorageEntry,
  WebStorageOp,
} from "./types.js";

// 浏览器里的形状（server 的 tsconfig 不含 dom 库，只写用到的成员）。
interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}
interface StorageEnv {
  localStorage: StorageLike;
  sessionStorage: StorageLike;
}

/**
 * 在页面里读写主 frame 当前源的 Web 存储，会被序列化进浏览器执行（只能引用 globalThis 与参数）。
 * get 不给 key 返回全部（按键名升序）；clear 的 changed 是清前的条数。
 */
export function webStorageOp(arg: {
  kind: "local" | "session";
  op: WebStorageOp;
}): { entries: WebStorageEntry[]; changed: number } {
  const g = globalThis as unknown as StorageEnv;
  const { kind, op } = arg;
  const store = kind === "local" ? g.localStorage : g.sessionStorage;
  const all = (): WebStorageEntry[] => {
    const out: WebStorageEntry[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null) continue;
      out.push({ key, value: store.getItem(key) ?? "" });
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  };
  const one = (key: string): WebStorageEntry[] => {
    const value = store.getItem(key);
    return value === null ? [] : [{ key, value }];
  };
  if (op.op === "get")
    return { entries: op.key === undefined ? all() : one(op.key), changed: 0 };
  if (op.op === "set") {
    store.setItem(op.key, op.value);
    return { entries: one(op.key), changed: 1 };
  }
  if (op.op === "delete") {
    const had = store.getItem(op.key) !== null;
    store.removeItem(op.key);
    return { entries: [], changed: had ? 1 : 0 };
  }
  const count = store.length;
  store.clear();
  return { entries: [], changed: count };
}

/** 错误的第一行；去掉 Playwright 加的方法名前缀（frame.evaluate: / locator.evaluate: …）。 */
function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  const line =
    m
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? m;
  return line.replace(/^(frame|page|locator)\.evaluate: /, "");
}

/** 这个地址有没有 Cookie 语义（http / https）。about:blank、data: 之类没有。 */
function cookieUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

/** 浏览器里的 Cookie → 引擎的形状。 */
function toCookie(c: {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}): PageCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    // 以 Playwright 交回来的为准；缺失当 Lax，不自己推断。
    sameSite: c.sameSite ?? "Lax",
  };
}

/** 当前页面地址能带上的 Cookie；没有 Cookie 语义的地址返回空数组，不抛。 */
export async function readCookies(
  ctx: BrowserContext,
  page: Page,
  scope: "page" | "all",
): Promise<PageCookie[]> {
  if (scope === "all") return (await ctx.cookies()).map(toCookie);
  const url = page.url();
  if (!cookieUrl(url)) return [];
  try {
    return (await ctx.cookies(url)).map(toCookie);
  } catch {
    // 地址里有 Playwright 解析不了的东西：当作没有 Cookie。
    return [];
  }
}

/** 写一个 Cookie：没给 domain 按当前页面地址（Playwright 要 url 与 domain+path 二选一）。 */
export async function writeCookie(
  ctx: BrowserContext,
  page: Page,
  cookie: CookieInput,
): Promise<void> {
  const url = page.url();
  // 没给 domain 就只能按页面地址写；地址没有 Cookie 语义时 Playwright 会报一个难懂的错误。
  if (cookie.domain === undefined && !cookieUrl(url))
    throw new Error("当前页面不是 http(s) 地址，要给 domain");
  const attrs = {
    name: cookie.name,
    value: cookie.value,
    ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
    ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
  };
  try {
    // url 形式不能带 path（Playwright 的校验）；只要点名了 path，就转成 domain + path 形式。
    if (cookie.domain === undefined && cookie.path === undefined)
      await ctx.addCookies([{ ...attrs, url }]);
    else
      await ctx.addCookies([
        {
          ...attrs,
          domain: cookie.domain ?? new URL(url).hostname,
          path: cookie.path ?? "/",
        },
      ]);
  } catch (err) {
    throw new Error(firstLine(err));
  }
}

/**
 * 删除 Cookie：给 name 只删这一个（在 scope 范围内），不给就删 scope 范围内的全部；返回删了几个。
 * Playwright 按 name + domain + path 精确过滤，所以逐个删。
 */
export async function removeCookies(
  ctx: BrowserContext,
  page: Page,
  scope: "page" | "all",
  name?: string,
): Promise<number> {
  const hits = (await readCookies(ctx, page, scope)).filter(
    (c) => name === undefined || c.name === name,
  );
  for (const c of hits)
    await ctx.clearCookies({ name: c.name, domain: c.domain, path: c.path });
  return hits.length;
}

/** 主 frame 当前源的 Web 存储；源不可访问（about:blank、不透明源、SecurityError）抛一句中文。 */
export async function readWebStorage(
  page: Page,
  kind: "local" | "session",
  op: WebStorageOp,
): Promise<{ entries: WebStorageEntry[]; changed: number }> {
  const frame: Frame = page.mainFrame();
  try {
    return await frame.evaluate(webStorageOp, { kind, op });
  } catch (err) {
    throw new Error(`这个页面的源不能访问 ${kind}Storage：${firstLine(err)}`);
  }
}
