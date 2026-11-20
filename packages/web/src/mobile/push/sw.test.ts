// @vitest-environment node
// service worker（public/sw.js）：在 vm 里用假的 self / caches / clients 跑真文件，核对外壳缓存与推送通知的行为。
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, test, vi } from "vitest";

const SRC = readFileSync(
  new URL("../../../public/sw.js", import.meta.url),
  "utf8",
);

type Handler = (e: Record<string, unknown>) => void;

function boot(opts: { network?: "ok" | "fail"; clients?: unknown[] } = {}) {
  const handlers = new Map<string, Handler>();
  const store = new Map<string, unknown>();
  const cache = {
    add: vi.fn(async (u: string) => void store.set(u, `net:${u}`)),
    put: vi.fn(async (k: string | { url: string }, v: unknown) => {
      store.set(typeof k === "string" ? k : new URL(k.url).pathname, v);
    }),
  };
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://h.test" },
    addEventListener: (t: string, h: Handler) => void handlers.set(t, h),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(async () => opts.clients ?? []),
      openWindow: vi.fn(async (u: string) => void opened.push(u)),
    },
    registration: {
      showNotification: vi.fn(
        async (title: string, options: Record<string, unknown>) => {
          shown.push({ title, options });
        },
      ),
    },
  };
  const fetchMock = vi.fn(async (req: { url: string }) => {
    if (opts.network === "fail") throw new Error("offline");
    // 路径带扩展名的当图片，其余当页面
    const type = /\.\w+$/.test(req.url)
      ? "image/png"
      : "text/html; charset=utf-8";
    return {
      ok: true,
      url: req.url,
      headers: { get: () => type },
      clone: () => ({ copy: req.url }),
    };
  });
  const caches = {
    open: async () => cache,
    keys: async () => [],
    delete: async () => true,
    match: vi.fn(async (k: string | { url: string }) =>
      store.get(typeof k === "string" ? k : new URL(k.url).pathname),
    ),
  };
  vm.runInNewContext(SRC, {
    self,
    caches,
    fetch: fetchMock,
    URL,
    Response: { error: () => "ERR" },
  });

  const waits: Promise<unknown>[] = [];
  const fire = async (type: string, e: Record<string, unknown>) => {
    const out: { responded?: Promise<unknown> } = {};
    handlers.get(type)?.({
      ...e,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<unknown>) => {
        out.responded = p;
      },
    });
    await Promise.all(waits.splice(0));
    return out.responded ? await out.responded : undefined;
  };
  const request = (
    path: string,
    init: { mode?: string; auth?: boolean; method?: string } = {},
  ) => ({
    url: `https://h.test${path}`,
    method: init.method ?? "GET",
    mode: init.mode ?? "same-origin",
    headers: {
      has: (h: string) => (init.auth ? h === "Authorization" : false),
    },
  });
  return { fire, request, cache, store, shown, opened, self, fetchMock };
}

describe("外壳缓存", () => {
  test("安装时桌面与手机各缓存自己的壳", async () => {
    const sw = boot();
    await sw.fire("install", {});
    expect([...sw.store.keys()].sort()).toEqual(["/", "/m/"]);
  });

  test("手机页面请求更新的是 /m/ 的壳，不会盖掉桌面那份；桌面同理", async () => {
    const sw = boot();
    await sw.fire("install", {});
    const desktop = sw.store.get("/");
    await sw.fire("fetch", {
      request: sw.request("/m/s/abc", { mode: "navigate" }),
    });
    expect(sw.store.get("/")).toBe(desktop);
    expect(sw.store.get("/m/")).toEqual({ copy: "https://h.test/m/s/abc" });
    await sw.fire("fetch", {
      request: sw.request("/settings/providers", { mode: "navigate" }),
    });
    expect(sw.store.get("/")).toEqual({
      copy: "https://h.test/settings/providers",
    });
    expect(sw.store.get("/m/")).toEqual({ copy: "https://h.test/m/s/abc" });
  });

  test("直接打开一张图标（导航到 /m/ 下的非页面资源）不会把它存成离线壳", async () => {
    const sw = boot();
    await sw.fire("install", {});
    const shell = sw.store.get("/m/");
    await sw.fire("fetch", {
      request: sw.request("/m/icon-192.png", { mode: "navigate" }),
    });
    expect(sw.store.get("/m/")).toBe(shell);
  });

  test("离线时各回各的壳", async () => {
    const sw = boot({ network: "fail" });
    sw.store.set("/", "DESKTOP");
    sw.store.set("/m/", "MOBILE");
    expect(
      await sw.fire("fetch", {
        request: sw.request("/m", { mode: "navigate" }),
      }),
    ).toBe("MOBILE");
    expect(
      await sw.fire("fetch", {
        request: sw.request("/", { mode: "navigate" }),
      }),
    ).toBe("DESKTOP");
  });

  test("/api 与带 Authorization 的请求、非 GET 一律放行：不拦、不缓存", async () => {
    const sw = boot();
    for (const r of [
      sw.request("/api/v1/sessions"),
      sw.request("/m/x.js", { auth: true }),
      sw.request("/m/x.js", { method: "POST" }),
    ]) {
      expect(await sw.fire("fetch", { request: r })).toBeUndefined();
    }
    expect(sw.cache.put).not.toHaveBeenCalled();
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });
});

describe("推送通知", () => {
  const push = (sw: ReturnType<typeof boot>, payload: unknown) =>
    sw.fire("push", { data: { json: () => payload } });

  test("三类事件各自显示一条通知：标题是类型、正文是会话标题、同会话同 tag、再次通知会重新提醒", async () => {
    const sw = boot();
    await push(sw, {
      v: 1,
      kind: "blocked",
      sid: "s1",
      title: "改登录",
      tag: "s:s1",
    });
    await push(sw, {
      v: 1,
      kind: "error",
      sid: "s1",
      title: "改登录",
      tag: "s:s1",
    });
    await push(sw, {
      v: 1,
      kind: "done",
      sid: "s1",
      title: "改登录",
      tag: "s:s1",
    });
    expect(sw.shown.map((n) => n.title)).toEqual([
      "需要你处理",
      "出错了",
      "已完成",
    ]);
    for (const n of sw.shown) {
      expect(n.options).toMatchObject({
        body: "改登录",
        tag: "s:s1",
        renotify: true,
        silent: false,
        data: { sid: "s1" },
      });
    }
    // 通知上不放按钮
    expect(sw.shown[0]?.options).not.toHaveProperty("actions");
  });

  test("resolved 用同一个 tag 替换成低调文案：静默、不重新提醒", async () => {
    const sw = boot();
    await push(sw, {
      v: 1,
      kind: "resolved",
      sid: "s1",
      title: "改登录",
      tag: "s:s1",
    });
    expect(sw.shown[0]).toMatchObject({
      title: "已处理",
      options: { tag: "s:s1", silent: true, renotify: false },
    });
  });

  test("每条 push 都必须显示通知：载荷坏了、没有载荷、类型未知也一样", async () => {
    const sw = boot();
    await sw.fire("push", {
      data: {
        json: () => {
          throw new Error("坏 JSON");
        },
      },
    });
    await sw.fire("push", { data: null });
    await push(sw, { v: 1, kind: "???", sid: 3, title: null });
    expect(sw.shown).toHaveLength(3);
    expect(
      sw.shown.every((n) => typeof n.title === "string" && n.title !== ""),
    ).toBe(true);
    expect(sw.shown[2]?.options).toMatchObject({
      body: "",
      data: { sid: "" },
      tag: "yuanshu",
    });
  });

  test("测试通知", async () => {
    const sw = boot();
    await push(sw, { v: 1, kind: "test", sid: "", title: "", tag: "test" });
    expect(sw.shown[0]).toMatchObject({
      title: "测试通知",
      options: { tag: "test" },
    });
  });
});

describe("点通知", () => {
  const click = (sw: ReturnType<typeof boot>, sid: string) => {
    const closed = vi.fn();
    return {
      closed,
      done: sw.fire("notificationclick", {
        notification: { close: closed, data: { sid } },
      }),
    };
  };
  const client = (path: string) => ({
    url: `https://h.test${path}`,
    postMessage: vi.fn(),
    focus: vi.fn(async () => undefined),
  });

  test("没有手机窗口：新开会话页（深链接，栈底由前端垫成列表）；通知先关掉", async () => {
    const sw = boot({ clients: [client("/settings/providers")] });
    const c = click(sw, "s 1");
    await c.done;
    expect(c.closed).toHaveBeenCalled();
    expect(sw.opened).toEqual(["/m/s/s%201"]);
  });

  test("已有手机窗口：聚焦它并让它切到那个会话，不再新开；桌面窗口不算", async () => {
    const desktop = client("/");
    const mobile = client("/m/");
    const sw = boot({ clients: [desktop, mobile] });
    await click(sw, "s1").done;
    expect(mobile.postMessage).toHaveBeenCalledWith({
      type: "open-session",
      sid: "s1",
    });
    expect(mobile.focus).toHaveBeenCalled();
    expect(desktop.postMessage).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([]);
  });

  test("路径只是以 /m 开头（如 /mark.svg）的窗口不算手机窗口", async () => {
    const icon = client("/mark.svg");
    const sw = boot({ clients: [icon] });
    await click(sw, "s1").done;
    expect(icon.postMessage).not.toHaveBeenCalled();
    expect(sw.opened).toEqual(["/m/s/s1"]);
  });

  test("没有会话（测试通知）：打开手机入口", async () => {
    const sw = boot();
    await click(sw, "").done;
    expect(sw.opened).toEqual(["/m/"]);
  });
});
