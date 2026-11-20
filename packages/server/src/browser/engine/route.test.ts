// engine/route.ts：四种动作的改写、过滤、延时、上限与删除。用假 Page / 假 Route / 假 Request，不起浏览器。
import { afterEach, describe, expect, test, vi } from "vitest";
import { DELAY_MAX_MS, ROUTE_MAX, watchRoutes } from "./route.js";
import type { RouteAction, RouteRule } from "./types.js";

const noop = () => {};

/** 假请求：拦截时请求还没发出，只有同步的 headers() 能读。 */
function fakeRequest(init: {
  url?: string;
  method?: string;
  type?: string;
  headers?: Record<string, string>;
}) {
  return {
    url: () => init.url ?? "https://x.test/a.png",
    method: () => init.method ?? "GET",
    resourceType: () => init.type ?? "image",
    headers: () => init.headers ?? {},
    allHeaders: () => new Promise(() => {}), // 拦截时它会一直等：真用上就挂住。
  };
}

interface Call {
  kind: string;
  args: unknown;
}

/** 假 Route：记下被调用的方法，fulfill / fetch 由用例给结果。 */
function fakeRoute(
  init: Parameters<typeof fakeRequest>[0] = {},
  opts: { fetch?: () => Promise<unknown> } = {},
) {
  const calls: Call[] = [];
  const route = {
    request: () => fakeRequest(init),
    abort: async (error?: string) =>
      void calls.push({ kind: "abort", args: error }),
    continue: async (args?: unknown) =>
      void calls.push({ kind: "continue", args }),
    fulfill: async (args?: unknown) =>
      void calls.push({ kind: "fulfill", args }),
    fallback: async (args?: unknown) =>
      void calls.push({ kind: "fallback", args }),
    fetch: async () => {
      calls.push({ kind: "fetch", args: undefined });
      if (!opts.fetch) throw new Error("用例没有给 fetch 结果");
      return opts.fetch();
    },
  };
  return { route, calls };
}

/** 假 Page：记下 route / unroute 的登记，可按 glob 抛错。 */
function fakePage(opts: { badPattern?: string } = {}) {
  const handlers = new Map<
    string,
    Array<(route: ReturnType<typeof fakeRoute>["route"]) => Promise<void>>
  >();
  const calls: string[] = [];
  const page = {
    route: async (
      pattern: string,
      handler: (route: ReturnType<typeof fakeRoute>["route"]) => Promise<void>,
    ) => {
      calls.push(`route ${pattern}`);
      if (pattern === opts.badPattern)
        throw new Error(
          `Invalid glob pattern "${pattern}": unmatched '{'\n  at somewhere`,
        );
      const list = handlers.get(pattern) ?? [];
      list.push(handler);
      handlers.set(pattern, list);
    },
    unroute: async (
      pattern: string,
      handler: (route: ReturnType<typeof fakeRoute>["route"]) => Promise<void>,
    ) => {
      calls.push(`unroute ${pattern}`);
      const list = handlers.get(pattern) ?? [];
      handlers.set(
        pattern,
        list.filter((h) => h !== handler),
      );
    },
  };
  /** 按登记顺序（后加的也按登记的）把请求交给匹配的 handler 们。 */
  const fire = async (
    pattern: string,
    route: ReturnType<typeof fakeRoute>["route"],
  ) => {
    const list = handlers.get(pattern) ?? [];
    for (const h of list) await h(route);
  };
  const count = (pattern: string) => (handlers.get(pattern) ?? []).length;
  return { page, calls, fire, count };
}

const rule = (
  over: Partial<RouteRule> & { action: RouteAction },
): RouteRule => ({
  pattern: "**/*.png",
  ...over,
});

describe("动作", () => {
  test("block：abort 带 errorCode，缺省 failed", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ action: { kind: "block" } }));
    await table.add(
      rule({
        pattern: "**/*.jpg",
        action: { kind: "block", error: "blockedbyclient" },
      }),
    );

    const a = fakeRoute();
    await fire("**/*.png", a.route as never);
    expect(a.calls).toEqual([{ kind: "abort", args: "failed" }]);

    const b = fakeRoute({ url: "https://x.test/a.jpg" });
    await fire("**/*.jpg", b.route as never);
    expect(b.calls).toEqual([{ kind: "abort", args: "blockedbyclient" }]);
  });

  test("mock：fulfill 带 status / headers / body", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    const info = await table.add(
      rule({
        action: {
          kind: "mock",
          status: 500,
          headers: { "content-type": "application/json" },
          body: '{"error":"boom"}',
        },
      }),
    );
    const r = fakeRoute();
    await fire("**/*.png", r.route as never);
    expect(r.calls).toEqual([
      {
        kind: "fulfill",
        args: {
          status: 500,
          headers: { "content-type": "application/json" },
          body: '{"error":"boom"}',
        },
      },
    ]);
    expect(table.list()).toEqual([{ ...info, hits: 1 }]);
  });

  test("modify：headers 用 headers() 做底、大小写不敏感、null 删除，url / method / postData 传下去", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(
      rule({
        action: {
          kind: "modify",
          method: "POST",
          url: "https://x.test/api/items",
          body: '{"a":1}',
          headers: {
            "X-Forwarded-For": "1.2.3.4",
            authorization: "Bearer new",
            Cookie: null,
          },
        },
      }),
    );
    const r = fakeRoute({
      headers: {
        Accept: "*/*",
        Authorization: "Bearer old",
        Cookie: "sid=abc",
        "X-Trace-Id": "t1",
      },
    });
    await fire("**/*.png", r.route as never);
    expect(r.calls).toEqual([
      {
        kind: "continue",
        args: {
          method: "POST",
          url: "https://x.test/api/items",
          postData: '{"a":1}',
          headers: {
            accept: "*/*",
            authorization: "Bearer new",
            "x-trace-id": "t1",
            "x-forwarded-for": "1.2.3.4",
          },
        },
      },
    ]);
  });

  test("modify：没给 headers 就不传这一项", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ action: { kind: "modify", body: "x" } }));
    const r = fakeRoute({ headers: { accept: "*/*" } });
    await fire("**/*.png", r.route as never);
    expect(r.calls).toEqual([{ kind: "continue", args: { postData: "x" } }]);
  });

  test("patch：替换文本、删 content-length，status 与 headers 各自生效", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(
      rule({
        action: {
          kind: "patch",
          status: 201,
          headers: { "content-security-policy": null, "X-Added": "1" },
          replace: [{ find: "旧", with: "新新" }],
        },
      }),
    );
    const res = {
      body: async () => Buffer.from("旧文字 旧", "utf8"),
      headers: () => ({
        "content-type": "text/html; charset=utf-8",
        "content-length": "13",
        "content-security-policy": "default-src 'self'",
      }),
    };
    const r = fakeRoute({}, { fetch: async () => res });
    await fire("**/*.png", r.route as never);
    const fulfill = r.calls.find((c) => c.kind === "fulfill");
    expect(fulfill?.args).toEqual({
      response: res,
      status: 201,
      headers: { "content-type": "text/html; charset=utf-8", "x-added": "1" },
      body: Buffer.from("新新文字 新新", "utf8"),
    });
  });

  test("patch：没有替换时不传 body，content-length 留着；只改状态码也行", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ action: { kind: "patch", status: 404 } }));
    const res = {
      body: async () => Buffer.from("keep", "utf8"),
      headers: () => ({ "content-length": "4" }),
    };
    const r = fakeRoute({}, { fetch: async () => res });
    await fire("**/*.png", r.route as never);
    expect(r.calls.find((c) => c.kind === "fulfill")?.args).toEqual({
      response: res,
      status: 404,
      headers: { "content-length": "4" },
    });
  });

  test("patch：二进制响应体不做替换，content-length 保留", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(
      rule({ action: { kind: "patch", replace: [{ find: "a", with: "b" }] } }),
    );
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    const res = {
      body: async () => bytes,
      headers: () => ({ "content-length": "4" }),
    };
    const r = fakeRoute({}, { fetch: async () => res });
    await fire("**/*.png", r.route as never);
    expect(r.calls.find((c) => c.kind === "fulfill")?.args).toEqual({
      response: res,
      headers: { "content-length": "4" },
    });
  });

  test("patch：find 为空串的规则忽略，全部出现处都替换", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(
      rule({
        action: {
          kind: "patch",
          replace: [
            { find: "", with: "X" },
            { find: "ab", with: "-" },
          ],
        },
      }),
    );
    const res = {
      body: async () => Buffer.from("ab-ab", "utf8"),
      headers: () => ({}),
    };
    const r = fakeRoute({}, { fetch: async () => res });
    await fire("**/*.png", r.route as never);
    expect(r.calls.find((c) => c.kind === "fulfill")?.args).toEqual({
      response: res,
      headers: {},
      body: Buffer.from("---", "utf8"),
    });
  });
});

describe("过滤与命中计数", () => {
  test("method 不符走 fallback，不计命中；相符才处理", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    const info = await table.add(
      rule({ method: "POST", action: { kind: "block" } }),
    );
    const wrong = fakeRoute({ method: "GET" });
    await fire("**/*.png", wrong.route as never);
    expect(wrong.calls).toEqual([{ kind: "fallback", args: undefined }]);
    expect(table.list()[0]?.hits).toBe(0);

    const right = fakeRoute({ method: "POST" });
    await fire("**/*.png", right.route as never);
    expect(right.calls).toEqual([{ kind: "abort", args: "failed" }]);
    expect(table.list()[0]).toEqual({ ...info, hits: 1 });
  });

  test("type 不符走 fallback，不计命中", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ type: "xhr", action: { kind: "block" } }));
    const wrong = fakeRoute({ type: "image" });
    await fire("**/*.png", wrong.route as never);
    expect(wrong.calls).toEqual([{ kind: "fallback", args: undefined }]);
    expect(table.list()[0]?.hits).toBe(0);
  });

  test("handler 内部抛错不外溢：abort 挂了也吞掉", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ action: { kind: "block" } }));
    const r = fakeRoute();
    r.route.abort = async () => {
      throw new Error("页面已关闭");
    };
    await expect(fire("**/*.png", r.route as never)).resolves.toBeUndefined();
    // 已经计过命中（处理过就算命中），但错误不外溢。
    expect(table.list()[0]?.hits).toBe(1);
  });

  test("页面关了再抛 fallback 也不外溢", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ action: { kind: "block" } }));
    const r = fakeRoute();
    r.route.abort = async () => {
      throw new Error("Target page, context or browser has been closed");
    };
    r.route.fallback = async () => {
      throw new Error("Route is already handled!");
    };
    await expect(fire("**/*.png", r.route as never)).resolves.toBeUndefined();
  });

  test("多次命中累加", async () => {
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ action: { kind: "block" } }));
    for (let i = 0; i < 3; i++)
      await fire("**/*.png", fakeRoute().route as never);
    expect(table.list()[0]?.hits).toBe(3);
  });
});

describe("delayMs", () => {
  afterEach(() => vi.useRealTimers());

  test("处理前等这么久", async () => {
    vi.useFakeTimers();
    const { page, fire } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ delayMs: 500, action: { kind: "block" } }));
    const r = fakeRoute();
    const running = fire("**/*.png", r.route as never);
    await vi.advanceTimersByTimeAsync(499);
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(r.calls).toEqual([{ kind: "abort", args: "failed" }]);
  });

  test("越界报错，不登记", async () => {
    const { page } = fakePage();
    const table = watchRoutes(page as never);
    await expect(
      table.add(rule({ delayMs: DELAY_MAX_MS + 1, action: { kind: "block" } })),
    ).rejects.toThrow("delayMs 要在 0–10000 之间");
    await expect(
      table.add(rule({ delayMs: -1, action: { kind: "block" } })),
    ).rejects.toThrow("delayMs 要在 0–10000 之间");
    await expect(
      table.add(rule({ delayMs: 1.5, action: { kind: "block" } })),
    ).rejects.toThrow("delayMs 要在 0–10000 之间");
    expect(table.list()).toEqual([]);
  });
});

describe("登记、删除与编号", () => {
  test("第 21 条报错", async () => {
    const { page } = fakePage();
    const table = watchRoutes(page as never);
    for (let i = 0; i < ROUTE_MAX; i++)
      await table.add(rule({ pattern: `**/a${i}`, action: { kind: "block" } }));
    await expect(
      table.add(rule({ pattern: "**/last", action: { kind: "block" } })),
    ).rejects.toThrow(`每个页面最多 ${ROUTE_MAX} 条拦截规则：先删掉不用的`);
    expect(table.list()).toHaveLength(ROUTE_MAX);
  });

  test("pattern 不合法：Playwright 报错第一行原样抛，不登记", async () => {
    const { page, calls } = fakePage({ badPattern: "**/{a" });
    const table = watchRoutes(page as never);
    await expect(
      table.add(rule({ pattern: "**/{a", action: { kind: "block" } })),
    ).rejects.toThrow("Invalid glob pattern \"**/{a\": unmatched '{'");
    expect(table.list()).toEqual([]);
    expect(calls).toEqual(["route **/{a"]);
  });

  test("remove 调 unroute；没有这个编号返回 false", async () => {
    const { page, calls, count } = fakePage();
    const table = watchRoutes(page as never);
    const info = await table.add(rule({ action: { kind: "block" } }));
    expect(count("**/*.png")).toBe(1);
    expect(await table.remove(info.id)).toBe(true);
    expect(await table.remove(info.id)).toBe(false);
    expect(count("**/*.png")).toBe(0);
    expect(calls).toEqual(["route **/*.png", "unroute **/*.png"]);
    expect(table.list()).toEqual([]);
  });

  test("clear 清掉全部、返回条数，编号继续递增", async () => {
    const { page, calls, count } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ pattern: "**/a", action: { kind: "block" } }));
    await table.add(rule({ pattern: "**/b", action: { kind: "block" } }));
    expect(await table.clear()).toBe(2);
    expect(count("**/a")).toBe(0);
    expect(count("**/b")).toBe(0);
    expect(table.list()).toEqual([]);
    expect(await table.clear()).toBe(0);
    const next = await table.add(
      rule({ pattern: "**/c", action: { kind: "block" } }),
    );
    expect(next.id).toBe(3);
    expect(calls.filter((c) => c.startsWith("unroute"))).toEqual([
      "unroute **/a",
      "unroute **/b",
    ]);
  });

  test("list 返回拷贝：改了它不影响内部状态", async () => {
    const { page } = fakePage();
    const table = watchRoutes(page as never);
    await table.add(rule({ action: { kind: "block" } }));
    const [first] = table.list();
    if (first) first.hits = 99;
    expect(table.list()[0]?.hits).toBe(0);
    expect(table.list()).toHaveLength(1);
    void noop;
  });
});
