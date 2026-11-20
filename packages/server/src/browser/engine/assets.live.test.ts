// 真 Chromium 的资源清单与取字节：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 站点由测试自己起的本地 HTTP 服务给，经测试自己的代理转发（引擎的上下文只接受走代理）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { Engine } from "./engine.js";
import type { AssetResult, BrowserCtx, PageHandle } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";
const SITE = "site.test";

// 一张 1×1 的 PNG（真实字节，浏览器才认它是已加载的图片）。
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// 300 KB 的「音频」：只验字节数与读取路径，不求真能解码。
const AUDIO = Buffer.alloc(300 * 1024, 7);
const SCRIPT = "// 站点脚本\nwindow.__site = 1;\n";
const BG = PNG;

const PAGE = `<!doctype html><meta charset=utf-8><title>资源页</title>
<link rel="icon" href="/favicon.ico">
<img alt="普通图" src="/a.png">
<div style="width:40px;height:40px;background-image:url(/bg.png)"></div>
<audio preload="auto" src="/s.mp3" controls></audio>
<script src="/app.js"></script>
<p>资源页正文</p>`;

interface Harness {
  proxyPort: number;
  close(): Promise<void>;
}

/** 最简 HTTP 代理：site.test → 本地站点，其余一律 502。CONNECT 也接（上下文的 request 会用它）。 */
async function startHarness(): Promise<Harness> {
  const site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.pathname === "/assets") {
      // 页面自己种 cookie：受保护资源要用它。
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("set-cookie", "ok=1; Path=/");
      res.end(PAGE);
      return;
    }
    if (url.pathname === "/a.png" || url.pathname === "/bg.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(url.pathname === "/a.png" ? PNG : BG);
      return;
    }
    if (url.pathname === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(SCRIPT);
      return;
    }
    if (url.pathname === "/s.mp3") {
      // 支持 Range：只回请求的那一段。
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) : AUDIO.length - 1;
      const body = AUDIO.subarray(start, end + 1);
      res.writeHead(range ? 206 : 200, {
        "content-type": "audio/mpeg",
        "accept-ranges": "bytes",
        "content-length": String(body.length),
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${AUDIO.length}` }
          : {}),
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/protected.png") {
      // 要页面的 cookie 与 Referer 才给。
      const cookieOk = /(?:^|;\s*)ok=1/.test(req.headers.cookie ?? "");
      const refererOk = (req.headers.referer ?? "").includes("/assets");
      if (!cookieOk || !refererOk) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(200, { "content-type": "image/x-icon" });
      res.end(PNG);
      return;
    }
    res.writeHead(404).end("not found");
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
  // BrowserContext.request 对本项目的站点也发 CONNECT（实测）：把它转成到本地站点的裸隧道。
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

describe.skipIf(!enabled)("资源清单与取字节（真实 Chromium）", () => {
  let engine: Engine;
  let harness: Harness;
  let ctx: BrowserCtx;

  const page = async (): Promise<PageHandle> => {
    const p = await ctx.newPage();
    await p.goto(`http://${SITE}/assets`);
    return p;
  };

  beforeAll(async () => {
    if (!enabled) return;
    harness = await startHarness();
    engine = new Engine({
      dataDir: makeTmpDir("ys-assets-live-"),
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
  });

  afterAll(async () => {
    if (!enabled) return;
    await ctx?.close().catch(() => {});
    await engine?.close().catch(() => {});
    await harness?.close().catch(() => {});
  });

  test("清单：图片 / 背景图 / 媒体 / 脚本都在，各自带 mime 与大小；favicon 不在", async () => {
    const p = await page();
    const assets = await p.assets();
    const byUrl = new Map(assets.map((a) => [a.url, a]));
    expect(byUrl.get(`http://${SITE}/a.png`)).toMatchObject({
      type: "image",
      mime: "image/png",
      frame: "main",
    });
    // 背景图也算图片资源
    expect(byUrl.get(`http://${SITE}/bg.png`)).toMatchObject({ type: "image" });
    expect(byUrl.get(`http://${SITE}/app.js`)).toMatchObject({
      type: "script",
      mime: "text/javascript",
    });
    expect(byUrl.get(`http://${SITE}/s.mp3`)).toMatchObject({
      type: "media",
      mime: "audio/mpeg",
    });
    // 页面里那张 <img> 的 alt 与自然尺寸补上了
    expect(byUrl.get(`http://${SITE}/a.png`)?.alt).toBe("普通图");
    expect(byUrl.get(`http://${SITE}/a.png`)?.width).toBe(1);
    // 资源树里没有 favicon
    expect(assets.some((a) => a.url.includes("favicon"))).toBe(false);
    // 有大小的项都给了正数
    expect(byUrl.get(`http://${SITE}/app.js`)?.size).toBeGreaterThan(0);
    await p.close();
  }, 30_000);

  test("取字节：图片与脚本走缓存，音频走新请求，字节都对；受保护图片的新请求带 cookie 与 Referer", async () => {
    const p = await page();
    const urls = [
      `http://${SITE}/a.png`,
      `http://${SITE}/app.js`,
      `http://${SITE}/s.mp3`,
      // 页面没加载过的地址：只能走新请求
      `http://${SITE}/protected.png?fresh=1`,
    ];
    const got: AssetResult[] = [];
    await p.fetchAssets(
      urls,
      { referer: `http://${SITE}/assets`, maxBytes: 10 * 1024 * 1024 },
      async (r) => {
        got.push(r);
      },
    );
    const byUrl = new Map(got.map((r) => [r.url, r]));
    console.log(
      "取字节路径：",
      got.map(
        (r) =>
          `${r.url} ok=${r.ok} ${r.ok ? (r.viaRequest ? "new" : "cache") : r.reason}`,
      ),
    );
    expect(byUrl.get(`http://${SITE}/a.png`)).toMatchObject({
      ok: true,
      mime: "image/png",
      viaRequest: false,
    });
    expect(byUrl.get(`http://${SITE}/app.js`)).toMatchObject({
      ok: true,
      mime: "text/javascript",
      viaRequest: false,
    });
    // 媒体取不到浏览器缓存：改走新请求，字节数与站点给的一致
    const audio = byUrl.get(`http://${SITE}/s.mp3`);
    expect(audio?.ok).toBe(true);
    if (audio?.ok) {
      expect(audio.viaRequest).toBe(true);
      expect(audio.bytes.length).toBe(AUDIO.length);
    }
    // 受保护图片：新请求拿到 200，说明带上了页面的 cookie 与 Referer
    const prot = byUrl.get(`http://${SITE}/protected.png?fresh=1`);
    expect(prot?.ok).toBe(true);
    if (prot?.ok) {
      expect(prot.viaRequest).toBe(true);
      expect(prot.bytes.equals(PNG)).toBe(true);
    }
    // 逐个回调：顺序与传入顺序一致
    expect(got.map((r) => r.url)).toEqual(urls);
    await p.close();
  }, 30_000);

  test("超过大小上限：被拒并写明原因", async () => {
    const p = await page();
    const got: AssetResult[] = [];
    await p.fetchAssets(
      [`http://${SITE}/s.mp3`],
      { referer: `http://${SITE}/assets`, maxBytes: 1024 },
      async (r) => {
        got.push(r);
      },
    );
    expect(got).toEqual([
      {
        url: `http://${SITE}/s.mp3`,
        ok: false,
        reason: "超过大小上限（1 KB）",
      },
    ]);
    await p.close();
  }, 30_000);
});
