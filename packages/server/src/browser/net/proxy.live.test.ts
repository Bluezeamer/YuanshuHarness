// 用真 Chromium 验证代理：Playwright 的 proxy 认证、虚拟主机名、WebSocket、文件主机与内网拒绝。
// 默认跳过，显式给可执行文件才跑：
//   YUANSHU_TEST_CHROMIUM=<chrome 路径> ./node_modules/.bin/vitest run src/browser/net/proxy.live.test.ts
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { LocalEnv } from "../../env/local.js";
import { serviceHost } from "./hostnames.js";
import {
  // biome-ignore lint/suspicious/noShadowRestrictedNames: 代理接口就叫 Proxy，与全局 Proxy 无关
  type Proxy,
  startProxy,
} from "./proxy.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM;

// 后端页面注入的探针；服务端的 tsconfig 没有 DOM 类型，用 globalThis 取值
interface Probe {
  __info: { host: string; secure: boolean };
  __ws: Promise<string>;
}

describe.skipIf(!EXE)("真 Chromium 经代理（live）", () => {
  let proxy: Proxy;
  let browser: Browser;
  let backend: http.Server;
  let backendPort = 0;
  let workDir = "";
  // 允许回环的上下文、拒绝回环的上下文（验证被拦时的拒绝码）
  let tokenLoop = "";
  let tokenNoLoop = "";
  let ctxLoop: BrowserContext;
  let ctxNoLoop: BrowserContext;

  beforeAll(async () => {
    workDir = makeTmpDir("yuanshu-proxy-live-");
    writeFileSync(
      path.join(workDir, "page.html"),
      '<h1>file page</h1><a id=next href="sub/next.html">next</a>',
    );
    // 相对链接的目标要存在
    mkdirSync(path.join(workDir, "sub"));
    writeFileSync(path.join(workDir, "sub", "next.html"), "<h1>next page</h1>");

    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (s) => s.on("message", (m) => s.send(`echo:${m}`)));
    backend = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><title>backend</title><body>backend
<script>
  window.__info = { host: location.host, secure: isSecureContext };
  window.__ws = new Promise((ok) => {
    const w = new WebSocket("ws://" + location.host + "/ws");
    w.onopen = () => w.send("ping");
    w.onmessage = (e) => ok(e.data);
    w.onerror = () => ok("ws-error");
  });
</script>`);
    });
    backend.on("upgrade", (req, sock, head) =>
      wss.handleUpgrade(req, sock, head, (ws) =>
        wss.emit("connection", ws, req),
      ),
    );
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    backendPort = (backend.address() as AddressInfo).port;

    const env = new LocalEnv();
    proxy = await startProxy({ env: (id) => (id === "local" ? env : null) });
    const allow = {
      allowService: (envId: string, port: number) =>
        envId === "local" && port === backendPort,
      allowFile: () => true,
    };
    tokenLoop = proxy.register({ loopbackEnvId: "local", ...allow }).token;
    tokenNoLoop = proxy.register({ loopbackEnvId: null, ...allow }).token;

    browser = await chromium.launch({
      executablePath: EXE,
      args: ["--no-sandbox"],
    });
    const context = (token: string) =>
      browser.newContext({
        proxy: {
          server: `http://127.0.0.1:${proxy.port}`,
          username: token,
          password: "x",
        },
      });
    ctxLoop = await context(tokenLoop);
    ctxNoLoop = await context(tokenNoLoop);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await proxy?.close();
    backend?.closeAllConnections();
    await new Promise<void>((ok) => backend?.close(() => ok()));
  });

  const newPage = async (ctx: BrowserContext): Promise<Page> => {
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.warn("[page]", m.text());
    });
    return page;
  };

  test("①普通 HTTP 与 CONNECT 都能通过代理认证（Playwright 的 proxy 凭据）", async () => {
    const page = await newPage(ctxLoop);
    const res = await page.goto(
      `http://${serviceHost("local", backendPort)}/`,
      {
        timeout: 20_000,
      },
    );
    expect(res?.status()).toBe(200);
    // WebSocket 走 CONNECT，能收到回显说明 CONNECT 也带上了凭据
    expect(
      await page.evaluate(() => (globalThis as unknown as Probe).__ws),
    ).toBe("echo:ping");
    await page.close();
  });

  test("②虚拟主机名：location.host、安全上下文、页内 WebSocket", async () => {
    const page = await newPage(ctxLoop);
    const host = serviceHost("local", backendPort);
    await page.goto(`http://${host}/`, { timeout: 20_000 });
    const info = await page.evaluate(
      () => (globalThis as unknown as Probe).__info,
    );
    expect(info.host).toBe(host);
    expect(info.secure).toBe(true);
    expect(
      await page.evaluate(() => (globalThis as unknown as Probe).__ws),
    ).toBe("echo:ping");
    await page.close();
  });

  test("③文件主机：页面可读，相对链接点得开", async () => {
    const page = await newPage(ctxLoop);
    const url = `http://server.files.localhost${workDir}/page.html`;
    const res = await page.goto(url, { timeout: 20_000 });
    expect(res?.status()).toBe(200);
    expect(await page.textContent("h1")).toBe("file page");
    await page.click("#next");
    await page.waitForLoadState();
    expect(new URL(page.url()).hostname).toBe("server.files.localhost");
    expect(await page.textContent("h1")).toBe("next page");
    await page.close();
  });

  test("④内网与元数据地址：403 且带 X-Yuanshu-Deny", async () => {
    const page = await newPage(ctxNoLoop);
    const loop = await page.goto(`http://127.0.0.1:${backendPort}/`, {
      timeout: 20_000,
    });
    expect(loop?.status()).toBe(403);
    expect(loop?.headers()["x-yuanshu-deny"]).toBe("blocked_address");

    const metadata = await page.goto(
      "http://169.254.169.254/latest/meta-data/",
      {
        timeout: 20_000,
      },
    );
    expect(metadata?.status()).toBe(403);
    expect(metadata?.headers()["x-yuanshu-deny"]).toBe("blocked_address");
    await page.close();
  });

  test("⑤凭据错误：拿不到后端页面", async () => {
    const ctx = await browser.newContext({
      proxy: {
        server: `http://127.0.0.1:${proxy.port}`,
        username: "wrong-token",
        password: "x",
      },
    });
    const page = await ctx.newPage();
    // 浏览器收到 407 会带凭据重试，仍失败时导航本身成功、页面是 407 的拒绝页
    const res = await page.goto(
      `http://${serviceHost("local", backendPort)}/`,
      {
        timeout: 15_000,
      },
    );
    expect(res?.status()).toBe(407);
    expect(res?.headers()["x-yuanshu-deny"]).toBe("auth");
    expect(await page.textContent("body")).toContain("浏览器代理认证失败");
    await ctx.close();
  }, 30_000);
});
