import { describe, expect, test } from "vitest";
import type { ConsoleEntry, PageView } from "../../../../api/browser";
import { pageView } from "../../browser/testkit";
import {
  addressOf,
  clipPreview,
  currentPage,
  forwardBlocked,
  forwardUrl,
  groupPages,
  isSecure,
  mergeConsole,
  pageName,
  portRows,
  statusOf,
  usedByNames,
} from "./model";

const names: Record<string, string> = { server: "本机", gpu1: "gpu1" };
const hostName = (id: string) => names[id] ?? id;

// 测试里页面名、地址都按「没起标题的 example.com」来，只在用例里覆盖要紧的字段。
const page = (over: Partial<PageView> = {}): PageView =>
  pageView({
    title: "",
    url: "https://example.com/",
    workspaceKey: "w1",
    ...over,
  });

describe("addressOf", () => {
  test("服务地址：主机名:端口 + 路径；根路径不带斜杠", () => {
    expect(addressOf("http://gpu1.localhost:3000/", hostName)).toEqual({
      text: "gpu1:3000",
      kind: "service",
    });
    expect(addressOf("http://gpu1.localhost:5173/a/b?x=1", hostName).text).toBe(
      "gpu1:5173/a/b?x=1",
    );
    // 本机的标签是 server，换成界面上的主机名
    expect(addressOf("http://server.localhost:8080/", hostName).text).toBe(
      "本机:8080",
    );
  });

  test("文件地址：主机名:绝对路径，路径解码", () => {
    expect(
      addressOf(
        "http://server.files.localhost/w/%E6%96%87%E6%A1%A3.html",
        hostName,
      ),
    ).toEqual({ text: "本机:/w/文档.html", kind: "file" });
  });

  test("公网地址去掉协议头；空白与解析不了的原样处理", () => {
    expect(addressOf("https://example.com/docs?a=1", hostName)).toEqual({
      text: "example.com/docs?a=1",
      kind: "public",
    });
    expect(addressOf("", hostName).kind).toBe("blank");
    expect(addressOf("about:blank", hostName).kind).toBe("blank");
    expect(addressOf("not a url", hostName)).toEqual({
      text: "not a url",
      kind: "public",
    });
  });

  test("名字像虚拟主机但不是（多一级子域）按公网处理", () => {
    expect(addressOf("http://a.b.localhost:3000/", hostName).kind).toBe(
      "public",
    );
  });
});

test("pageName：有标题用标题，否则用地址，都没有叫空白页", () => {
  expect(pageName({ title: "注册页", url: "x" }, hostName)).toBe("注册页");
  expect(
    pageName({ title: "  ", url: "http://gpu1.localhost:3000/" }, hostName),
  ).toBe("gpu1:3000");
  expect(pageName({ title: "", url: "about:blank" }, hostName)).toBe("空白页");
});

test("statusOf：休眠优先，其次你在操作，否则 agent", () => {
  expect(statusOf({ state: "sleeping", controller: "user" })).toBe("sleeping");
  expect(statusOf({ state: "active", controller: "user" })).toBe("user");
  expect(statusOf({ state: "active", controller: "agent" })).toBe("agent");
});

describe("groupPages", () => {
  test("你自己开的页面在「我的」，不管谁用过；没有会话的 agent 页面也放这里", () => {
    const mine = page({ userOpened: true, controller: "user", usedBy: ["s1"] });
    const orphan = page();
    const g = groupPages([mine, orphan]);
    expect(g).toHaveLength(1);
    expect(g[0]?.key).toBe("mine");
    expect(g[0]?.pages.map((p) => p.id).sort()).toEqual(
      [mine.id, orphan.id].sort(),
    );
  });

  test("agent 页面按最后使用的会话分组：在用的优先，否则用过的最后一个", () => {
    const a = page({ usedBy: ["s1", "s2"], inUseBy: "s1" });
    const b = page({ usedBy: ["s1", "s2"] });
    const g = groupPages([a, b]);
    expect(g.map((x) => x.key)).toEqual(["mine", "s1", "s2"]);
    expect(g[1]?.pages).toEqual([a]);
    expect(g[2]?.pages).toEqual([b]);
  });

  test("「我的」在最前，会话组按组内最近使用倒序", () => {
    const old = page({
      usedBy: ["s1"],
      lastUsedAt: "2026-11-12T01:00:00.000Z",
    });
    const recent = page({
      usedBy: ["s2"],
      lastUsedAt: "2026-11-12T03:00:00.000Z",
    });
    const mid = page({
      usedBy: ["s1"],
      lastUsedAt: "2026-11-12T02:00:00.000Z",
    });
    expect(groupPages([old, recent, mid]).map((g) => g.key)).toEqual([
      "mine",
      "s2",
      "s1",
    ]);
  });

  test("组内最近使用在前，休眠的排在组尾", () => {
    const first = page({
      usedBy: ["s1"],
      lastUsedAt: "2026-11-12T01:00:00.000Z",
    });
    const second = page({
      usedBy: ["s1"],
      lastUsedAt: "2026-11-12T02:00:00.000Z",
    });
    const asleep = page({
      usedBy: ["s1"],
      state: "sleeping",
      lastUsedAt: "2026-11-12T05:00:00.000Z",
    });
    const g = groupPages([first, asleep, second]);
    expect(g[1]?.pages).toEqual([second, first, asleep]);
  });

  test("没有页面也有「我的」组", () => {
    expect(groupPages([])).toEqual([
      { key: "mine", sessionId: null, pages: [] },
    ]);
  });
});

describe("currentPage", () => {
  test("标签记着的页面在就用它", () => {
    const a = page();
    const b = page({ lastUsedAt: "2026-11-12T09:00:00.000Z" });
    expect(currentPage([a, b], a.id)).toBe(a);
  });

  test("它没了：用最近用过的激活页，激活页都没有才用休眠页", () => {
    const old = page({ lastUsedAt: "2026-11-12T01:00:00.000Z" });
    const recent = page({ lastUsedAt: "2026-11-12T02:00:00.000Z" });
    const asleep = page({
      state: "sleeping",
      lastUsedAt: "2026-11-12T09:00:00.000Z",
    });
    expect(currentPage([old, asleep, recent], "gone")).toBe(recent);
    expect(currentPage([asleep], undefined)).toBe(asleep);
    expect(currentPage([], "x")).toBeNull();
  });
});

test("usedByNames：只有你自己的页面才标「某会话用过」", () => {
  const title = (sid: string) => `会话 ${sid}`;
  expect(
    usedByNames({ userOpened: true, usedBy: ["s1", "s2"] }, title),
  ).toEqual(["会话 s1", "会话 s2"]);
  expect(usedByNames({ userOpened: false, usedBy: ["s1"] }, title)).toEqual([]);
});

test("isSecure：只有 https 算加密", () => {
  expect(isSecure("https://example.com/")).toBe(true);
  expect(isSecure("http://example.com/")).toBe(false);
  expect(isSecure("http://gpu1.localhost:3000/")).toBe(false);
});

describe("mergeConsole", () => {
  const e = (id: number, text: string, count = 1): ConsoleEntry => ({
    id,
    ts: id,
    firstTs: id,
    count,
    kind: "console",
    level: "log",
    text,
  });

  test("历史在前、实时接后，同一组只留一份", () => {
    const a = e(1, "a");
    const b = e(2, "b");
    const c = e(3, "c");
    expect(mergeConsole([a, b], [b, c])).toEqual([a, b, c]);
  });

  test("同一组再出现：次数以实时的为准，位置仍在首次出现处", () => {
    const a = e(1, "a");
    const b = e(2, "b");
    const a3 = e(1, "a", 3);
    expect(mergeConsole([a, b], [a3])).toEqual([a3, b]);
  });

  test("没有历史或没有实时条目", () => {
    const a = e(1, "a");
    expect(mergeConsole([a], [])).toEqual([a]);
    expect(mergeConsole([], [a])).toEqual([a]);
  });
});

describe("转发出来的服务", () => {
  test("地址：http + 访问 Server 的主机名 + 转发端口（IPv6 字面量带方括号照传）", () => {
    expect(
      forwardUrl(
        { localPort: 7501 },
        { protocol: "http:", hostname: "devbox" },
      ),
    ).toBe("http://devbox:7501/");
    expect(
      forwardUrl(
        { localPort: 7501 },
        { protocol: "http:", hostname: "[fd00::1]" },
      ),
    ).toBe("http://[fd00::1]:7501/");
  });

  test("控制台是 https 时不提供，给出原因；http 不拦", () => {
    expect(forwardBlocked("https:")).toContain("https");
    expect(forwardBlocked("http:")).toBeNull();
  });
});

describe("portRows", () => {
  const port = (envId: string, p: number) => ({
    envId,
    port: p,
    target: `${envId === "local" ? "server" : envId}:${p}`,
  });
  const fwd = (envId: string, p: number, localPort: number) => ({
    id: `f${localPort}`,
    envId,
    port: p,
    target: `${envId === "local" ? "server" : envId}:${p}`,
    localPort,
    listening: true,
  });

  test("同一个端口检测到又转发了并成一行；只检测到的、只转发的各自一行", () => {
    const rows = portRows(
      [port("local", 3000), port("local", 5173)],
      [fwd("local", 3000, 7500), fwd("local", 9000, 7501)],
    );
    expect(
      rows.map((r) => [r.key, r.detected, r.forward?.localPort ?? null]),
    ).toEqual([
      ["local:3000", true, 7500],
      ["local:5173", true, null],
      ["local:9000", false, 7501],
    ]);
  });

  test("按环境再按端口数值排序（不是字符串序）", () => {
    const rows = portRows(
      [port("box", 8080), port("box", 900), port("a", 3000)],
      [],
    );
    expect(rows.map((r) => r.key)).toEqual(["a:3000", "box:900", "box:8080"]);
  });

  test("不同环境的同一端口不并；没有任何端口时是空清单", () => {
    expect(
      portRows([port("local", 3000)], [fwd("box", 3000, 7500)]).map(
        (r) => r.key,
      ),
    ).toEqual(["box:3000", "local:3000"]);
    expect(portRows([], [])).toEqual([]);
  });
});

describe("clipPreview", () => {
  test("空白折成一格，超长截断", () => {
    expect(clipPreview("  a \n\n b\t c ")).toBe("a b c");
    expect(clipPreview("x".repeat(61))).toBe(`${"x".repeat(60)}…`);
    expect(clipPreview("x".repeat(60))).toBe("x".repeat(60));
  });
});
