// engine/request.ts：请求参数透传、网络层拒绝与报错、响应头顺序与重复、响应释放。
// 用假 ctx：不发真请求；命名身份与真出口在 request.live.test.ts。
import type { BrowserContext } from "playwright-core";
import { describe, expect, test, vi } from "vitest";
import { RequestJars } from "./request.js";

// 命名身份走 playwright-core 的 request.newContext：这里换成假实现，看建了几个、有没有释放。
const newContexts = vi.hoisted(() => {
  const made: Array<{
    proxy: unknown;
    userAgent: string;
    disposed: number;
    cookies: { name: string; value: string }[];
  }> = [];
  return { made };
});

vi.mock("playwright-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("playwright-core")>();
  return {
    ...actual,
    request: {
      newContext: async (opts: {
        proxy: unknown;
        userAgent: string;
        cookies?: { name: string; value: string }[];
      }) => {
        const rec = {
          proxy: opts.proxy,
          userAgent: opts.userAgent,
          disposed: 0,
          cookies: [] as { name: string; value: string }[],
        };
        newContexts.made.push(rec);
        return {
          fetch: async () => fakeResponse(),
          storageState: async () => ({ cookies: rec.cookies, origins: [] }),
          dispose: async () => {
            rec.disposed += 1;
          },
        };
      },
    },
  };
});

const PROXY = {
  server: "http://127.0.0.1:9",
  username: "u",
  password: "p",
};

/** 假响应：headersArray 给的是「名字带大小写、重复各一条」的样子。 */
function fakeResponse(
  opts: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    headersArray?: { name: string; value: string }[];
    body?: Buffer | Error;
  } = {},
) {
  const body = opts.body ?? Buffer.from("ok");
  return {
    status: () => opts.status ?? 200,
    statusText: () => opts.statusText ?? "OK",
    headers: () => opts.headers ?? {},
    headersArray: async () =>
      opts.headersArray ?? [{ name: "Content-Type", value: "text/plain" }],
    body: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
    dispose: vi.fn(async () => {}),
  };
}

/** fetch 替身收到的调用参数（mock.calls 的元素类型对不上，这里收窄）。 */
const calls = (fetch: ReturnType<typeof fakeCtx>["fetch"]): unknown[][] =>
  fetch.mock.calls.map((c) => [...c]);

/** 假上下文：只带 request.fetch。 */
function fakeCtx(response: unknown) {
  const fetch = vi.fn(async () => response);
  const ctx = { request: { fetch } } as unknown as BrowserContext;
  return { ctx, fetch };
}

describe("RequestJars.fetch", () => {
  test("参数原样传下去：方法、头、body 与不跟随重定向、不按状态码失败", async () => {
    const res = fakeResponse();
    const { ctx, fetch } = fakeCtx(res);
    const jars = new RequestJars(ctx, PROXY, "UA/1");

    await jars.fetch({
      url: "https://a.test/items",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-A": "1" },
      body: '{"a":1}',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const args = calls(fetch);
    expect(args).toHaveLength(1);
    const [url, opts] = args[0] as [string, Record<string, unknown>];
    expect(url).toBe("https://a.test/items");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({
      "Content-Type": "application/json",
      "X-A": "1",
    });
    expect(opts.data).toBe('{"a":1}');
    expect(opts.maxRedirects).toBe(0);
    expect(opts.failOnStatusCode).toBe(false);
    expect(opts.timeout).toBe(30_000);
  });

  test("没有 body 就不给 data", async () => {
    const { ctx, fetch } = fakeCtx(fakeResponse());
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    await jars.fetch({
      url: "https://a.test/",
      method: "GET",
      headers: {},
    });
    const [, opts] = calls(fetch)[0] as [string, Record<string, unknown>];
    expect("data" in opts).toBe(false);
  });

  test("成功：状态、状态文字、字节与毫秒；ms 非负", async () => {
    const bytes = Buffer.from([0, 1, 2]);
    const { ctx } = fakeCtx(
      fakeResponse({ status: 201, statusText: "Created", body: bytes }),
    );
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    const out = await jars.fetch({
      url: "https://a.test/",
      method: "POST",
      headers: {},
      body: "x",
    });
    expect(out).toMatchObject({
      ok: true,
      status: 201,
      statusText: "Created",
    });
    if (!out.ok) throw new Error("应当成功");
    expect(out.bytes.equals(bytes)).toBe(true);
    expect(out.ms).toBeGreaterThanOrEqual(0);
  });

  test("响应头保持顺序与重复，名字小写", async () => {
    const { ctx } = fakeCtx(
      fakeResponse({
        headersArray: [
          { name: "Content-Type", value: "text/html" },
          { name: "Set-Cookie", value: "a=1; Path=/" },
          { name: "set-cookie", value: "b=2; Path=/" },
        ],
      }),
    );
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    const out = await jars.fetch({
      url: "https://a.test/",
      method: "GET",
      headers: {},
    });
    if (!out.ok) throw new Error("应当成功");
    expect(out.headers).toEqual([
      ["content-type", "text/html"],
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2; Path=/"],
    ]);
  });

  test("网络层拒绝：给拒绝文字", async () => {
    const res = fakeResponse({
      headers: { "x-yuanshu-deny": "blocked_address" },
    });
    const { ctx } = fakeCtx(res);
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    const out = await jars.fetch({
      url: "https://a.test/",
      method: "GET",
      headers: {},
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("应当被拒");
    expect(out.reason).toContain("内网");
    expect(res.dispose).toHaveBeenCalled();
  });

  test("抛错：取报错第一行", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED\n  at stack");
    });
    const ctx = { request: { fetch } } as unknown as BrowserContext;
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    const out = await jars.fetch({
      url: "https://a.test/",
      method: "GET",
      headers: {},
    });
    expect(out).toEqual({ ok: false, reason: "net::ERR_CONNECTION_REFUSED" });
  });

  test("读不出响应体：给固定原因，并且仍然释放响应", async () => {
    const res = fakeResponse({ body: new Error("boom") });
    const { ctx } = fakeCtx(res);
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    const out = await jars.fetch({
      url: "https://a.test/",
      method: "GET",
      headers: {},
    });
    expect(out).toEqual({ ok: false, reason: "读取响应内容失败" });
    expect(res.dispose).toHaveBeenCalled();
  });

  test("成功路径也释放响应", async () => {
    const res = fakeResponse();
    const { ctx } = fakeCtx(res);
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    await jars.fetch({ url: "https://a.test/", method: "GET", headers: {} });
    expect(res.dispose).toHaveBeenCalled();
  });

  test("没有建过的身份：identityCookies 是 null", async () => {
    const { ctx } = fakeCtx(fakeResponse());
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    expect(await jars.identityCookies("bob")).toBeNull();
  });

  test("命名身份：懒建一次、走同一份代理与 UA、同名复用", async () => {
    newContexts.made.length = 0;
    const { ctx } = fakeCtx(fakeResponse());
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    for (const identity of ["bob", "bob", "carol"]) {
      await jars.fetch({
        url: "https://a.test/",
        method: "GET",
        headers: {},
        identity,
      });
    }
    expect(newContexts.made).toHaveLength(2);
    expect(newContexts.made[0]).toMatchObject({
      proxy: PROXY,
      userAgent: "UA/1",
    });
  });

  test("最多 8 个命名身份：第 9 个抛错", async () => {
    newContexts.made.length = 0;
    const { ctx } = fakeCtx(fakeResponse());
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    for (let i = 1; i <= 8; i++)
      await jars.fetch({
        url: "https://a.test/",
        method: "GET",
        headers: {},
        identity: `i${i}`,
      });
    await expect(
      jars.fetch({
        url: "https://a.test/",
        method: "GET",
        headers: {},
        identity: "i9",
      }),
    ).rejects.toThrow("最多 8 个命名身份");
    expect(newContexts.made).toHaveLength(8);
  });

  test("identityCookies：给罐里的名字；close 释放全部命名身份", async () => {
    newContexts.made.length = 0;
    const { ctx } = fakeCtx(fakeResponse());
    const jars = new RequestJars(ctx, PROXY, "UA/1");
    await jars.fetch({
      url: "https://a.test/",
      method: "GET",
      headers: {},
      identity: "bob",
    });
    const rec = newContexts.made[0];
    if (!rec) throw new Error("没有建身份");
    rec.cookies = [
      { name: "sid", value: "1" },
      { name: "csrf", value: "2" },
    ];
    expect(await jars.identityCookies("bob")).toEqual(["sid", "csrf"]);
    await jars.close();
    expect(rec.disposed).toBe(1);
    // 关掉之后同一个名字会重新建一个空罐
    expect(await jars.identityCookies("bob")).toBeNull();
  });
});
