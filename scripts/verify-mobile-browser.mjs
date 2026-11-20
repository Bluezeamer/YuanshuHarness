// 手机端浏览器画面页的真机检查：起真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 假模型（按剧本真的调
// browser_open / browser_show）+ 本地假站点 + 无头 Chromium（手机设备描述：390×844、2 倍屏、触控）当手机，不需要真实模型。
//  1) 没有页面时对话页顶栏没有浏览器入口；agent 打开页面后出现，agent 在用时带小点
//  2) browser_show：手机弹出「展示了页面」提示，按钮是 ≥ 48 的触控目标；点「查看」进画面页，URL 带页面编号，画布出画
//  3) 画面页：默认适应宽度、画面比例不变形、没有横向滚动；写明「只读观察」；底部两个按钮 ≥ 48
//  4) 手势（CDP 触摸）：双指张开放大（不超过 200%）、单指拖动平移（不露出空白）、「适应宽度」「100%」复位
//  5) 只读：点画面不会到达页面（假站点收不到点击）
//  6) 屏幕常亮：画面页打开时向浏览器申请了 wakeLock
//  7) 页面切到后台时画面流断开，回前台重新连上；页面列表抽屉：列出页面、选当前页只关抽屉、选另一个页面换页，返回按历史一层层退
//  8) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
//   agent 用的浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用上面装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-mobile-browser.mjs [--shots 目录]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "./lib/fake-model.mjs";
import { agentChromePath, chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const agentChrome = agentChromePath();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};
/** 轮询到条件成立或超时；返回最后一次的取值。 */
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(200);
    v = await fn();
  }
  return v;
}

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "mobile-browser-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(dir, { recursive: true });

// 假站点：下半屏是一块橙色（采样画面像素用），整页点击会记一次（核对「只读」）
let siteHits = 0;
const site = http.createServer((req, res) => {
  if (req.url === "/hit") {
    siteHits += 1;
    return res.writeHead(204).end();
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
    `<!doctype html><title>报表页</title>
<body style="margin:0;background:white" onclick="fetch('/hit')">
<h1 style="margin:40px">季度报表</h1>
<div style="position:fixed;left:0;top:400px;width:1280px;height:400px;background:rgb(255,102,0)"></div>`,
  );
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;

const pageIdOf = (messages) => {
  for (const m of [...messages].reverse()) {
    const hit = /PAGE ID: ([a-z0-9]+) · HTTP/.exec(
      JSON.stringify(m.content ?? ""),
    );
    if (hit) return hit[1];
  }
  return "";
};
const fake = await startFakeModel(
  [
    // 先「启动服务」：命令输出里出现这个端口，之后 browser_open 才不用批准
    {
      tools: [
        {
          name: "bash",
          args: { command: `echo "ready on http://localhost:${sitePort}/"` },
        },
      ],
    },
    {
      tools: [
        { name: "browser_open", args: { target: `server:${sitePort}/` } },
      ],
    },
    {
      tools: [
        {
          name: "browser_show",
          args: (messages) => ({
            pageId: pageIdOf(messages),
            note: "看这个",
          }),
        },
      ],
    },
    { text: "已经展示给你了。" },
  ],
  { delay: 20 },
);

const TOKEN = "b".repeat(40);
const port = 18900 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const proc = spawn(
  "node",
  [
    join(root, "packages/server/dist/bin.js"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--data-dir",
    join(base, "data"),
  ],
  {
    stdio: "ignore",
    cwd: work,
    env: {
      ...process.env,
      YUANSHU_TOKEN: TOKEN,
      HOME: base,
      ...(agentChrome ? { YUANSHU_BROWSER: agentChrome } : {}),
    },
  },
);

const api = async (method, path, body, token = TOKEN) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

const problems = [];

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
  await api("POST", "/providers", {
    name: "假模型",
    slug: "fake",
    api: "openai-completions",
    baseUrl: fake.baseUrl,
    apiKey: "x",
    models: [
      {
        id: "fake",
        name: "fake",
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  const ws = await api("POST", "/workspaces", {
    name: "展示",
    directories: [{ path: dir }],
  });
  const { id: sid } = await api("POST", "/sessions", { workspaceId: ws.id });
  await api("PATCH", `/sessions/${sid}`, { title: "报表会话" });
  // 手机：配对拿设备令牌，直接写进本机存储
  const { code } = await api("POST", "/devices/pairing", {});
  const paired = await api(
    "POST",
    "/devices/pair",
    { code, name: "测试手机" },
    TOKEN,
  );

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    });
    await context.addInitScript((token) => {
      localStorage.setItem("yuanshu.token", token);
      // 数一数向浏览器申请了几次屏幕常亮
      window.__wake = 0;
      const wl = navigator.wakeLock;
      if (wl?.request) {
        const orig = wl.request.bind(wl);
        wl.request = (...a) => {
          window.__wake += 1;
          return orig(...a);
        };
      }
    }, paired.token);
    const page = await context.newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error")
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/") && r.status() >= 400)
        problems.push(`${r.status()} ${r.url().split("/api/v1")[1]}`);
    });
    const shot = (n) =>
      SHOTS ? page.screenshot({ path: join(SHOTS, `${n}.png`) }) : null;
    const path = () =>
      new URL(page.url()).pathname + new URL(page.url()).search;
    const cdp = await context.newCDPSession(page);
    const touch = (type, pts) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })),
      });
    const view = () =>
      page.evaluate(() => {
        const c = document.querySelector(".m-view-canvas");
        const m = new DOMMatrixReadOnly(getComputedStyle(c).transform);
        const r = document.querySelector(".m-view").getBoundingClientRect();
        return { s: m.a, x: m.e, y: m.f, w: r.width, h: r.height };
      });
    const viewers = async () => {
      const o = await api("GET", `/workspaces/${ws.id}/browser`);
      return o.pages[0]?.viewers ?? 0;
    };

    await page.goto(`${origin}/m/s/${sid}`);
    await page.waitForSelector(".ch-shell");
    await sleep(500);

    // 1) 没有页面时没有入口
    check(
      "没有页面时对话页顶栏没有浏览器入口",
      (await page.getByRole("button", { name: "浏览器" }).count()) === 0,
    );

    // 2) agent 打开并展示页面
    const box = page.locator(".ch-ta");
    await box.click();
    await page.keyboard.type("把报表展示给我看。");
    await page.getByRole("button", { name: "发送" }).click();
    const toast = page.locator(".u-toast", { hasText: "展示了页面" });
    await toast.waitFor({ timeout: 60000 });
    const sizes = await toast
      .locator("button")
      .evaluateAll((bs) =>
        bs.map((b) => Math.round(b.getBoundingClientRect().height)),
      );
    check(
      "browser_show：手机上弹出提示，按钮是 ≥ 48 的触控目标",
      sizes.length >= 2 && sizes.every((h) => h >= 47.5),
      JSON.stringify(sizes),
    );
    await shot("20-show-toast");
    check(
      "agent 打开页面后，顶栏出现浏览器入口",
      (await page.getByRole("button", { name: "浏览器" }).count()) === 1,
    );

    // 3) 点「查看」进画面页
    await toast.getByRole("button", { name: "查看" }).click();
    await page.waitForSelector(".m-view");
    check(
      "点「查看」：进画面页，URL 带页面编号与会话",
      /^\/m\/t\/web\?/.test(path()) &&
        path().includes("page=") &&
        path().includes(`sid=${sid}`),
      path(),
    );
    const drawn = await until(
      () =>
        page.evaluate(() => {
          const c = document.querySelector(".m-view-canvas");
          if (!c || c.width < 100) return false;
          const d = c.getContext("2d").getImageData(100, 600, 1, 1).data;
          return d[0] > 200 && d[1] > 70 && d[1] < 140 && d[2] < 60;
        }),
      20000,
    );
    check("画面里是假站点的内容（采样到橙色块）", drawn === true);
    await sleep(400);
    await shot("21-viewer");
    const fit = await view();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    check(
      "默认适应宽度：比例 = 容器宽 / 1280，顶端对齐，没有横向滚动",
      Math.abs(fit.s - fit.w / 1280) < 0.001 && fit.x === 0 && !overflow,
      JSON.stringify(fit),
    );
    const tools = await page.locator(".m-view-tools button").evaluateAll((bs) =>
      bs.map((b) => {
        const r = b.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      }),
    );
    check(
      "写明「只读观察」；底部按钮 ≥ 48×48",
      (await page.getByText("只读观察").count()) === 1 &&
        tools.length === 2 &&
        tools.every(([w, h]) => w >= 47.5 && h >= 47.5),
      JSON.stringify(tools),
    );

    // 4) 手势
    const r = await page.locator(".m-view").boundingBox();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    await touch("touchStart", [
      { x: cx - 30, y: cy },
      { x: cx + 30, y: cy },
    ]);
    for (const d of [60, 90, 120]) {
      await touch("touchMove", [
        { x: cx - d, y: cy },
        { x: cx + d, y: cy },
      ]);
    }
    await touch("touchEnd", []);
    await sleep(200);
    const zoomed = await view();
    check(
      "双指张开：放大（不超过 200%）",
      zoomed.s > fit.s * 2 && zoomed.s <= 2.001,
      JSON.stringify(zoomed),
    );
    await shot("22-zoomed");
    await touch("touchStart", [{ x: cx, y: cy }]);
    for (const d of [-40, -80, -120]) {
      await touch("touchMove", [{ x: cx + d, y: cy + d / 2 }]);
    }
    await touch("touchEnd", []);
    await sleep(200);
    const panned = await view();
    const content = 1280 * panned.s;
    check(
      "单指拖动：平移，且不露出空白（四边都贴着容器）",
      panned.x < zoomed.x &&
        panned.x <= 0 &&
        panned.x >= panned.w - content - 0.5 &&
        panned.y <= 0 &&
        panned.y >= panned.h - 800 * panned.s - 0.5,
      JSON.stringify({ zoomed, panned }),
    );
    await page.getByRole("button", { name: "适应宽度" }).click();
    await sleep(100);
    const refit = await view();
    await page.getByRole("button", { name: "100%" }).click();
    await sleep(100);
    const actual = await view();
    check(
      "「适应宽度」复位到初始比例；「100%」是 1:1",
      Math.abs(refit.s - fit.s) < 0.001 && Math.abs(actual.s - 1) < 0.001,
      JSON.stringify({ refit: refit.s, actual: actual.s }),
    );

    // 5) 只读
    await page.getByRole("button", { name: "适应宽度" }).click();
    const before = siteHits;
    await touch("touchStart", [{ x: cx, y: cy }]);
    await touch("touchEnd", []);
    await page.mouse.click(cx, cy);
    await sleep(800);
    check(
      "点画面不会到达页面（假站点没收到点击）",
      siteHits === before,
      `hits ${siteHits}`,
    );

    // 6) 屏幕常亮
    check(
      "画面页打开时申请了屏幕常亮",
      (await page.evaluate(() => window.__wake)) >= 1,
      String(await page.evaluate(() => window.__wake)),
    );

    // 7) 后台断流、回前台重连
    check(
      "画面流连着：服务端看到 1 个观看者",
      (await until(async () => (await viewers()) === 1)) === true,
    );
    const setVisible = (v) =>
      page.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", {
          value: state,
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, v);
    await setVisible("hidden");
    check(
      "切到后台：画面流断开（观看者归零）",
      (await until(async () => (await viewers()) === 0)) === true,
    );
    await setVisible("visible");
    check(
      "回到前台：画面流重新连上",
      (await until(async () => (await viewers()) === 1)) === true,
    );

    // 页面列表抽屉：再开一个页面，选它
    const firstPage = new URL(page.url()).searchParams.get("page");
    await api("POST", `/workspaces/${ws.id}/browser/pages`, {
      target: `server:${sitePort}/?second`,
    });
    await until(
      async () =>
        (await api("GET", `/workspaces/${ws.id}/browser`)).pages.length === 2,
    );
    await page.getByRole("button", { name: "页面列表" }).click();
    await page.waitForSelector(".u-sheet");
    await sleep(400);
    const rows = await page.locator(".u-sheet .m-row").allTextContents();
    await shot("23-pages");
    check(
      "页面列表抽屉：列出两个页面（标题 + 地址）",
      rows.length === 2 && rows.every((t) => t.includes("报表页")),
      JSON.stringify(rows),
    );
    // 选当前页：只是关抽屉
    await page.locator(".u-sheet .m-row").first().click();
    await page.waitForSelector(".u-sheet", { state: "detached" });
    check(
      "选当前页面：抽屉关掉，URL 不变",
      path().includes(`page=${firstPage}`) && !path().includes("layer="),
      path(),
    );
    await page.getByRole("button", { name: "页面列表" }).click();
    await page.waitForSelector(".u-sheet");
    await page.locator(".u-sheet .m-row").nth(1).click();
    await page.waitForSelector(".u-sheet", { state: "detached" });
    const secondPage = new URL(page.url()).searchParams.get("page");
    const redrawn = await until(
      () =>
        page.evaluate(() => {
          const c = document.querySelector(".m-view-canvas");
          const d = c.getContext("2d").getImageData(100, 600, 1, 1).data;
          return d[0] > 200 && d[2] < 60;
        }),
      20000,
    );
    check(
      "选另一个页面：换页（URL 的 page 变了），画面重新出画",
      secondPage !== firstPage && redrawn === true,
      `${firstPage} → ${secondPage}`,
    );
    await page.goBack();
    check(
      "返回一次回到上一个页面",
      new URL(page.url()).searchParams.get("page") === firstPage,
      path(),
    );
    await page.goBack();
    await page.waitForSelector(".ch-shell");
    check("再返回回到对话页", path() === `/m/s/${sid}`, path());
  } finally {
    await browser.close();
  }
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  proc.kill("SIGTERM");
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  site.close();
  await fake.close();
  rmSync(base, { recursive: true, force: true });
}

const uniq = [...new Set(problems)];
check(
  "全程没有控制台报错、没有失败的接口请求",
  uniq.length === 0,
  uniq.slice(0, 5).join(" | "),
);
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = results.filter((r) => !r).length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 项`
    : `\nPASS  手机端浏览器画面：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
