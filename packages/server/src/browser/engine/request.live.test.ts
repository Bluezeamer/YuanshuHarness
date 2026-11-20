// 真 Chromium 的请求出口：命名身份的隔离罐、Set-Cookie 写回、状态码原样、3xx 不跟随、二进制与连不上。
// YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过；站点由测试自己起的本地 HTTP 服务给，
// 经测试自己的代理转发（引擎的上下文只接受走代理）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { Engine } from "./engine.js";
import type { BrowserCtx, PageHandle } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";
const SITE = "site.test";

const BINARY = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f]);

interface Harness {
  proxyPort: number;
  /** 站点收到的请求，按顺序（方法、地址、头、体）。 */
  received: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>;
  close(): Promise<void>;
}

/** 最简 HTTP 代理：site.test → 本地站点，其余一律 502。CONNECT 也接（上下文的 request 会用它）。 */
async function startHarness(): Promise<Harness> {
  const received: Harness["received"] = [];
  const site = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://placeholder");
      received.push({
        method: req.method ?? "",
        url: `${url.pathname}${url.search}`,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (url.pathname === "/set") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "set-cookie": "sid=abc123; Path=/",
        });
        res.end("set");
        return;
      }
      if (url.pathname === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            headers: req.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        return;
      }
      if (url.pathname === "/redirect") {
        res.writeHead(302, { location: "/echo" });
        res.end();
        return;
      }
      if (url.pathname === "/two-cookies") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
        });
        res.end("two");
        return;
      }
      if (url.pathname === "/binary") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(BINARY);
        return;
      }
      if (url.pathname === "/drop") {
        // 响应还没给就把连接掐了：Playwright 抛错，工具层取第一行。
        res.destroy();
        return;
      }
      if (url.pathname === "/status") {
        const code = Number(url.searchParams.get("code") ?? "404");
        res.writeHead(code, { "content-type": "text/plain" });
        res.end(`status ${code}`);
        return;
      }
      res.writeHead(404).end("not found");
    });
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  const sitePort = (site.address() as AddressInfo).port;

  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.hostname !== SITE) {
      res.writeHead(502).end("unknown host");
      return;
    }
    const up = http.request(
      {
        host: "127.0.0.1",
        port: sitePort,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.writeHead(502).end("upstream"));
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  proxy.on("connect", (req, socket, head) => {
    const host = (req.url ?? "").split(":")[0];
    if (host !== SITE) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const up = net.connect(sitePort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    proxyPort,
    received,
    close: async () => {
      proxy.closeAllConnections();
      site.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await new Promise<void>((r) => site.close(() => r()));
    },
  };
}

describe.skipIf(!enabled)("请求出口（真实 Chromium）", () => {
  let engine: Engine;
  let harness: Harness;
  let ctx: BrowserCtx;
  let page: PageHandle;

  beforeAll(async () => {
    if (!enabled) return;
    harness = await startHarness();
    engine = new Engine({
      dataDir: makeTmpDir("ys-request-live-"),
      env: { ...process.env, YUANSHU_BROWSER: EXE },
      log: () => {},
    });
    ctx = await engine.context({
      proxy: {
        server: `http://127.0.0.1:${harness.proxyPort}`,
        username: "ctx-token",
        password: "proxy-pass",
      },
    });
    page = await ctx.newPage();
    await page.goto(`http://${SITE}/set`);
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    await ctx?.close().catch(() => {});
    await engine?.close().catch(() => {});
    await harness?.close().catch(() => {});
  });

  test("页面上下文的罐：/set 下发的 Set-Cookie 后续请求自动带上", async () => {
    const res = await page.request({
      url: `http://${SITE}/echo`,
      method: "GET",
      headers: {},
    });
    if (!res.ok) throw new Error(res.reason);
    const echoed = JSON.parse(res.bytes.toString("utf8")) as {
      headers: Record<string, string>;
    };
    expect(echoed.headers.cookie).toContain("sid=abc123");
  });

  test("POST：方法、头与 body 服务端原样收到", async () => {
    const res = await page.request({
      url: `http://${SITE}/echo?x=1`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Probe": "yes",
      },
      body: '{"a":1}',
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.bytes.toString("utf8")) as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(echoed.method).toBe("POST");
    expect(echoed.headers["content-type"]).toBe("application/json");
    expect(echoed.headers["x-probe"]).toBe("yes");
    expect(echoed.body).toBe('{"a":1}');
    // 没自动加 Referer / Origin
    expect(echoed.headers.referer).toBeUndefined();
    expect(echoed.headers.origin).toBeUndefined();
  });

  test("302 原样返回：状态码与 location 头都在，不自动跟随", async () => {
    const before = harness.received.length;
    const res = await page.request({
      url: `http://${SITE}/redirect`,
      method: "GET",
      headers: {},
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.status).toBe(302);
    expect(res.headers.find(([n]) => n === "location")?.[1]).toBe("/echo");
    // 只发了这一跳
    expect(harness.received.length).toBe(before + 1);
  });

  test("404 / 500 原样返回，不抛", async () => {
    for (const code of [404, 500]) {
      const res = await page.request({
        url: `http://${SITE}/status?code=${code}`,
        method: "GET",
        headers: {},
      });
      if (!res.ok) throw new Error(res.reason);
      expect(res.status).toBe(code);
    }
  });

  test("两条 Set-Cookie：响应头里两条都在", async () => {
    const res = await page.request({
      url: `http://${SITE}/two-cookies`,
      method: "GET",
      headers: {},
    });
    if (!res.ok) throw new Error(res.reason);
    const cookies = res.headers
      .filter(([n]) => n === "set-cookie")
      .map(([, v]) => v);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("a=1");
    expect(cookies[1]).toContain("b=2");
  });

  test("二进制响应字节一致", async () => {
    const res = await page.request({
      url: `http://${SITE}/binary`,
      method: "GET",
      headers: {},
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.bytes.equals(BINARY)).toBe(true);
  });

  test("连接被掐断：ok 为 false 并给 Playwright 报错的第一行", async () => {
    const res = await page.request({
      url: `http://${SITE}/drop`,
      method: "GET",
      headers: {},
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("应当失败");
    // 实测：ctx.request 的报错是 Node 层的 `apiRequestContext.fetch: socket hang up (ECONNRESET)`，
    // 不是浏览器的 net::ERR_*；第一行就够给模型定位。
    expect(res.reason).toContain("ECONNRESET");
    expect(res.reason).not.toContain("\n");
  });

  test("命名身份：不带页面罐里的 cookie，自己的 Set-Cookie 进自己的罐", async () => {
    // 页面罐里此刻有 sid=abc123（/set 下发的）
    const pageCookies = await page.cookies("all");
    expect(pageCookies.map((c) => c.name)).toContain("sid");

    const first = await page.request({
      url: `http://${SITE}/echo`,
      method: "GET",
      headers: {},
      identity: "bob",
    });
    if (!first.ok) throw new Error(first.reason);
    const echoed = JSON.parse(first.bytes.toString("utf8")) as {
      headers: Record<string, string>;
    };
    // 新罐是空的：没有页面的 sid
    expect(echoed.headers.cookie).toBeUndefined();

    // bob 自己登录：Set-Cookie 进 bob 的罐
    await page.request({
      url: `http://${SITE}/set`,
      method: "GET",
      headers: {},
      identity: "bob",
    });
    const again = await page.request({
      url: `http://${SITE}/echo`,
      method: "GET",
      headers: {},
      identity: "bob",
    });
    if (!again.ok) throw new Error(again.reason);
    const second = JSON.parse(again.bytes.toString("utf8")) as {
      headers: Record<string, string>;
    };
    expect(second.headers.cookie).toContain("sid=abc123");
    // bob 的 cookie 没写回页面的罐
    const after = await page.cookies("all");
    expect(after.filter((c) => c.value === "abc123")).toHaveLength(1);
    // 另一个身份看不到 bob 的
    const carol = await page.request({
      url: `http://${SITE}/echo`,
      method: "GET",
      headers: {},
      identity: "carol",
    });
    if (!carol.ok) throw new Error(carol.reason);
    const third = JSON.parse(carol.bytes.toString("utf8")) as {
      headers: Record<string, string>;
    };
    expect(third.headers.cookie).toBeUndefined();
  });

  test("命名身份与页面同一个 UA（request.newContext 的默认 UA 是 Playwright/…）", async () => {
    const pageUa = await page.exec("return navigator.userAgent", null);
    if (pageUa.kind !== "value") throw new Error("取不到 UA");
    const identityRes = await page.request({
      url: `http://${SITE}/echo`,
      method: "GET",
      headers: {},
      // 复用 bob 的罐：这里不为 UA 再多建一个身份（后面要数到 8 个）。
      identity: "bob",
    });
    if (!identityRes.ok) throw new Error(identityRes.reason);
    const echoed = JSON.parse(identityRes.bytes.toString("utf8")) as {
      headers: Record<string, string>;
    };
    expect(echoed.headers["user-agent"]).toBe(JSON.parse(pageUa.json));
    expect(echoed.headers["user-agent"]).not.toContain("Playwright/");
  });

  test("identityCookies：建过的给名字，没建过的是 null", async () => {
    expect(await page.identityCookies("bob")).toEqual(["sid"]);
    expect(await page.identityCookies("nobody")).toBeNull();
  });

  test("每个上下文最多 8 个命名身份：第 9 个报错", async () => {
    // bob、carol 已建；再建 6 个到 8 个
    for (const name of ["i3", "i4", "i5", "i6", "i7", "i8"]) {
      const r = await page.request({
        url: `http://${SITE}/echo`,
        method: "GET",
        headers: {},
        identity: name,
      });
      if (!r.ok) throw new Error(r.reason);
    }
    await expect(
      page.request({
        url: `http://${SITE}/echo`,
        method: "GET",
        headers: {},
        identity: "i9",
      }),
    ).rejects.toThrow("最多 8 个命名身份");
  });

  test("上下文关闭后命名身份被释放：同一个上下文里再用不了，新的上下文重新计数", async () => {
    await ctx.close();
    const fresh = await engine.context({
      proxy: {
        server: `http://127.0.0.1:${harness.proxyPort}`,
        username: "ctx-token",
        password: "proxy-pass",
      },
    });
    const p = await fresh.newPage();
    await p.goto(`http://${SITE}/echo`);
    for (const name of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]) {
      const r = await p.request({
        url: `http://${SITE}/echo`,
        method: "GET",
        headers: {},
        identity: name,
      });
      if (!r.ok) throw new Error(r.reason);
    }
    await expect(
      p.request({
        url: `http://${SITE}/echo`,
        method: "GET",
        headers: {},
        identity: "a9",
      }),
    ).rejects.toThrow("最多 8 个命名身份");
    await fresh.close();
  }, 60_000);
});
