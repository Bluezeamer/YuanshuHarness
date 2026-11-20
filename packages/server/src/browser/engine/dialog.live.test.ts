// 真 Chromium 的对话框往返：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 站点由测试自己起的本地 HTTP 服务给，经测试自己的代理转发（引擎的上下文只接受走代理）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { watchDialogs } from "./dialog.js";
import { Engine } from "./engine.js";
import type { BrowserCtx, PageHandle } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";
const SITE = "site.test";

// 三个按钮各弹一种对话框；confirm / prompt 的结果写回页面与标题，用来断言页面 JS 继续跑了。
const PAGE = `<!doctype html><meta charset=utf-8><title>开始</title>
<button id="alert" onclick="alert('hi')">弹提示</button>
<button id="confirm" onclick="document.title = confirm('sure?') ? '确定:是' : '确定:否'">弹确认</button>
<button id="prompt" onclick="document.title = '输入:' + (prompt('name?', 'x') ?? '取消')">弹输入</button>
<div id="out">无</div>
<script>
  document.getElementById("confirm").addEventListener("click", () => {
    document.getElementById("out").textContent = document.title;
  });
  document.getElementById("prompt").addEventListener("click", () => {
    document.getElementById("out").textContent = document.title;
  });
</script>`;

// 离开页面时弹 beforeunload（先要有一次用户交互，浏览器才认）。
const LEAVE = `<!doctype html><meta charset=utf-8><title>离开页</title>
<button id="touch">动一下</button>
<a id="go" href="/done">去别处</a>
<script>
  window.addEventListener("beforeunload", (e) => {
    e.preventDefault();
    e.returnValue = "真的离开吗？";
    return "真的离开吗？";
  });
</script>`;
const DONE = `<!doctype html><meta charset=utf-8><title>到了</title><p>done</p>`;

interface Harness {
  proxyPort: number;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const pages: Record<string, string> = {
    "/": PAGE,
    "/leave": LEAVE,
    "/done": DONE,
    "/next": `<title>别处</title><p>next</p>`,
  };
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[req.url ?? "/"] ?? PAGE);
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

const refOf = (snap: string, label: string): string => {
  const line = snap.split("\n").find((l) => l.includes(label));
  const ref = line ? /\[ref=(\w+)\]/.exec(line)?.[1] : undefined;
  if (!ref) throw new Error(`快照里找不到「${label}」的编号：\n${snap}`);
  return ref;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(20);
  }
  return false;
}

/** 等标题变成期望值：dismiss / 超时都是异步收尾，页面恢复之前读标题会拿到空串。 */
async function waitForTitle(
  p: { title(): Promise<string> },
  want: string,
): Promise<boolean> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if ((await p.title()) === want) return true;
    await sleep(50);
  }
  return false;
}

describe.skipIf(!enabled)("对话框（真实 Chromium）", () => {
  let engine: Engine;
  let harness: Harness;
  let ctx: BrowserCtx;

  const page = async (path = "/"): Promise<PageHandle> => {
    const p = await ctx.newPage();
    await p.goto(`http://${SITE}${path}`);
    return p;
  };

  beforeAll(async () => {
    if (!enabled) return;
    harness = await startHarness();
    engine = new Engine({
      dataDir: makeTmpDir("ys-dialog-live-"),
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

  test("alert：click 在对话框弹出时返回，状态可读，回答后页面照常可读", async () => {
    const p = await page();
    const snap = await p.snapshot();
    await p.click(refOf(snap, "弹提示"));
    expect(p.dialog()).toEqual({
      type: "alert",
      message: "hi",
      defaultValue: "",
    });
    expect(await p.answerDialog(true)).toBe(true);
    expect(p.dialog()).toBeNull();
    // 回答之后页面主线程恢复：快照能读。
    expect(await p.snapshot()).toContain("弹提示");
    await p.close();
  }, 30_000);

  test("exec：脚本弹出对话框时立刻返回说明，回答之后页面照常可用", async () => {
    const p = await page();
    const out = await p.exec("alert('from script'); return 1", null);
    expect(out.kind).toBe("threw");
    if (out.kind === "threw") expect(out.message).toContain("对话框");
    expect(p.dialog()?.message).toBe("from script");
    expect(await p.answerDialog(true)).toBe(true);
    expect(await p.exec("return 2", null)).toEqual({
      kind: "value",
      json: "2",
    });
    await p.close();
  }, 30_000);

  test("confirm：确定与取消各一次，页面 JS 拿到正确的布尔值", async () => {
    const p = await page();
    await p.click(refOf(await p.snapshot(), "弹确认"));
    expect(p.dialog()?.type).toBe("confirm");
    expect(p.dialog()?.message).toBe("sure?");
    await p.answerDialog(true);
    expect(await p.title()).toBe("确定:是");
    expect(await p.snapshot()).toContain("确定:是");

    await p.click(refOf(await p.snapshot(), "弹确认"));
    expect(p.dialog()?.type).toBe("confirm");
    await p.answerDialog(false);
    expect(await p.title()).toBe("确定:否");
    expect(await p.snapshot()).toContain("确定:否");
    await p.close();
  }, 30_000);

  test("prompt：带文字与用默认值各一次", async () => {
    const p = await page();
    await p.click(refOf(await p.snapshot(), "弹输入"));
    expect(p.dialog()).toEqual({
      type: "prompt",
      message: "name?",
      defaultValue: "x",
    });
    await p.answerDialog(true, "小红");
    expect(await p.title()).toBe("输入:小红");

    await p.click(refOf(await p.snapshot(), "弹输入"));
    await p.answerDialog(true);
    expect(await p.title()).toBe("输入:x");
    await p.close();
  }, 30_000);

  test("onDialog 在出现与消失时都触发", async () => {
    const p = await page();
    const seen: (string | null)[] = [];
    const off = p.onDialog(() => seen.push(p.dialog()?.type ?? null));
    await p.click(refOf(await p.snapshot(), "弹提示"));
    expect(seen).toEqual(["alert"]);
    await p.answerDialog(false);
    expect(seen).toEqual(["alert", null]);
    off();
    await p.click(refOf(await p.snapshot(), "弹提示"));
    await p.answerDialog(false);
    expect(seen).toEqual(["alert", null]);
    await p.close();
  }, 30_000);

  test("beforeunload：离开页面时挂起，取消则留在原页", async () => {
    const p = await page("/leave");
    await p.click(refOf(await p.snapshot(), "动一下"));
    // goto 在对话框弹出时就返回（页面主线程卡住，不等导航结束）。
    const res = await p.goto(`http://${SITE}/next`);
    expect(res.status).toBeNull();
    expect(p.dialog()?.type).toBe("beforeunload");
    expect(await p.answerDialog(false)).toBe(true);
    expect(p.url()).toContain("/leave");
    // dismiss 是异步的：等页面真正恢复之后再读标题（否则会拿到空串）。
    expect(await waitForTitle(p, "离开页")).toBe(true);
    await p.close();
  }, 30_000);

  test("超时自动取消：小超时下对话框自己消失，页面恢复可用", async () => {
    // 句柄用默认的 120 秒，这个用例要小超时：直接对同一个 Chromium 起一个裸页面验超时。
    const browser = await chromium.launch({ executablePath: EXE });
    try {
      const raw = await browser.newPage();
      await raw.setContent(
        `<title>超时页</title><button id="go" onclick="alert('慢慢来')">弹</button>`,
      );
      const watch = watchDialogs(raw, 200);
      // click 会一直等到对话框被关掉：不 await 它，先看对话框挂上了。
      const clicking = raw.click("#go").catch(() => {});
      expect(await waitFor(() => watch.current() !== null, 2000)).toBe(true);
      expect(watch.current()?.type).toBe("alert");
      expect(await waitFor(() => watch.current() === null, 3000)).toBe(true);
      await clicking;
      // 页面主线程恢复了：标题读得回来。
      expect(await waitForTitle(raw, "超时页")).toBe(true);
    } finally {
      await browser.close().catch(() => {});
    }
  }, 30_000);
});
