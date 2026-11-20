// 站点判定、按站点挑状态、合并、指纹：全是纯函数。
import { expect, test } from "vitest";
import type { StorageState } from "../engine/types.js";
import { countOf, fingerprint, mergeStates, pickSite, siteOf } from "./site.js";

const cookie = (
  domain: string,
  name = "sid",
  value = "v",
  over: Partial<StorageState["cookies"][number]> = {},
) => ({
  domain,
  name,
  value,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
  ...over,
});

const origin = (
  url: string,
  storage: Array<{ name: string; value: string }>,
) => ({
  origin: url,
  localStorage: storage,
});

test("siteOf：注册域、公共后缀、IDN", () => {
  expect(siteOf("https://accounts.google.com/signin")).toBe("google.com");
  expect(siteOf("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
  // github.io 是公共后缀：每个用户子域各自一个站点
  expect(siteOf("https://foo.github.io/x")).toBe("foo.github.io");
  expect(siteOf("https://例子.中国/")).toBe("xn--fsqu00a.xn--fiqs8s");
  expect(siteOf("http://EXAMPLE.com:8080/")).toBe("example.com");
});

test("siteOf：本机、IP、单标签主机名、非 http(s) 与非法地址都是 null", () => {
  for (const url of [
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://intranet/",
    "file:///etc/hosts",
    "about:blank",
    "data:text/html,x",
    "不是地址",
    "",
  ])
    expect(siteOf(url)).toBeNull();
});

test("pickSite：带前导点的 domain、子域都算，后缀匹配带点边界", () => {
  const state: StorageState = {
    cookies: [
      cookie(".google.com", "a"),
      cookie("mail.google.com", "b"),
      cookie("google.com", "c"),
      cookie("evilgoogle.com", "d"),
      cookie("google.com.evil.com", "e"),
    ],
    origins: [
      origin("https://google.com", [{ name: "k", value: "v" }]),
      origin("https://mail.google.com", []),
      origin("https://evilgoogle.com", []),
      origin("https://google.com.evil.com", []),
    ],
  };
  const picked = pickSite(state, "google.com");
  expect(picked.cookies.map((c) => c.name)).toEqual(["a", "b", "c"]);
  expect(picked.origins.map((o) => o.origin)).toEqual([
    "https://google.com",
    "https://mail.google.com",
  ]);
  // localStorage 原样保留
  expect(picked.origins[0]?.localStorage).toEqual([{ name: "k", value: "v" }]);
  expect(countOf(picked)).toEqual({ cookies: 3, origins: 2 });
});

test("mergeStates：各自拼接，不去重", () => {
  const a: StorageState = {
    cookies: [cookie(".a.test")],
    origins: [origin("https://a.test", [])],
  };
  const b: StorageState = {
    cookies: [cookie(".b.test"), cookie(".b.test")],
    origins: [origin("https://b.test", [{ name: "k", value: "v" }])],
  };
  expect(mergeStates([a, b])).toEqual({
    cookies: [...a.cookies, ...b.cookies],
    origins: [...a.origins, ...b.origins],
  });
  expect(mergeStates([])).toEqual({ cookies: [], origins: [] });
  expect(countOf(mergeStates([]))).toEqual({ cookies: 0, origins: 0 });
});

test("fingerprint：顺序无关，cookie 的值与新增算变，localStorage 只看 key", () => {
  const base: StorageState = {
    cookies: [cookie(".a.test", "x", "1"), cookie(".a.test", "y", "2")],
    origins: [origin("https://a.test", [{ name: "k", value: "v" }])],
  };
  const reordered: StorageState = {
    cookies: [cookie(".a.test", "y", "2"), cookie(".a.test", "x", "1")],
    origins: [origin("https://a.test", [{ name: "k", value: "v" }])],
  };
  expect(fingerprint(reordered)).toBe(fingerprint(base));

  // 只变 value：算出新的（值参与哈希）
  expect(
    fingerprint({
      ...base,
      cookies: [cookie(".a.test", "x", "changed"), cookie(".a.test", "y", "2")],
    }),
  ).not.toBe(fingerprint(base));
  // 新增 cookie
  expect(
    fingerprint({
      ...base,
      cookies: [...base.cookies, cookie(".a.test", "z")],
    }),
  ).not.toBe(fingerprint(base));
  // localStorage 只变 value：不变
  expect(
    fingerprint({
      ...base,
      origins: [origin("https://a.test", [{ name: "k", value: "changed" }])],
    }),
  ).toBe(fingerprint(base));
  // localStorage 新增 key：变
  expect(
    fingerprint({
      ...base,
      origins: [
        origin("https://a.test", [
          { name: "k", value: "v" },
          { name: "n", value: "" },
        ]),
      ],
    }),
  ).not.toBe(fingerprint(base));
  // expires 不参与
  expect(
    fingerprint({
      ...base,
      cookies: [
        cookie(".a.test", "x", "1", { expires: 999 }),
        cookie(".a.test", "y", "2"),
      ],
    }),
  ).toBe(fingerprint(base));
});
