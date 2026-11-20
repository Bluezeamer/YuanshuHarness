// readCookies / writeCookie / removeCookies / readWebStorage 的真浏览器端到端：
// YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 直接用 Playwright 起浏览器（不经引擎与代理）：夹具就是本机 http 站点。
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  readCookies,
  readWebStorage,
  removeCookies,
  writeCookie,
} from "./storage.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";

// 夹具：两个 Cookie（一个 HttpOnly、一个普通），localStorage 里两条（故意倒序写，验证排序）。
const PAGE = `<!doctype html><meta charset=utf-8><title>存储页</title>
<div id="out">reading</div>
<script src="/app.js"></script>`;
const APP = `document.cookie = "theme=dark; path=/";
localStorage.setItem("b", "2");
localStorage.setItem("a", "1");
document.getElementById("out").textContent = "cookie=" + document.cookie;`;

interface Site {
  port: number;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/app.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end(APP);
      return;
    }
    if (path === "/cookies") {
      // HttpOnly 的会话 Cookie 由服务端下发；页面脚本读不到它。
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": ["sid=abc123; HttpOnly; Path=/"],
      });
      res.end(PAGE);
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const error = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return (e as Error).message;
};

describe.skipIf(!enabled)("Cookie 与 Web 存储（真实 Chromium）", () => {
  let browser: Browser;
  let site: Site;
  let ctx: BrowserContext;
  let page: Page;
  const origin = () => `http://127.0.0.1:${site.port}`;

  beforeAll(async () => {
    if (!enabled) return;
    site = await startSite();
    browser = await chromium.launch({ executablePath: EXE });
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await page.goto(`${origin()}/cookies`);
    await page.waitForLoadState("load");
  });

  afterAll(async () => {
    if (!enabled) return;
    await browser?.close().catch(() => {});
    await site?.close().catch(() => {});
  });

  test('cookies("page") 读得到 HttpOnly 的，页面里 document.cookie 读不到它', async () => {
    const cookies = await readCookies(ctx, page, "page");
    const sid = cookies.find((c) => c.name === "sid");
    expect(sid).toMatchObject({
      value: "abc123",
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    });
    expect(cookies.some((c) => c.name === "theme")).toBe(true);
    const visible = await page.evaluate("document.cookie");
    expect(visible).toContain("theme=dark");
    expect(visible).not.toContain("sid=abc123");
  });

  test("setCookie 手写一个带全部属性的 Cookie", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await writeCookie(ctx, page, {
      name: "all",
      value: "v1",
      domain: "127.0.0.1",
      path: "/deep",
      expires,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    });
    const hit = (await readCookies(ctx, page, "all")).find(
      (c) => c.name === "all",
    );
    expect(hit).toMatchObject({
      value: "v1",
      domain: "127.0.0.1",
      path: "/deep",
      expires,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    });
  });

  test("setCookie 不给 domain：按当前页面地址落，path 缺省 /", async () => {
    await writeCookie(ctx, page, { name: "pageform", value: "pv" });
    const hit = (await readCookies(ctx, page, "all")).find(
      (c) => c.name === "pageform",
    );
    expect(hit).toMatchObject({
      value: "pv",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
    });
  });

  test("setCookie 只给 path 不给 domain：按页面地址的域 + 这个 path 落", async () => {
    await writeCookie(ctx, page, {
      name: "pathed",
      value: "pv",
      path: "/deep",
    });
    const hit = (await readCookies(ctx, page, "all")).find(
      (c) => c.name === "pathed",
    );
    expect(hit).toMatchObject({ domain: "127.0.0.1", path: "/deep" });
  });

  test("setCookie 在 about:blank 上又不给 domain：报要给 domain", async () => {
    const blank = await ctx.newPage();
    try {
      expect(
        await error(writeCookie(ctx, blank, { name: "x", value: "y" })),
      ).toBe("当前页面不是 http(s) 地址，要给 domain");
    } finally {
      await blank.close();
    }
  });

  test('cookies("all") 含另一个域的 Cookie，"page" 不含', async () => {
    await writeCookie(ctx, page, {
      name: "other",
      value: "ov",
      domain: "other.test",
      path: "/",
    });
    const all = await readCookies(ctx, page, "all");
    expect(
      all.some((c) => c.name === "other" && c.domain === "other.test"),
    ).toBe(true);
    const local = await readCookies(ctx, page, "page");
    expect(local.some((c) => c.name === "other")).toBe(false);
  });

  test("removeCookies 带 name 只删那一个，不带 name 删 scope 内的全部", async () => {
    // 先补三个 127.0.0.1 上的 Cookie。
    for (const name of ["d1", "d2", "d3"])
      await writeCookie(ctx, page, { name, value: "v" });
    expect(await removeCookies(ctx, page, "page", "d1")).toBe(1);
    let left = await readCookies(ctx, page, "page");
    expect(left.some((c) => c.name === "d1")).toBe(false);
    expect(left.some((c) => c.name === "d2")).toBe(true);
    // 删光了再删是 0（正常结果）。
    expect(await removeCookies(ctx, page, "page", "d1")).toBe(0);
    const removed = await removeCookies(ctx, page, "page");
    expect(removed).toBeGreaterThanOrEqual(2);
    left = await readCookies(ctx, page, "page");
    expect(left).toEqual([]);
    // scope all 的删法连别的域一起算。
    expect(await removeCookies(ctx, page, "all", "other")).toBe(1);
    const all = await readCookies(ctx, page, "all");
    expect(all.some((c) => c.name === "other")).toBe(false);
  });

  test('about:blank 上 cookies("page") 是空数组，不抛', async () => {
    const blank = await ctx.newPage();
    try {
      expect(await readCookies(ctx, blank, "page")).toEqual([]);
    } finally {
      await blank.close();
    }
  });

  test("webStorage：get / set / delete / clear，条目按键名升序", async () => {
    expect(await readWebStorage(page, "local", { op: "get" })).toEqual({
      entries: [
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ],
      changed: 0,
    });
    expect(
      await readWebStorage(page, "local", { op: "set", key: "c", value: "3" }),
    ).toEqual({ entries: [{ key: "c", value: "3" }], changed: 1 });
    expect(
      await readWebStorage(page, "local", { op: "get", key: "a" }),
    ).toEqual({ entries: [{ key: "a", value: "1" }], changed: 0 });
    expect(
      await readWebStorage(page, "local", { op: "get", key: "zz" }),
    ).toEqual({ entries: [], changed: 0 });
    expect(
      await readWebStorage(page, "local", { op: "delete", key: "c" }),
    ).toEqual({ entries: [], changed: 1 });
    expect(
      await readWebStorage(page, "local", { op: "delete", key: "c" }),
    ).toEqual({ entries: [], changed: 0 });
    expect(await readWebStorage(page, "local", { op: "clear" })).toEqual({
      entries: [],
      changed: 2,
    });
    expect(await readWebStorage(page, "local", { op: "get" })).toEqual({
      entries: [],
      changed: 0,
    });
  });

  test("webStorage：乱序写入的键也按键名升序给出（Chromium 自己的顺序不是升序）", async () => {
    for (const key of ["b", "z", "a", "m"])
      await readWebStorage(page, "session", { op: "set", key, value: "1" });
    const { entries } = await readWebStorage(page, "session", { op: "get" });
    expect(entries.map((e) => e.key)).toEqual(["a", "b", "m", "z"]);
    await readWebStorage(page, "session", { op: "clear" });
  });

  test("sessionStorage 与 localStorage 各管各的", async () => {
    expect(
      await readWebStorage(page, "session", {
        op: "set",
        key: "s",
        value: "sv",
      }),
    ).toEqual({ entries: [{ key: "s", value: "sv" }], changed: 1 });
    expect(await readWebStorage(page, "local", { op: "get" })).toEqual({
      entries: [],
      changed: 0,
    });
    expect(await readWebStorage(page, "session", { op: "clear" })).toEqual({
      entries: [],
      changed: 1,
    });
  });

  test("about:blank 上 webStorage 抛「这个页面的源不能访问」", async () => {
    const blank = await ctx.newPage();
    try {
      const msg = await error(readWebStorage(blank, "local", { op: "get" }));
      expect(msg).toContain("这个页面的源不能访问 localStorage");
      expect(msg).toContain("SecurityError");
    } finally {
      await blank.close();
    }
  });

  test("sameSite None 没带 secure：Chromium 不报错，只是不存（实测，不是校验错误）", async () => {
    // 这条是实测结论：Playwright 1.65 + Chromium 对这个组合不抛校验错误，浏览器直接不存这个 Cookie。
    await writeCookie(ctx, page, {
      name: "none",
      value: "v",
      domain: "127.0.0.1",
      path: "/",
      sameSite: "None",
    });
    const hit = (await readCookies(ctx, page, "all")).find(
      (c) => c.name === "none",
    );
    expect(hit).toBeUndefined();
    // 带上 secure 就能存下来。
    await writeCookie(ctx, page, {
      name: "none2",
      value: "v",
      domain: "127.0.0.1",
      path: "/",
      sameSite: "None",
      secure: true,
    });
    expect(
      (await readCookies(ctx, page, "all")).some((c) => c.name === "none2"),
    ).toBe(true);
  });

  test("expires 给负数（不是 -1）：第一行错误原样交出来", async () => {
    const msg = await error(
      writeCookie(ctx, page, {
        name: "bad",
        value: "v",
        domain: "127.0.0.1",
        path: "/",
        expires: -2,
      }),
    );
    expect(msg).toBe(
      "browserContext.addCookies: Cookie should have a valid expires, only -1 or a positive number for the unix timestamp in seconds is allowed",
    );
  });
});
