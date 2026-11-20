// Emulation 的真浏览器端到端：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 直接用 Playwright 起浏览器（不经引擎与代理）：夹具就是本机 http 站点。
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PageCdp } from "./cdp.js";
import { Emulation } from "./emulate.js";
import type { EmulationState } from "./types.js";
import { VIEWPORT } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";

const PAGE = `<!doctype html><meta charset=utf-8><title>环境模拟页</title>
<div id="out">reading</div>
<script>
  const read = () => {
    document.getElementById("out").textContent = [
      "online=" + navigator.onLine,
      "dark=" + matchMedia("(prefers-color-scheme: dark)").matches,
      "reduce=" + matchMedia("(prefers-reduced-motion: reduce)").matches,
      "ua=" + navigator.userAgent,
      "lang=" + navigator.language,
      "tz=" + Intl.DateTimeFormat().resolvedOptions().timeZone,
    ].join(" | ");
  };
  read();
  window.__read = read;
</script>`;

const CACHED = `<!doctype html><meta charset=utf-8><title>缓存页</title>
<button id="hit" onclick="fetch('/cached-resource').then(r => r.text()).then(t => { document.getElementById('out').textContent = t })">取资源</button>
<div id="out">未取</div>`;

interface Site {
  port: number;
  /** 带 Cache-Control 的资源被请求了几次 */
  cachedHits(): number;
  /** 记下来的请求头，按顺序 */
  headers(): Array<{ ua?: string; lang?: string }>;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const seen: Array<{ ua?: string; lang?: string }> = [];
  let cached = 0;
  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    seen.push({
      ...(typeof req.headers["user-agent"] === "string"
        ? { ua: req.headers["user-agent"] }
        : {}),
      ...(typeof req.headers["accept-language"] === "string"
        ? { lang: req.headers["accept-language"] }
        : {}),
    });
    if (path === "/cached-resource") {
      cached++;
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "max-age=60",
      });
      res.end(`hit ${cached}`);
      return;
    }
    if (path === "/echo") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("echo");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(path === "/cached" ? CACHED : PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    cachedHits: () => cached,
    headers: () => [...seen],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** 页面里读一次当前环境，解析成对象。 */
const readEnv = async (page: Page) => {
  const text = await page.evaluate(() => {
    const out = (
      globalThis as unknown as {
        document: { getElementById(id: string): { textContent: string } };
      }
    ).document.getElementById("out");
    return out.textContent;
  });
  const out: Record<string, string> = {};
  for (const part of text.split(" | ")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
};

const state = (p: Partial<EmulationState> = {}): EmulationState => ({
  offline: false,
  throttle: null,
  cpuSlowdown: null,
  colorScheme: null,
  reducedMotion: null,
  userAgent: null,
  locale: null,
  timezone: null,
  cacheDisabled: false,
  ...p,
});

describe.skipIf(!enabled)("Emulation（真实 Chromium）", () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let site: Site;
  /** 每页一个新 Emulation：环境模拟是页面级的，用例之间互不干扰。 */
  const open = async (path = "/"): Promise<{ page: Page; emu: Emulation }> => {
    const page = await ctx.newPage();
    await page.goto(url(path));
    await page.waitForLoadState("load");
    return { page, emu: new Emulation(page, new PageCdp(page)) };
  };
  const url = (path = "/") => `http://127.0.0.1:${site.port}${path}`;

  beforeAll(async () => {
    if (!enabled) return;
    site = await startSite();
    browser = await chromium.launch({ executablePath: EXE });
    ctx = await browser.newContext({ viewport: VIEWPORT });
  });

  afterAll(async () => {
    if (!enabled) return;
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await site?.close().catch(() => {});
  });

  test("离线：fetch 失败、navigator.onLine 为 false；撤销后恢复", async () => {
    const { page, emu } = await open();
    const before = await readEnv(page);
    expect(before.online).toBe("true");

    await emu.apply({ offline: true });
    expect(
      await page.evaluate(() =>
        fetch("/echo")
          .then(() => "ok")
          .catch(() => "failed"),
      ),
    ).toBe("failed");
    await page.evaluate(() =>
      (globalThis as unknown as { __read(): void }).__read(),
    );
    expect((await readEnv(page)).online).toBe("false");

    await emu.apply({ offline: false });
    expect(
      await page.evaluate(() =>
        fetch("/echo")
          .then((r) => r.text())
          .catch(() => "failed"),
      ),
    ).toBe("echo");
    expect(emu.state().offline).toBe(false);
  });

  test("弱网：latencyMs 400 让一次 fetch 至少慢那么多", async () => {
    const { page, emu } = await open();
    await emu.apply({ throttle: { latencyMs: 400 } });
    const started = Date.now();
    await page.evaluate(() => fetch("/echo").then((r) => r.text()));
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThanOrEqual(350);
    await emu.apply({ throttle: null });
  }, 20_000);

  test("深色模式与减少动效", async () => {
    const { page, emu } = await open();
    expect((await readEnv(page)).dark).toBe("false");
    await emu.apply({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.evaluate(() =>
      (globalThis as unknown as { __read(): void }).__read(),
    );
    const on = await readEnv(page);
    expect(on.dark).toBe("true");
    expect(on.reduce).toBe("true");
    // 只改一项时另一项保持
    await emu.apply({ reducedMotion: "no-preference" });
    await page.evaluate(() =>
      (globalThis as unknown as { __read(): void }).__read(),
    );
    const off = await readEnv(page);
    expect(off.dark).toBe("true");
    expect(off.reduce).toBe("false");
  });

  test("UA 与 locale：navigator 与请求头都换了；撤销后回到原值", async () => {
    const { page, emu } = await open();
    const original = await readEnv(page);
    await emu.apply({ userAgent: "YuanshuTest/9.9", locale: "ja-JP" });
    const before = site.headers().length;
    await page.goto(url("/echo"));
    await page.waitForLoadState("load");
    const sent = site.headers().slice(before).at(-1);
    expect(sent?.ua).toBe("YuanshuTest/9.9");
    expect(sent?.lang).toContain("ja-JP");

    await page.goto(url("/"));
    await page.waitForLoadState("load");
    const on = await readEnv(page);
    expect(on.ua).toBe("YuanshuTest/9.9");
    expect(on.lang).toBe("ja-JP");

    // 撤销：UA 回到原始值，语言回到浏览器默认
    await emu.apply({ userAgent: null, locale: null });
    await page.evaluate(() =>
      (globalThis as unknown as { __read(): void }).__read(),
    );
    const off = await readEnv(page);
    expect(off.ua).toBe(original.ua);
    expect(off.lang).toBe(original.lang);
  }, 20_000);

  test("时区", async () => {
    const { page, emu } = await open();
    expect((await readEnv(page)).tz).not.toBe("Asia/Tokyo");
    await emu.apply({ timezone: "Asia/Tokyo" });
    await page.evaluate(() =>
      (globalThis as unknown as { __read(): void }).__read(),
    );
    expect((await readEnv(page)).tz).toBe("Asia/Tokyo");
    await emu.apply({ timezone: null });
    await page.evaluate(() =>
      (globalThis as unknown as { __read(): void }).__read(),
    );
    expect((await readEnv(page)).tz).not.toBe("Asia/Tokyo");
  });

  test("非法时区：CDP 的报错取第一行原样抛", async () => {
    const { emu } = await open();
    const err = (await emu
      .apply({ timezone: "Mars/Base" })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/timezone/i);
    expect(err.message).not.toContain("\n");
    expect(emu.state().timezone).toBeNull();
  });

  test("cacheDisabled：关缓存后同一资源服务端收到两次", async () => {
    const { page, emu } = await open("/cached");
    const fetchTwice = () =>
      page.evaluate(async () => {
        const a = await (await fetch("/cached-resource")).text();
        const b = await (await fetch("/cached-resource")).text();
        return [a, b];
      });
    const before = site.cachedHits();
    const warm = await fetchTwice();
    const middle = site.cachedHits() - before;
    // 不关缓存时第二次命中缓存
    expect(middle).toBe(1);
    expect(warm[0]).toBe(warm[1]);

    await emu.apply({ cacheDisabled: true });
    const after = site.cachedHits();
    await fetchTwice();
    expect(site.cachedHits() - after).toBe(2);
  }, 20_000);

  test("整页导航之后覆盖仍然生效（会话长存）", async () => {
    const { page, emu } = await open();
    await emu.apply({
      userAgent: "YuanshuPersist/1.0",
      locale: "de-DE",
      timezone: "Asia/Tokyo",
      colorScheme: "dark",
    });
    await page.goto(url("/other"));
    await page.waitForLoadState("load");
    const on = await readEnv(page);
    expect(on.ua).toBe("YuanshuPersist/1.0");
    expect(on.lang).toBe("de-DE");
    expect(on.tz).toBe("Asia/Tokyo");
    expect(on.dark).toBe("true");
    expect(emu.state()).toMatchObject({
      userAgent: "YuanshuPersist/1.0",
      locale: "de-DE",
      timezone: "Asia/Tokyo",
      colorScheme: "dark",
    });
  }, 20_000);

  test("逐项撤销回到原值；emulation() 与 emulate() 返回一致", async () => {
    const { page, emu } = await open();
    const original = await readEnv(page);
    const patched = await emu.apply({
      offline: true,
      throttle: { latencyMs: 200, downloadKbps: 500 },
      cpuSlowdown: 2,
      colorScheme: "dark",
      reducedMotion: "reduce",
      userAgent: "YuanshuReset/1.0",
      locale: "ja-JP",
      timezone: "Asia/Tokyo",
      cacheDisabled: true,
    });
    expect(patched).toEqual(emu.state());
    expect(patched).toEqual(
      state({
        offline: true,
        throttle: { latencyMs: 200, downloadKbps: 500, uploadKbps: -1 },
        cpuSlowdown: 2,
        colorScheme: "dark",
        reducedMotion: "reduce",
        userAgent: "YuanshuReset/1.0",
        locale: "ja-JP",
        timezone: "Asia/Tokyo",
        cacheDisabled: true,
      }),
    );

    const restored = await emu.apply({
      offline: false,
      throttle: null,
      cpuSlowdown: null,
      colorScheme: null,
      reducedMotion: null,
      userAgent: null,
      locale: null,
      timezone: null,
      cacheDisabled: false,
    });
    expect(restored).toEqual(state());
    expect(emu.state()).toEqual(state());
    await page.evaluate(() =>
      (globalThis as unknown as { __read(): void }).__read(),
    );
    const off = await readEnv(page);
    expect(off.ua).toBe(original.ua);
    expect(off.lang).toBe(original.lang);
    expect(off.tz).toBe(original.tz);
    expect(off.dark).toBe("false");
    expect(off.online).toBe("true");
  }, 20_000);
});
