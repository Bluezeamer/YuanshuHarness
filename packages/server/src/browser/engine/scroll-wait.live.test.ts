// 滚动之后等内容变化：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 站点由测试自己起的本地 HTTP 服务给，经测试自己的代理转发（引擎的上下文只接受走代理）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { CAP_MS, PROBE_MS, watchAdditions } from "./content-wait.js";
import { Engine } from "./engine.js";
import type { BrowserCtx, PageHandle } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";
const SITE = "site.test";

const ITEM_HEIGHT = 120;
const FIRST_PAGE = 10;
const MORE = 10;
// 触底判定（夹具里用的距离）。
const NEAR_BOTTOM = 150;

/** 无限滚动夹具：mode 决定怎么触发，ms 是 /more 的延迟。 */
const infinite = (mode: "scroll" | "observer", ms: number) =>
  `<!doctype html><meta charset=utf-8><title>无限滚动页</title>
<body style="margin:0">
<ul id="list" style="margin:0;padding:0;list-style:none">${Array.from(
    { length: FIRST_PAGE },
    (_, i) =>
      `<li style="height:${ITEM_HEIGHT}px;border-bottom:1px solid #ddd">第 ${i + 1} 条</li>`,
  ).join("")}</ul>
<div id="sentinel" style="height:1px"></div>
<script>
  let loading = false;
  const list = document.getElementById("list");
  const load = () => {
    if (loading) return;
    loading = true;
    fetch("/more?ms=${ms}")
      .then((r) => r.json())
      .then((texts) => {
        for (const text of texts) {
          const li = document.createElement("li");
          li.style.height = "${ITEM_HEIGHT}px";
          li.textContent = text;
          list.appendChild(li);
        }
        loading = false;
      });
  };
  const nearBottom = () =>
    innerHeight + scrollY >= document.documentElement.scrollHeight - ${NEAR_BOTTOM};
  ${
    mode === "observer"
      ? `new IntersectionObserver(
            (entries) => { for (const e of entries) if (e.isIntersecting) load() },
            { rootMargin: "0px 0px ${NEAR_BOTTOM}px 0px" },
          ).observe(document.getElementById("sentinel"));`
      : `addEventListener("scroll", () => { if (nearBottom()) load() });`
  }
</script>`;

// 一带而过的长页面：没有加载逻辑（到底了也没东西可加载）。
const plain = (extra = "") =>
  `<!doctype html><meta charset=utf-8><title>长页</title>
<body style="margin:0"><ul id="list" style="margin:0;padding:0;list-style:none">${Array.from(
    { length: FIRST_PAGE },
    (_, i) => `<li style="height:${ITEM_HEIGHT}px">第 ${i + 1} 条</li>`,
  ).join("")}</ul>${extra}</body>`;

// 骨架先到、真内容后到：骨架是同步插入的节点，真内容等 /more 回来再插。
const SKELETON = plain().replace(
  "</body>",
  `<script>
  let loading = false;
  const list = document.getElementById("list");
  addEventListener("scroll", () => {
    if (loading) return;
    if (innerHeight + scrollY < document.documentElement.scrollHeight - ${NEAR_BOTTOM}) return;
    loading = true;
    const skel = document.createElement("li");
    skel.id = "skeleton";
    skel.textContent = "加载中";
    list.appendChild(skel);
    fetch("/more?ms=500")
      .then((r) => r.json())
      .then((texts) => {
        skel.remove();
        for (const text of texts) {
          const li = document.createElement("li");
          li.style.height = "${ITEM_HEIGHT}px";
          li.textContent = text;
          list.appendChild(li);
        }
        loading = false;
      });
  });
</script></body>`,
);

// 永不结束的请求：滚动触发的 fetch 一直不回来。
const HANG = plain().replace(
  "</body>",
  `<script>
  let started = false;
  addEventListener("scroll", () => {
    if (started) return;
    if (innerHeight + scrollY < document.documentElement.scrollHeight - ${NEAR_BOTTOM}) return;
    started = true;
    fetch("/never").catch(() => {});
  });
</script></body>`,
);

// 滚到底之后才建 WebSocket 长连接：它在滚动之后发出、本来就一直不结束，不能算「在飞」。
const WS = plain().replace(
  "</body>",
  `<script>
  let opened = false;
  addEventListener("scroll", () => {
    if (opened) return;
    if (innerHeight + scrollY < document.documentElement.scrollHeight - ${NEAR_BOTTOM}) return;
    opened = true;
    window.__ws = new WebSocket("ws://" + location.host + "/ws");
  });
</script></body>`,
);

// 属性噪声：每 50ms 切一次 class、改一次属性（都不是「新增节点」）。
const NOISE = plain().replace(
  "</body>",
  `<div id="noise">噪声</div>
<script>
  const noise = document.getElementById("noise");
  let on = false;
  setInterval(() => {
    on = !on;
    noise.className = on ? "on" : "off";
    noise.setAttribute("data-tick", on ? "1" : "0");
  }, 50);
</script></body>`,
);

// to 用的夹具：底部那个目标元素进入视口才触发加载。
const TO = `<!doctype html><meta charset=utf-8><title>滚到目标页</title>
<body style="margin:0">
<ul id="list" style="margin:0;padding:0;list-style:none">${Array.from(
  { length: FIRST_PAGE },
  (_, i) => `<li style="height:${ITEM_HEIGHT}px">第 ${i + 1} 条</li>`,
).join("")}</ul>
<button id="deep" style="height:200px">底部目标</button>
<script>
  let loading = false;
  const list = document.getElementById("list");
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || loading) continue;
      loading = true;
      fetch("/more?ms=700")
        .then((r) => r.json())
        .then((texts) => {
          for (const text of texts) {
            const li = document.createElement("li");
            li.style.height = "${ITEM_HEIGHT}px";
            li.textContent = text;
            list.appendChild(li);
          }
          loading = false;
        });
    }
  }, { rootMargin: "0px 0px ${NEAR_BOTTOM}px 0px" }).observe(document.getElementById("deep"));
</script></body>`;

interface Harness {
  proxyPort: number;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  let served = FIRST_PAGE;
  const pages: Record<string, string> = {
    "/plain": plain(),
    "/skeleton": SKELETON,
    "/hang": HANG,
    "/ws": WS,
    "/noise": NOISE,
    "/to": TO,
  };
  // 永不结束的响应也要能被关掉：留着 socket，测试结束时统一销毁。
  const hanging = new Set<http.ServerResponse>();

  const site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.pathname === "/more") {
      const ms = Number(url.searchParams.get("ms") ?? 0);
      served += MORE;
      const texts = Array.from(
        { length: MORE },
        (_, i) => `第 ${served - MORE + i + 1} 条`,
      );
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(texts));
      }, ms);
      return;
    }
    if (url.pathname === "/never") {
      hanging.add(res);
      return;
    }
    if (url.pathname === "/infinite") {
      const mode =
        url.searchParams.get("mode") === "observer" ? "observer" : "scroll";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(infinite(mode, Number(url.searchParams.get("ms") ?? 700)));
      return;
    }
    const html = pages[url.pathname];
    if (html === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  const wss = new WebSocketServer({ noServer: true });
  site.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 客户端主动关就行，服务端不做别的。
      ws.on("close", () => {});
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
  // WebSocket 走 CONNECT：转成到本地站点的裸隧道。
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
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    proxyPort,
    close: async () => {
      for (const res of hanging) res.destroy();
      hanging.clear();
      for (const client of wss.clients) client.terminate();
      wss.close();
      proxy.closeAllConnections();
      site.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await new Promise<void>((r) => site.close(() => r()));
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 在页面里跑一句脚本，把返回值当 JSON 解析回来。 */
async function readJson<T>(p: PageHandle, script: string): Promise<T> {
  const out = await p.exec(script, null);
  if (out.kind === "threw") throw new Error(out.message);
  return JSON.parse(out.json) as T;
}

/** 列表里有几个条目。 */
const items = (p: PageHandle) =>
  readJson<number>(p, `return document.querySelectorAll("#list li").length`);

describe.skipIf(!enabled)("滚动之后等内容变化（真实 Chromium）", () => {
  let engine: Engine;
  let harness: Harness;
  let ctx: BrowserCtx;

  const page = async (path: string): Promise<PageHandle> => {
    const p = await ctx.newPage();
    await p.goto(`http://${SITE}${path}`);
    return p;
  };

  /** 跑一次动作，量它的耗时。 */
  const timed = async <T>(run: () => Promise<T>) => {
    const at = Date.now();
    const value = await run();
    return { ms: Date.now() - at, value };
  };

  beforeAll(async () => {
    if (!enabled) return;
    harness = await startHarness();
    engine = new Engine({
      dataDir: makeTmpDir("ys-scroll-wait-"),
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

  test("滚动事件触发的无限滚动：新内容在同一次返回里（不是再等一拍）", async () => {
    const p = await page("/infinite?mode=scroll&ms=700");
    expect(await items(p)).toBe(FIRST_PAGE);
    const { ms } = await timed(() => p.scroll({ direction: "down" }));
    expect(await items(p)).toBe(FIRST_PAGE + MORE);
    console.log(`滚动事件触发：${ms}ms，条目 ${FIRST_PAGE + MORE}`);
  }, 20_000);

  test("哨兵（IntersectionObserver）触发的无限滚动：同样在这次返回里", async () => {
    const p = await page("/infinite?mode=observer&ms=700");
    expect(await items(p)).toBe(FIRST_PAGE);
    const { ms } = await timed(() => p.scroll({ direction: "down" }));
    expect(await items(p)).toBe(FIRST_PAGE + MORE);
    console.log(`哨兵触发：${ms}ms，条目 ${FIRST_PAGE + MORE}`);
  }, 20_000);

  test("加载很快：不被强制多等，条目已经增加", async () => {
    const p = await page("/infinite?mode=scroll&ms=100");
    const { ms } = await timed(() => p.scroll({ direction: "down" }));
    expect(ms).toBeLessThan(1000);
    expect(await items(p)).toBe(FIRST_PAGE + MORE);
    console.log(`加载很快：${ms}ms，条目 ${FIRST_PAGE + MORE}`);
  }, 20_000);

  test("到底了没东西可加载：只等到 PROBE 那一点，不等满 CAP", async () => {
    const p = await page("/plain");
    const { ms } = await timed(() => p.scroll({ direction: "down" }));
    expect(ms).toBeLessThan(1500);
    expect(ms).toBeGreaterThanOrEqual(PROBE_MS);
    console.log(`到底了没东西：${ms}ms`);
  }, 20_000);

  test("永不结束的请求：等到 CAP 才返回，不抛错", async () => {
    const p = await page("/hang");
    const { ms, value } = await timed(() =>
      p.scroll({ direction: "down", amount: 400 }),
    );
    expect(value.after.y).toBeGreaterThan(0);
    expect(ms).toBeGreaterThanOrEqual(CAP_MS);
    expect(ms).toBeLessThan(CAP_MS + 1500);
    console.log(`永不结束的请求：${ms}ms`);
  }, 8_000);

  test("WebSocket 长连接不算在飞：滚动之后才建的连接不妨碍快速返回", async () => {
    const p = await page("/ws");
    const { ms } = await timed(() => p.scroll({ direction: "down" }));
    expect(ms).toBeLessThan(1500);
    // 连接确实是滚动之后建的（它一直不结束，算进去就会等到 CAP）。
    expect(
      await readJson<number>(
        p,
        `return new Promise((r) => {
           const ws = window.__ws;
           if (ws === undefined) return r(0);
           if (ws.readyState === 1) return r(1);
           ws.addEventListener("open", () => r(1));
           ws.addEventListener("error", () => r(0));
         })`,
      ),
    ).toBe(1);
    console.log(`滚动后建 WebSocket + 没东西可加载：${ms}ms`);
  }, 20_000);

  test("属性噪声不算新增：切换 class / 改属性不影响快速返回", async () => {
    const p = await page("/noise");
    await sleep(200); // 让噪声先跑起来
    const { ms } = await timed(() => p.scroll({ direction: "down" }));
    expect(ms).toBeLessThan(1500);
    console.log(`属性噪声 + 没东西可加载：${ms}ms`);
  }, 20_000);

  test("骨架先到、真内容后到：靠请求在飞撑住，返回时已经是真内容", async () => {
    const p = await page("/skeleton");
    const { ms } = await timed(() => p.scroll({ direction: "down" }));
    expect(await items(p)).toBe(FIRST_PAGE + MORE);
    expect(
      await readJson<boolean>(
        p,
        `return document.getElementById("skeleton") === null`,
      ),
    ).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(300 + 500 - 100);
    console.log(`骨架先到：${ms}ms，条目 ${FIRST_PAGE + MORE}`);
  }, 20_000);

  test("to 滚动也适用：滚到元素触发的加载同样在这次返回里", async () => {
    const p = await page("/to");
    const snap = await p.snapshot();
    const ref = /"底部目标" \[ref=(\w+)\]/.exec(snap)?.[1] ?? "";
    expect(ref).not.toBe("");
    const { ms } = await timed(() => p.scroll({ to: ref }));
    expect(await items(p)).toBe(FIRST_PAGE + MORE);
    console.log(`to 滚动：${ms}ms，条目 ${FIRST_PAGE + MORE}`);
  }, 20_000);
});

// 观察器本身：直接用 Playwright 起浏览器（不经引擎与代理），逐条验证它数什么、不数什么。
describe.skipIf(!enabled)("页面里的新增观察器（真实 Chromium）", () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let site: http.Server;
  let port = 0;

  beforeAll(async () => {
    if (!enabled) return;
    site = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(plain(`<div id="noise">噪声</div><div id="text">起点</div>`));
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    port = (site.address() as AddressInfo).port;
    browser = await chromium.launch({ executablePath: EXE });
  });

  afterAll(async () => {
    if (!enabled) return;
    await browser?.close().catch(() => {});
    if (site) {
      site.closeAllConnections();
      await new Promise<void>((r) => site.close(() => r()));
    }
  });

  test("只数新增的元素与有文字的文字节点；属性切换、改文字都不算；stop 之后状态删干净", async () => {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${port}/`);
    const watch = await watchAdditions(tab);
    expect(await watch.read()).toEqual({ count: 0, lastAt: 0 });

    // 页面脚本看不到观察器：window 上没有 yuanshu 的名字（符号键也不在字符串键里）。
    const names = await tab.evaluate(
      "Object.getOwnPropertyNames(window).filter((n) => /yuanshu|addition/i.test(n))",
    );
    expect(names).toEqual([]);

    // 属性切换与改文字：都不算。
    await tab.evaluate(`(() => {
      const noise = document.getElementById("noise");
      noise.className = "on";
      noise.setAttribute("data-tick", "1");
      document.getElementById("text").firstChild.data = "改过的文字";
    })()`);
    await sleep(100);
    expect(await watch.read()).toEqual({ count: 0, lastAt: 0 });

    // 一个元素 + 一段有文字的文字节点：算 2；只有空白的文字节点不算。
    await tab.evaluate(`(() => {
      const box = document.createElement("div");
      box.textContent = "新内容";
      document.body.appendChild(box);
      document.body.appendChild(document.createTextNode("   "));
      document.body.appendChild(document.createTextNode("一段新文字"));
    })()`);
    await sleep(100);
    const added = await watch.read();
    expect(added.count).toBe(2);
    expect(added.lastAt).toBeGreaterThan(0);

    // 再新增一个元素：计数继续累加，lastAt 往后走。
    await sleep(20);
    await tab.evaluate(
      `document.body.appendChild(document.createElement("span"))`,
    );
    await sleep(100);
    const more = await watch.read();
    expect(more.count).toBe(3);
    expect(more.lastAt).toBeGreaterThan(added.lastAt);

    await watch.stop();
    expect(
      await tab.evaluate(
        'Symbol.for("yuanshu.additions") in globalThis ? "present" : "absent"',
      ),
    ).toBe("absent");
    // 停了之后不再记。
    await tab.evaluate(
      `document.body.appendChild(document.createElement("i"))`,
    );
    await sleep(100);
    expect(await watch.read()).toEqual({ count: 0, lastAt: 0 });
    await tab.close();
  }, 20_000);
});
