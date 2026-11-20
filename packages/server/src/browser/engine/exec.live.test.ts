// runScript 的真浏览器端到端：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 直接用 Playwright 起浏览器（不经引擎与代理）：夹具就在本机 http 站点上。
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runScript } from "./exec.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";

// 夹具：页面变量与函数、按按钮改 DOM、严格 CSP（script-src 'self'，没有 unsafe-eval）。
const PAGE = `<!doctype html><meta charset=utf-8><title>脚本页</title>
<div id="a">原来的字</div>
<button id="b" onclick="document.getElementById('a').textContent = '改过了'">改字</button>
<script src="/app.js"></script>`;
const APP = `window.__state = { a: 1, nested: { b: "x" } };
window.__later = (ms) => new Promise((ok) => setTimeout(() => ok("到了"), ms));
function __add(x, y) { return x + y; }
window.__add = __add;`;

const CSP = `<!doctype html><meta charset=utf-8><title>严格 CSP</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">
<div id="a">严格页</div>
<script>window.__inlineRan = "yes";</script>
<script src="/csp.js"></script>`;
const CSP_APP = `window.__cspState = "csp 页面里的变量";`;

interface Site {
  port: number;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const pages: Record<string, string> = { "/": PAGE, "/csp": CSP };
  const scripts: Record<string, string> = {
    "/app.js": APP,
    "/csp.js": CSP_APP,
  };
  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    const script = scripts[path];
    if (script !== undefined) {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end(script);
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[path] ?? PAGE);
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

const refOf = (snap: string, label: string): string => {
  const line = snap.split("\n").find((l) => l.includes(label));
  const ref = line ? /\[ref=(\w+)\]/.exec(line)?.[1] : undefined;
  if (!ref) throw new Error(`快照里找不到「${label}」的编号：\n${snap}`);
  return ref;
};

/** 跑一段脚本并解析结果；结果是字符串 undefined 时给 null（JSON 里没有这个字）。 */
const json = async (page: Page, script: string, ref: string | null = null) => {
  const out = await runScript(page, script, ref);
  if (out.kind !== "value") throw new Error(`脚本抛了异常：${out.message}`);
  return out.json === "undefined" ? null : (JSON.parse(out.json) as unknown);
};

describe.skipIf(!enabled)("runScript（真实 Chromium）", () => {
  let browser: Browser;
  let site: Site;
  let page: Page;
  const url = (path = "/") => `http://127.0.0.1:${site.port}${path}`;

  beforeAll(async () => {
    if (!enabled) return;
    site = await startSite();
    browser = await chromium.launch({ executablePath: EXE });
    page = await browser.newPage();
    await page.goto(url());
    await page.waitForLoadState("load");
  });

  afterAll(async () => {
    if (!enabled) return;
    await browser?.close().catch(() => {});
    await site?.close().catch(() => {});
  });

  test("读页面全局变量、调页面函数、await 一个延迟的 Promise", async () => {
    expect(await json(page, "return window.__state.a")).toBe(1);
    expect(await json(page, "return window.__add(2, 3)")).toBe(5);
    expect(await json(page, "return await window.__later(50)")).toBe("到了");
  });

  test("复杂对象按规则序列化：函数 / DOM 节点 / Map / Set / 环 / bigint / NaN / window", async () => {
    const out = await runScript(
      page,
      `const loop = { name: "loop" };
       loop.self = loop;
       return {
         fn: window.__add,
         anon: () => 1,
         unnamed: ((x) => x),
         el: document.getElementById("a"),
         text: document.createTextNode("hi"),
         map: new Map([["k", 1]]),
         set: new Set([1, 2]),
         err: new TypeError("炸了"),
         n: 10n,
         nan: NaN,
         inf: -Infinity,
         win: window,
         loop,
         arr: [1, "两", null, true],
       };`,
      null,
    );
    expect(out.kind).toBe("value");
    if (out.kind !== "value") return;
    const value = JSON.parse(out.json) as Record<string, unknown>;
    expect(value.fn).toBe("[Function __add]");
    expect(value.anon).toBe("[Function anon]");
    expect(value.unnamed).toMatch(/^\[Function/);
    expect(value.el).toBe("[Element <div#a>]");
    expect(value.text).toBe("[Node 3]");
    expect(value.map).toEqual({ "[Map]": [["k", 1]] });
    expect(value.set).toEqual({ "[Set]": [1, 2] });
    expect(value.err).toMatchObject({ name: "TypeError", message: "炸了" });
    expect(typeof (value.err as { stack: string }).stack).toBe("string");
    expect(value.n).toBe("10n");
    expect(value.nan).toBe("NaN");
    expect(value.inf).toBe("-Infinity");
    expect(value.win).toBe("[Window]");
    expect(value.loop).toEqual({ name: "loop", self: "[Circular]" });
    expect(value.arr).toEqual([1, "两", null, true]);
  });

  test("同一个对象在不同分支各出现一次不算环；深对象不受 Playwright 的序列化深度限制", async () => {
    expect(
      await json(
        page,
        "const shared = { a: 1 }; return { x: shared, y: shared }",
      ),
    ).toEqual({ x: { a: 1 }, y: { a: 1 } });
    const deep = await runScript(
      page,
      "let o = { end: true }; for (let i = 0; i < 100; i++) o = { next: o }; return o;",
      null,
    );
    expect(deep.kind).toBe("value");
    if (deep.kind !== "value") return;
    expect(deep.json).toContain('"end": true');
    expect(deep.json.split("\n").length).toBeGreaterThan(100);
  });

  test("undefined 结果写字符串 undefined；没有 return 也是 undefined", async () => {
    expect(await runScript(page, "return undefined;", null)).toEqual({
      kind: "value",
      json: "undefined",
    });
    const out = await runScript(page, "window.__noop = 1;", null);
    expect(out).toEqual({ kind: "value", json: "undefined" });
  });

  test("getter 抛异常时写 [unserializable: …]", async () => {
    const out = await runScript(
      page,
      'return { get boom() { throw new Error("读不了"); } };',
      null,
    );
    expect(out).toEqual({
      kind: "value",
      json: "[unserializable: 读不了]",
    });
  });

  test("ref：函数体里多一个 el；编号失效时报「编号已失效」", async () => {
    const snap = await page.ariaSnapshot({ mode: "ai" });
    const ref = refOf(snap, "原来的字");
    expect(
      await json(page, "return el.tagName + ':' + el.textContent", ref),
    ).toBe("DIV:原来的字");
    expect(await json(page, "return typeof el", null)).toBe("undefined");
    const fail = async (bad: string) =>
      (
        (await runScript(page, "return 1", bad).catch(
          (e: unknown) => e,
        )) as Error
      ).message;
    expect(await fail("e9999")).toContain("已失效");
    expect(await fail("zzz")).toContain("编号格式不对");
  });

  test("脚本抛异常：threw 带 name、message 与栈", async () => {
    const out = await runScript(
      page,
      'throw new TypeError("脚本里的错");',
      null,
    );
    expect(out.kind).toBe("threw");
    if (out.kind !== "threw") return;
    const lines = out.message.split("\n");
    expect(lines[0]).toBe("TypeError: 脚本里的错");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toMatch(/at /);
    // 不是 Error 的抛出物照 String。
    expect(await runScript(page, 'throw "一句话";', null)).toEqual({
      kind: "threw",
      message: "一句话",
    });
  });

  test("严格 CSP 页面（script-src 'self'）：页面里自己的行内脚本被拦，exec 仍然能跑", async () => {
    const p = await browser.newPage();
    try {
      await p.goto(url("/csp"));
      // CSP 生效：行内脚本没跑（外链的跑了）。
      expect(await json(p, "return String(window.__inlineRan)")).toBe(
        "undefined",
      );
      expect(await json(p, "return window.__cspState")).toBe(
        "csp 页面里的变量",
      );
    } finally {
      await p.close();
    }
  });

  test("脚本以 // 行注释结尾也能正常执行", async () => {
    expect(await json(page, "return 1 + 1; // 注释结尾")).toBe(2);
  });

  test("改 DOM 之后快照能看到变化", async () => {
    const p = await browser.newPage();
    try {
      await p.goto(url());
      expect(await p.ariaSnapshot({ mode: "ai" })).toContain("原来的字");
      await runScript(
        p,
        'document.getElementById("a").textContent = "脚本改的";',
        null,
      );
      expect(await p.ariaSnapshot({ mode: "ai" })).toContain("脚本改的");
    } finally {
      await p.close();
    }
  });

  test("死循环：小超时下抛超时错误（用例结束关掉这个页面）", async () => {
    const p = await browser.newPage();
    try {
      await p.goto(url());
      const started = Date.now();
      const err = (await runScript(p, "while (true) {}", null, 500).catch(
        (e: unknown) => e,
      )) as Error;
      expect(err.message).toContain("脚本 1 秒内没有返回");
      expect(err.message).toContain("死循环");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await p.close();
    }
  }, 20_000);
});
