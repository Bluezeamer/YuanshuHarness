// 真实驱动：puppeteer-core 控制本机 Chromium（ADR-0082）。不下载浏览器，路径由 locate.ts 找。
import puppeteer, {
  type Browser,
  type CDPSession,
  type Page,
} from "puppeteer-core";
import {
  type BrowserDriver,
  type Launcher,
  type PageDriver,
  VIEWPORT,
} from "./driver.js";
import { parseHttpUrl } from "./guard.js";
import {
  COLLECT_SCRIPT,
  focusScript,
  formatSnapshot,
  type RawSnapshot,
  refExpr,
} from "./snapshot.js";

const GOTO_TIMEOUT_MS = 20_000;
const STALE =
  "该编号已失效（页面可能变了），请先调用 browser_snapshot 重新获取。";

const noop = () => {};

// 导航失败的原因翻成人话；未获批准的跳转单独说明，让模型知道该走 browser_open。
function explain(err: unknown, blocked: string[]): string {
  const m = err instanceof Error ? err.message : String(err);
  if (blocked.length > 0)
    return `跳转被拦截：${blocked[0]} 不在已批准的站点内。要访问它请对该地址调用 browser_open。`;
  if (m.includes("ERR_NAME_NOT_RESOLVED")) return "无法解析域名";
  if (m.includes("ERR_CONNECTION_REFUSED")) return "连接被拒绝";
  if (m.includes("ERR_CERT")) return "证书不受信任";
  if (/timeout/i.test(m)) return `加载超时（${GOTO_TIMEOUT_MS / 1000} 秒）`;
  return m.split("\n")[0] ?? m;
}

async function openPage(
  browser: Browser,
  navAllowed: (url: string) => boolean,
): Promise<PageDriver> {
  const context = await browser.createBrowserContext();
  // 下载一律拒绝：侧边浏览器是看页面的，不是落文件的。
  const bcdp = await browser.target().createCDPSession();
  await bcdp
    .send("Browser.setDownloadBehavior", {
      behavior: "deny",
      browserContextId: context.id as string,
    })
    .catch(noop);
  await bcdp.detach().catch(noop);

  const page: Page = await context.newPage();
  await page.setViewport({ ...VIEWPORT });

  // 弹窗、新窗口一律关掉：agent 只面对一个页面，用户也只看这一个。
  context.on("targetcreated", (t) => {
    if (t.type() !== "page") return;
    void t
      .page()
      .then((p) => (p && p !== page ? p.close() : undefined))
      .catch(noop);
  });
  page.on("dialog", (d) => void d.dismiss().catch(noop));

  let blocked: string[] = [];
  let loading = false;
  const listeners: (() => void)[] = [];
  const changed = () => {
    for (const cb of listeners) cb();
  };

  // 主框架的每一次跳转（含重定向）都要过 navAllowed；其余请求原样放行。
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      const url = req.url();
      if (url !== "about:blank" && !(parseHttpUrl(url) && navAllowed(url))) {
        blocked.push(url);
        loading = false;
        void req.abort("blockedbyclient").catch(noop);
        changed();
        return;
      }
      loading = true;
      changed();
    }
    void req.continue().catch(noop);
  });
  page.on("requestfailed", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      loading = false;
      changed();
    }
  });
  page.on("load", () => {
    loading = false;
    changed();
  });
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) changed();
  });

  const settle = () =>
    page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 }).catch(noop);

  let cdp: CDPSession | null = null;
  const stopScreencast = async () => {
    const c = cdp;
    if (!c) return;
    cdp = null;
    await c.send("Page.stopScreencast").catch(noop);
    await c.detach().catch(noop);
  };

  return {
    async goto(url) {
      blocked = [];
      try {
        const res = await page.goto(url, {
          waitUntil: "load",
          timeout: GOTO_TIMEOUT_MS,
        });
        return { status: res?.status() ?? null };
      } catch (err) {
        // 超时但页面已经有内容时仍然可用，由调用方继续取快照。
        throw new Error(explain(err, blocked));
      }
    },
    url: () => page.url(),
    title: () => page.title().catch(() => ""),
    loading: () => loading,
    async snapshot() {
      const raw = (await page.evaluate(COLLECT_SCRIPT)) as RawSnapshot;
      return formatSnapshot(raw);
    },
    async click(ref) {
      const el = (await page.evaluateHandle(refExpr(ref))).asElement();
      if (!el) throw new Error(STALE);
      try {
        await el.click();
      } catch (err) {
        throw new Error(
          `点击失败：${err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)}`,
        );
      } finally {
        await el.dispose().catch(noop);
      }
      await settle();
    },
    async type(ref, text, submit) {
      if (!(await page.evaluate(focusScript(ref)))) throw new Error(STALE);
      if (text === "") await page.keyboard.press("Backspace");
      else await page.keyboard.type(text);
      if (submit) await page.keyboard.press("Enter");
      await settle();
    },
    async screenshot() {
      return Buffer.from(await page.screenshot({ type: "jpeg", quality: 70 }));
    },
    async startScreencast(onFrame) {
      if (cdp) return;
      const c = await page.createCDPSession();
      cdp = c;
      c.on("Page.screencastFrame", (f) => {
        onFrame(Buffer.from(f.data, "base64"));
        void c
          .send("Page.screencastFrameAck", { sessionId: f.sessionId })
          .catch(noop);
      });
      await c.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
      });
    },
    stopScreencast,
    onChange: (cb) => {
      listeners.push(cb);
    },
    takeBlocked: () => {
      const b = blocked;
      blocked = [];
      return b;
    },
    async close() {
      await stopScreencast();
      await context.close().catch(noop);
    },
  };
}

export const launchChromium =
  (executablePath: () => string | null): Launcher =>
  async () => {
    const path = executablePath();
    if (!path) throw new Error("找不到浏览器");
    const args = ["--disable-gpu", "--disable-dev-shm-usage", "--no-first-run"];
    // root（常见于容器）下 Chromium 的沙箱起不来；非 root 保持沙箱开启。
    if (process.getuid?.() === 0) args.push("--no-sandbox");
    const browser = await puppeteer.launch({
      executablePath: path,
      headless: true,
      // 走管道而不是本地调试端口：本机其他进程连不上。
      pipe: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args,
    });
    const driver: BrowserDriver = {
      newPage: (navAllowed) => openPage(browser, navAllowed),
      close: () => browser.close().catch(noop),
      onDisconnected: (cb) => {
        browser.on("disconnected", cb);
      },
    };
    return driver;
  };
