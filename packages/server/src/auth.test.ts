import { describe, expect, test } from "vitest";
import {
  createAuthHook,
  createSourceMatcher,
  extractToken,
  FailureLimiter,
  RATE_LIMIT_DEFAULTS,
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
});
