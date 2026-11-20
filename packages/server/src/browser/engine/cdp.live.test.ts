// PageCdp 的真浏览器端到端：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 直接用 Playwright 起浏览器（不经引擎与代理）：夹具就是本机 http 站点。
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PageCdp } from "./cdp.js";
import { VIEWPORT } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";

const PAGE = `<!doctype html><meta charset=utf-8><title>CDP 页</title>
<div id="out">reading</div>
<script>
  document.getElementById("out").textContent =
    "w=" + innerWidth + " h=" + innerHeight;
  window.__size = () => "w=" + innerWidth + " h=" + innerHeight;
</script>`;

interface Site {
  port: number;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** 页面里读一次尺寸（用页面自己的函数，重新算 innerWidth / innerHeight）。 */
const sizeOf = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __size(): string }).__size());

describe.skipIf(!enabled)("PageCdp（真实 Chromium）", () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let site: Site;
  let cdp: PageCdp;
  let page: Page;

  beforeAll(async () => {
    if (!enabled) return;
    site = await startSite();
    browser = await chromium.launch({ executablePath: EXE });
    ctx = await browser.newContext({ viewport: VIEWPORT });
    page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${site.port}/`);
    await page.waitForLoadState("load");
    cdp = new PageCdp(page);
  });

  afterAll(async () => {
    if (!enabled) return;
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await site?.close().catch(() => {});
  });

  test("Runtime.evaluate 带 returnByValue 取回结果，多次命令复用同一个会话", async () => {
    const first = await cdp.send("Runtime.evaluate", {
      expression: "1 + 2",
      returnByValue: true,
    });
    expect(first).toMatchObject({ result: { type: "number", value: 3 } });
    const second = await cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    expect(second).toMatchObject({ result: { value: "CDP 页" } });
  });

  test("Page.getNavigationHistory 取到导航记录", async () => {
    const out = (await cdp.send("Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: { url: string }[];
    };
    expect(out.currentIndex).toBeGreaterThanOrEqual(0);
    expect(out.entries[out.currentIndex]?.url).toBe(
      `http://127.0.0.1:${site.port}/`,
    );
  });

  test("Browser.getVersion 在页面级会话里可用", async () => {
    const out = (await cdp.send("Browser.getVersion")) as {
      product: string;
    };
    expect(out.product).toContain("Chrome");
  });

  test("不存在的方法：报错取第一行", async () => {
    const err = (await cdp.send("Foo.bar").catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    // Playwright 会在前面套一层 `cdpSession.send: Protocol error (Foo.bar): `，这里只取 CDP 那一句。
    expect(err.message).toBe(
      "cdpSession.send: Protocol error (Foo.bar): 'Foo.bar' wasn't found",
    );
    expect(err.message).not.toContain("\n");
  });

  test("Emulation.setDeviceMetricsOverride 改变页面 innerWidth，用完清除", async () => {
    // 自己开一个页面：clearDeviceMetricsOverride 会把 Playwright 自己设的视口一起清掉，
    // 主页面会被污染，所以这个用例整页用完就关。
    const own = await ctx.newPage();
    await own.goto(`http://127.0.0.1:${site.port}/`);
    const ownCdp = new PageCdp(own);
    try {
      expect(await sizeOf(own)).toMatch(/^w=1280 h=\d+$/);
      await ownCdp.send("Emulation.setDeviceMetricsOverride", {
        width: 640,
        height: 480,
        deviceScaleFactor: 1,
        mobile: false,
      });
      expect(await sizeOf(own)).toBe("w=640 h=480");
      await ownCdp.send("Emulation.clearDeviceMetricsOverride");
      // 清除之后视口要过一会儿才真的变回来：轮询到不再是 640 为止。
      await expect.poll(() => sizeOf(own)).not.toBe("w=640 h=480");
    } finally {
      await own.close();
    }
  });

  test("页面关闭之后会话丢弃", async () => {
    const own = await ctx.newPage();
    await own.goto(`http://127.0.0.1:${site.port}/`);
    const other = new PageCdp(own);
    await other.send("Runtime.evaluate", { expression: "1" });
    await own.close();
    await expect(
      other.send("Runtime.evaluate", { expression: "1" }),
    ).rejects.toThrow(/页面已关闭/);
  });
});
