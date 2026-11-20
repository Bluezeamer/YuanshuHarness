import { describe, expect, test } from "vitest";
import {
  authOf,
  clearCookie,
  createAuthHook,
  createSourceMatcher,
  extractToken,
  FailureLimiter,
  originAllowed,
  RATE_LIMIT_DEFAULTS,
  sessionCookie,
  tokenMatches,
} from "./auth.js";

describe("来源网段（R6）", () => {
  const m = createSourceMatcher(["192.168.1.0/24", "fd00::/8"]);

  test("IPv4 与 IPv6 命中和不命中", () => {
    expect(m("192.168.1.5")).toBe(true);
    expect(m("192.168.2.5")).toBe(false);
    expect(m("fd12::1")).toBe(true);
    expect(m("fe80::1")).toBe(false);
  });

  test("IPv4 映射的 IPv6 地址按 IPv4 比对", () => {
    expect(m("::ffff:192.168.1.5")).toBe(true);
    expect(m("::ffff:10.0.0.1")).toBe(false);
  });

  test("带 zone 的链路本地地址去掉 zone 再比对；无地址或非法一律不命中", () => {
    expect(createSourceMatcher(["fe80::/10"])("fe80::1%eth0")).toBe(true);
    expect(m(undefined)).toBe(false);
    expect(m("not-an-ip")).toBe(false);
  });
});

describe("令牌提取（R8）", () => {
  test("Authorization: Bearer", () => {
    expect(extractToken({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractToken({ authorization: "bearer abc" })).toBe("abc");
  });

  test.each([
    ["空 Bearer", { authorization: "Bearer " }],
    ["Basic", { authorization: "Basic abc" }],
    ["多段", { authorization: "Bearer a b" }],
    ["无头", {}],
  ])("%s 取不到令牌", (_n, h) => {
    expect(extractToken(h)).toBeUndefined();
  });

  test("会话 Cookie 也能带令牌（HTML 预览的 iframe 子请求只能靠它）", () => {
    const tok = "a".repeat(40);
    expect(extractToken({ cookie: `ys_session=${tok}` })).toBe(tok);
    // 混在别的 Cookie 里、带空格也认
    expect(extractToken({ cookie: `x=1; ys_session=${tok}; y=2` })).toBe(tok);
    // 形状不合规的当作没有；别的 Cookie 名不认
    expect(extractToken({ cookie: "ys_session=short" })).toBeUndefined();
    expect(extractToken({ cookie: `other=${tok}` })).toBeUndefined();
    // Bearer 优先于 Cookie
    expect(
      extractToken({
        authorization: "Bearer bbb",
        cookie: `ys_session=${tok}`,
      }),
    ).toBe("bbb");
  });

  test("会话 Cookie 头带 HttpOnly 与 SameSite", () => {
    const v = sessionCookie("t".repeat(40));
    expect(v).toContain("ys_session=");
    expect(v).toContain("HttpOnly");
    expect(v).toContain("SameSite=Lax");
    expect(v).toContain("Path=/");
    expect(clearCookie()).toContain("Max-Age=0");
  });

  test("子协议只在 WebSocket 升级请求里生效", () => {
    const proto = "yuanshu.v1, bearer.tok";
    expect(
      extractToken({ upgrade: "websocket", "sec-websocket-protocol": proto }),
    ).toBe("tok");
    expect(extractToken({ "sec-websocket-protocol": proto })).toBeUndefined();
    expect(
      extractToken({
        upgrade: "websocket",
        "sec-websocket-protocol": "yuanshu.v1, bearer.",
      }),
    ).toBeUndefined();
  });
});

describe("令牌比较（R9）", () => {
  test("相等通过；长度不同、同长度不同内容均拒绝", () => {
    const t = "a".repeat(40);
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(t, t.slice(1))).toBe(false);
    expect(tokenMatches(t, `${t}x`)).toBe(false);
    expect(tokenMatches(t, `${"a".repeat(39)}b`)).toBe(false);
    expect(tokenMatches(t, "")).toBe(false);
  });
});

describe("失败限流（R11、R12）", () => {
  const make = (over: Partial<typeof RATE_LIMIT_DEFAULTS> = {}) => {
    const clock = { t: 1_000_000 };
    const l = new FailureLimiter({
      ...RATE_LIMIT_DEFAULTS,
      ...over,
      now: () => clock.t,
    });
    return { clock, l };
  };
  const failN = (l: FailureLimiter, src: string, n: number) => {
    for (let i = 0; i < n; i++) l.fail(src);
  };

  test("9 次失败未封禁，第 10 次起封 60 秒，Retry-After 向上取整", () => {
    const { clock, l } = make();
    failN(l, "a", 9);
    expect(l.blockedFor("a")).toBe(0);
    l.fail("a");
    expect(l.blockedFor("a")).toBe(60);
    clock.t += 59_500;
    expect(l.blockedFor("a")).toBe(1);
  });

  test("封禁期内不延长；到期后从零重新计数", () => {
    const { clock, l } = make();
    failN(l, "a", 10);
    clock.t += 30_000;
    // 调用方在封禁期内不会再 fail；即便调用，也不应延长封禁
    expect(l.blockedFor("a")).toBe(30);
    clock.t += 30_000;
    expect(l.blockedFor("a")).toBe(0);
    failN(l, "a", 9);
    expect(l.blockedFor("a")).toBe(0);
    l.fail("a");
    expect(l.blockedFor("a")).toBe(60);
  });

  test("成功清零连续失败计数", () => {
    const { l } = make();
    failN(l, "a", 9);
    l.succeed("a");
    failN(l, "a", 9);
    expect(l.blockedFor("a")).toBe(0);
  });

  test("距上次失败超过 10 分钟的记录视为过期", () => {
    const { clock, l } = make();
    failN(l, "a", 9);
    clock.t += 10 * 60_000 + 1;
    l.fail("a");
    expect(l.blockedFor("a")).toBe(0);
    failN(l, "a", 8);
    expect(l.blockedFor("a")).toBe(0);
  });

  test("来源之间互不影响", () => {
    const { l } = make();
    failN(l, "a", 10);
    expect(l.blockedFor("a")).toBeGreaterThan(0);
    expect(l.blockedFor("b")).toBe(0);
  });

  test("表满时先丢过期项", () => {
    const { clock, l } = make({ capacity: 3 });
    failN(l, "old", 10);
    clock.t += 10 * 60_000 + 1;
    l.fail("b");
    l.fail("c");
    l.fail("d");
    expect(l.size).toBe(3);
    expect(l.blockedFor("old")).toBe(0);
  });

  test("仍满则丢最早插入的一项（含被封禁的），新项保留", () => {
    const { l } = make({ capacity: 3 });
    failN(l, "a", 10);
    l.fail("b");
    l.fail("c");
    expect(l.blockedFor("a")).toBeGreaterThan(0);
    failN(l, "d", 10);
    expect(l.size).toBe(3);
    expect(l.blockedFor("a")).toBe(0);
    expect(l.blockedFor("d")).toBeGreaterThan(0);
    failN(l, "b", 8);
    expect(l.blockedFor("b")).toBe(0);
    l.fail("b");
    expect(l.blockedFor("b")).toBeGreaterThan(0);
  });

  test("恰好 10 分钟不算过期，超过才算", () => {
    const { clock, l } = make();
    failN(l, "a", 9);
    clock.t += 10 * 60_000;
    l.fail("a");
    expect(l.blockedFor("a")).toBeGreaterThan(0);
  });

  test("表内无定时器：构造与使用不留下活动句柄", () => {
    const before = process
      .getActiveResourcesInfo()
      .filter((x) => x === "Timeout");
    const { l } = make();
    failN(l, "a", 10);
    const after = process
      .getActiveResourcesInfo()
      .filter((x) => x === "Timeout");
    expect(after.length).toBe(before.length);
  });
});

describe("hook 检查顺序（R5、R7）", () => {
  const call = async (
    h: ReturnType<typeof createAuthHook>,
    remoteAddress: string,
    authorization?: string,
  ) => {
    let code = 0;
    const reply: Record<string, unknown> = {
      code(c: number) {
        code = c;
        return reply;
      },
      header: () => reply,
      send: () => reply,
    };
    await h.hook(
      {
        socket: { remoteAddress },
        headers: authorization ? { authorization } : {},
        routeOptions: { config: {} },
      } as never,
      reply as never,
    );
    return code;
  };

  test("网段外的请求得 403，且不计入失败，也不触发 429", async () => {
    const h = createAuthHook({
      token: "t".repeat(40),
      allowCidrs: ["10.0.0.0/8"],
    });
    for (let i = 0; i < 15; i++)
      expect(await call(h, "192.168.0.1", "Bearer wrong")).toBe(403);
    expect(h.limiter.size).toBe(0);
    // 同一个"来源"若在网段内，计数从零开始，而不是已被前面的 403 推到封禁
    for (let i = 0; i < 9; i++)
      expect(await call(h, "10.1.1.1", "Bearer wrong")).toBe(401);
  });

  test("设备令牌：全局令牌不匹配时再查设备，并把身份记在请求上", async () => {
    const phone = {
      id: "d1",
      name: "手机",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    };
    const devices = {
      verify: (t: string) => (t === "device-token" ? phone : null),
    };
    const h = createAuthHook({
      token: "t".repeat(40),
      allowCidrs: [],
      devices,
    });

    const run = async (authorization?: string) => {
      let code = 0;
      const reply: Record<string, unknown> = {
        code(c: number) {
          code = c;
          return reply;
        },
        header: () => reply,
        send: () => reply,
      };
      const req = {
        socket: { remoteAddress: "127.0.0.1" },
        headers: authorization ? { authorization } : {},
        routeOptions: { config: {} },
      } as never;
      await h.hook(req, reply as never);
      return { code, info: authOf(req) };
    };

    expect(await run(`Bearer ${"t".repeat(40)}`)).toEqual({
      code: 0,
      info: { kind: "global" },
    });
    expect(await run("Bearer device-token")).toEqual({
      code: 0,
      info: { kind: "device", device: phone },
    });
    const bad = await run("Bearer nope");
    expect(bad.code).toBe(401);
    // 没通过认证就没有身份记录，authOf 回落到全局（回环模式）
    expect(bad.info).toEqual({ kind: "global" });
  });

  test("公开路由不要求令牌、不计失败；网段与 Origin 仍照查", async () => {
    const h = createAuthHook({ token: "t".repeat(40), allowCidrs: [] });
    const run = async (
      config: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) => {
      let code = 0;
      const reply: Record<string, unknown> = {
        code(c: number) {
          code = c;
          return reply;
        },
        header: () => reply,
        send: () => reply,
      };
      await h.hook(
        {
          socket: { remoteAddress: "127.0.0.1" },
          headers,
          log: { warn: () => {} },
          routeOptions: { config },
        } as never,
        reply as never,
      );
      return code;
    };

    // 不带令牌也放行，连续多次都不进失败计数
    for (let i = 0; i < 15; i++) expect(await run({ public: true })).toBe(0);
    expect(h.limiter.size).toBe(0);
    // 普通路由仍然 401
    expect(await run({})).toBe(401);
    // 公开路由的 Origin 不符照样 403
    expect(await run({ public: true }, { origin: "http://evil.example" })).toBe(
      403,
    );

    const outside = createAuthHook({
      token: "t".repeat(40),
      allowCidrs: ["10.0.0.0/8"],
    });
    let code = 0;
    const reply: Record<string, unknown> = {
      code(c: number) {
        code = c;
        return reply;
      },
      header: () => reply,
      send: () => reply,
    };
    await outside.hook(
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {},
        routeOptions: { config: { public: true } },
      } as never,
      reply as never,
    );
    expect(code).toBe(403);
  });
});

describe("来源校验 originAllowed", () => {
  const none = new Set<string>();
  const ok = (h: Parameters<typeof originAllowed>[0], t = none) =>
    originAllowed(h, t);

  test("没有 Origin 放行；Origin 与 Host 同主机同端口放行（大小写不敏感）", () => {
    expect(ok({ host: "devbox:7420" })).toBe(true);
    expect(ok({ origin: "http://devbox:7420", host: "devbox:7420" })).toBe(
      true,
    );
    expect(ok({ origin: "http://DevBox:7420", host: "devbox:7420" })).toBe(
      true,
    );
    expect(
      ok({ origin: "https://ys.example.com", host: "ys.example.com" }),
    ).toBe(true);
    expect(ok({ origin: "http://[::1]:7420", host: "[::1]:7420" })).toBe(true);
  });

  test("同主机别的端口、别的主机、null、坏值与重复头都不放行", () => {
    for (const origin of [
      "http://devbox:7500",
      "http://evil.example:7420",
      "null",
      "devbox:7420",
      "",
    ])
      expect(ok({ origin, host: "devbox:7420" }), origin).toBe(false);
    expect(
      ok({ origin: ["http://devbox:7420", "x"], host: "devbox:7420" }),
    ).toBe(false);
  });

  test("X-Forwarded-Host 取第一项；受信来源清单按 origin 逐字比", () => {
    expect(
      ok({
        origin: "https://ys.example.com",
        host: "127.0.0.1:7420",
        "x-forwarded-host": "ys.example.com, proxy.local",
      }),
    ).toBe(true);
    const trusted = new Set(["https://ys.example.com"]);
    expect(
      ok({ origin: "https://ys.example.com", host: "127.0.0.1:7420" }, trusted),
    ).toBe(true);
    expect(
      ok({ origin: "http://ys.example.com", host: "127.0.0.1:7420" }, trusted),
    ).toBe(false);
  });
});
