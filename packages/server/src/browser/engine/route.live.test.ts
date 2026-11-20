// 请求拦截与改写的真浏览器端到端：四种动作、过滤、延时、后加的先匹配、删除后恢复。
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

// 夹具：一张图、一个脚本、一个 JSON 接口、一个照原样回显请求的接口、一个带 CSP 的页面。
const PAGE = `<!doctype html><meta charset=utf-8><title>拦截页</title>
<img id="pic" src="/pic.png" alt="图" onerror="window.__imgError = true">
<script src="/app.js"></script>`;

const APP_JS = `window.__script = "loaded";`;

const CSP_PAGE = `<!doctype html><meta charset=utf-8><title>带 CSP 的页</title>
<p id="text">ORIGINAL-TEXT</p>`;

interface Harness {
  proxyPort: number;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      if (url.pathname === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(APP_JS);
        return;
      }
      if (url.pathname === "/pic.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
        return;
      }
      if (url.pathname === "/api/items") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [1, 2, 3] }));
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
      if (url.pathname === "/csp") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'",
        });
        res.end(CSP_PAGE);
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
    close: async () => {
      proxy.closeAllConnections();
      site.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await new Promise<void>((r) => site.close(() => r()));
    },
  };
}

/** exec 的返回值：出错就让测试直接失败（比拿到 undefined 好查）。 */
async function value<T>(page: PageHandle, script: string): Promise<T> {
  const out = await page.exec(script, null);
  if (out.kind === "threw") throw new Error(out.message);
  return JSON.parse(out.json) as T;
}

describe.skipIf(!enabled)("请求拦截与改写（真实 Chromium）", () => {
  let engine: Engine;
  let harness: Harness;
  let ctx: BrowserCtx;

  const base = (path = "/") => `http://${SITE}${path}`;

  beforeAll(async () => {
    if (!enabled) return;
    harness = await startHarness();
    engine = new Engine({
      dataDir: makeTmpDir("ys-route-live-"),
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
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    await ctx?.close().catch(() => {});
    await engine?.close().catch(() => {});
    await harness?.close().catch(() => {});
  });

  test("block：图片加载失败", async () => {
    const page = await ctx.newPage();
    await page.routeAdd({ pattern: "**/pic.png", action: { kind: "block" } });
    await page.goto(base());
    const state = await value<{ err: boolean; w: number }>(
      page,
      `const img = document.querySelector("#pic");
       return { err: window.__imgError === true, w: img ? img.naturalWidth : -1 }`,
    );
    expect(state).toEqual({ err: true, w: 0 });
    await page.close();
  });

  test("mock：fetch 拿到造出来的 500 与 body", async () => {
    const page = await ctx.newPage();
    await page.goto(base());
    await page.routeAdd({
      pattern: "**/api/items",
      type: "fetch",
      action: {
        kind: "mock",
        status: 500,
        headers: { "content-type": "application/json" },
        body: '{"error":"mock"}',
      },
    });
    const res = await value<{ status: number; text: string }>(
      page,
      `const r = await fetch("/api/items");
       return { status: r.status, text: await r.text() }`,
    );
    expect(res).toEqual({ status: 500, text: '{"error":"mock"}' });
    await page.close();
  });

  test("modify：加头、删头、改方法与请求体，服务端回显验证", async () => {
    const page = await ctx.newPage();
    await page.goto(base());
    await page.routeAdd({
      pattern: "**/echo",
      action: {
        kind: "modify",
        method: "POST",
        body: "changed=1",
        // 头名大小写不敏感：请求里是 X-Drop-Me，规则里写小写也删得掉。
        headers: { "x-forwarded-for": "1.2.3.4", "x-drop-me": null },
      },
    });
    const echoed = await value<{
      method: string;
      headers: Record<string, string>;
      body: string;
    }>(
      page,
      `const r = await fetch("/echo", { headers: { "X-Drop-Me": "yes", "X-Keep": "ok" } });
       return await r.json()`,
    );
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe("changed=1");
    expect(echoed.headers["x-forwarded-for"]).toBe("1.2.3.4");
    // 与用户给的请求头重名（大小写不同）也删掉了；没列的头保持原样。
    expect(echoed.headers["x-drop-me"]).toBeUndefined();
    expect(echoed.headers["x-keep"]).toBe("ok");

    // 改地址：同样经路由发出，落到另一个接口。
    await page.routeClear();
    await page.routeAdd({
      pattern: "**/echo",
      action: { kind: "modify", url: base("/api/items") },
    });
    const moved = await value<{ items: number[] }>(
      page,
      `const r = await fetch("/echo");
       return await r.json()`,
    );
    expect(moved).toEqual({ items: [1, 2, 3] });
    await page.close();
  });

  test("patch：去掉响应里的 CSP 头并替换正文，状态码也能改", async () => {
    const page = await ctx.newPage();
    await page.goto(base());
    await page.routeAdd({
      pattern: "**/csp",
      action: {
        kind: "patch",
        status: 418,
        headers: { "content-security-policy": null },
        replace: [{ find: "ORIGINAL-TEXT", with: "PATCHED-TEXT" }],
      },
    });
    const res = await value<{
      status: number;
      csp: string | null;
      text: string;
    }>(
      page,
      `const r = await fetch("/csp");
       return {
         status: r.status,
         csp: r.headers.get("content-security-policy"),
         text: await r.text(),
       }`,
    );
    expect(res.status).toBe(418);
    expect(res.csp).toBeNull();
    expect(res.text).toContain("PATCHED-TEXT");
    expect(res.text).not.toContain("ORIGINAL-TEXT");
    // 去掉 CSP 之后页面里读到的就是这个被改过的文档。
    const read = await value<string>(
      page,
      `const r = await fetch("/csp");
       return await r.text()`,
    );
    expect(read).toContain("PATCHED-TEXT");

    // 没有规则时原样本还在：确认上面不是服务端一直如此。
    await page.routeClear();
    const plain = await value<{ status: number; csp: string | null }>(
      page,
      `const r = await fetch("/csp");
       return { status: r.status, csp: r.headers.get("content-security-policy") }`,
    );
    expect(plain).toEqual({ status: 200, csp: "default-src 'self'" });
    await page.close();
  });

  test("delayMs：响应至少慢这么久", async () => {
    const page = await ctx.newPage();
    await page.goto(base());
    await page.routeAdd({
      pattern: "**/api/items",
      delayMs: 600,
      action: { kind: "mock", status: 200, headers: {}, body: "{}" },
    });
    const ms = await value<number>(
      page,
      `const t = Date.now();
       await fetch("/api/items");
       return Date.now() - t`,
    );
    expect(ms).toBeGreaterThanOrEqual(500);
    await page.close();
  });

  test("后加的先匹配；命中次数记在各自的规则上", async () => {
    const page = await ctx.newPage();
    await page.goto(base());
    const block = await page.routeAdd({
      pattern: "**/api/**",
      action: { kind: "block" },
    });
    const mock = await page.routeAdd({
      pattern: "**/api/**",
      action: {
        kind: "mock",
        status: 200,
        headers: {},
        body: '{"mocked":true}',
      },
    });
    const res = await value<{ status: number; text: string }>(
      page,
      `const r = await fetch("/api/items");
       return { status: r.status, text: await r.text() }`,
    );
    expect(res).toEqual({ status: 200, text: '{"mocked":true}' });
    const rules = page.routeList();
    expect(rules.map((r) => r.id)).toEqual([block.id, mock.id]);
    expect(rules.find((r) => r.id === mock.id)?.hits).toBe(1);
    expect(rules.find((r) => r.id === block.id)?.hits).toBe(0);
    await page.close();
  });

  test("method 过滤：只拦 POST，GET 照常走网络", async () => {
    const page = await ctx.newPage();
    await page.goto(base());
    await page.routeAdd({
      pattern: "**/echo",
      method: "POST",
      action: { kind: "block" },
    });
    const out = await value<{ get: string; post: string }>(
      page,
      `const get = await fetch("/echo").then((r) => r.text()).then(() => "ok").catch(() => "failed");
       const post = await fetch("/echo", { method: "POST", body: "x" }).then(() => "ok").catch(() => "failed");
       return { get, post }`,
    );
    expect(out).toEqual({ get: "ok", post: "failed" });
    expect(page.routeList()[0]?.hits).toBe(1);
    await page.close();
  });

  test("routeRemove 之后恢复正常；routeClear 返回条数", async () => {
    const page = await ctx.newPage();
    await page.goto(base());
    const rule = await page.routeAdd({
      pattern: "**/pic.png",
      action: { kind: "block" },
    });
    await page.reload();
    expect(
      await value<number>(
        page,
        `return document.querySelector("#pic").naturalWidth`,
      ),
    ).toBe(0);
    expect(await page.routeRemove(rule.id)).toBe(true);
    expect(await page.routeRemove(rule.id)).toBe(false);
    await page.reload();
    expect(
      await value<number>(
        page,
        `return document.querySelector("#pic").naturalWidth`,
      ),
    ).toBe(1);
    // 规则表空了，清掉是 0 条。
    expect(await page.routeClear()).toBe(0);
    await page.routeAdd({ pattern: "**/app.js", action: { kind: "block" } });
    expect(await page.routeClear()).toBe(1);
    await page.close();
  });
});
