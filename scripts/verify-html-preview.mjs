// 预览标签里 HTML 文件的内嵌预览的真机检查：起真实 Server（临时数据目录）+ 本地假「CDN」+ 无头 Chromium，不需要真实模型。
// jsdom 里 iframe 不会真的加载页面，沙箱隔离、外部资源、缩放盒子都只有真浏览器测得出：
//  1) 默认是源码编辑态；切到「预览」才出现 iframe，旁边有「在浏览器中打开」
//  2) 自包含页面正常运行：内联脚本执行、外部（CDN）脚本与样式加载、对 CDN 的跨域 fetch 成功
//  3) 隔离：页面里读不到本应用的 sessionStorage（令牌就存在那里），也摸不到上层文档
//  4) CDN 收到的请求不带 Referer（不把本应用的地址泄露给第三方）；上层文档的选区扫过 iframe 时不把它涂成选中色
//  5) 标签缩放：Ctrl+滚轮放大后 iframe 盒子仍刚好铺满窗格（不溢出），页面视口按比例变窄；点角标回到原样
//  6) 全程没有控制台报错、没有失败的接口请求
// 「在浏览器中打开」点下去之后浏览器标签的表现，由 verify-browser-ui.mjs 验。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-html-preview.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

// 假 CDN：脚本、样式、带 CORS 头的 JSON；记下每个请求带的 Referer
const hits = [];
const cdn = createServer((req, res) => {
  hits.push({ url: req.url, referer: req.headers.referer });
  if (req.url === "/lib.js") {
    res.setHeader("content-type", "text/javascript");
    res.end('window.__cdn = "ok";');
  } else if (req.url === "/style.css") {
    res.setHeader("content-type", "text/css");
    res.end("#t { color: rgb(1, 2, 3); }");
  } else if (req.url === "/data.json") {
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    res.end('{"v":1}');
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => cdn.listen(0, "127.0.0.1", r));
const CDN = `http://127.0.0.1:${cdn.address().port}`;

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "htmlpv-"));
const real = realpathSync(base);
const work = join(real, "work");
mkdirSync(work, { recursive: true });
// 自包含的单页：内联脚本改标题、外部脚本与样式、跨域 fetch；并探测能不能碰到上层的存储
writeFileSync(
  join(work, "demo.html"),
  `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${CDN}/style.css">
<h1 id="t">mock</h1><p id="out"></p>
<script src="${CDN}/lib.js"></script>
<script>
  const out = [];
  document.getElementById("t").textContent = "ready";
  out.push("cdn:" + window.__cdn);
  try { out.push("parent:" + parent.sessionStorage.getItem("probe")); }
  catch (e) { out.push("parent:" + e.name); }
  fetch("${CDN}/data.json").then((r) => r.json()).then((j) => out.push("fetch:" + j.v))
    .catch((e) => out.push("fetch:" + e.name))
    .finally(() => { document.getElementById("out").textContent = out.join("|"); });
</script>
`,
);

const port = 18500 + Math.floor(Math.random() * 90);
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
    join(real, "data"),
  ],
  { stdio: "ignore", cwd: work, env: { ...process.env, HOME: real } },
);
const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
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
    name: "占位",
    slug: "placeholder",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "x",
    models: [
      {
        id: "m",
        name: "m",
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
    name: "页面",
    directories: [{ path: work }],
  });
  await api("POST", "/sessions", { workspaceId: ws.id });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    // 令牌存在 sessionStorage 里：放一个探针值，页面里的脚本要是读得到就说明隔离破了
    await page.addInitScript(() => {
      if (window === window.top) sessionStorage.setItem("probe", "secret");
    });
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
    const shot = async (name) => {
      if (!SHOTS) return;
      await sleep(400);
      await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "页面" }).click();
    await page.waitForSelector(".ws-fm-row");
    await sleep(800);
    await page
      .locator('.ws-fm-row[data-name="demo.html"] .u-lrow-main')
      .dblclick();

    // 1) 默认编辑态：没有 iframe；切到预览才有
    await page.waitForSelector(".cm-content", { timeout: 8000 });
    check(
      "默认是源码编辑态，没有 iframe",
      (await page.locator("iframe.ws-pv-html-frame").count()) === 0,
    );
    await page.getByRole("radio", { name: "预览" }).click();
    await page.waitForSelector("iframe.ws-pv-html-frame", { timeout: 8000 });
    check(
      "预览态旁边有「在浏览器中打开」",
      (await page.getByRole("button", { name: "在浏览器中打开" }).count()) ===
        1,
    );
    const frame = await (
      await page.locator("iframe.ws-pv-html-frame").elementHandle()
    ).contentFrame();

    // 2) 页面正常运行：内联脚本、CDN 脚本与样式、跨域 fetch
    await frame.waitForFunction(
      () => document.getElementById("out")?.textContent?.includes("fetch:"),
      null,
      { timeout: 8000 },
    );
    const out = await frame.locator("#out").textContent();
    check(
      "内联脚本执行（标题被改成 ready）",
      (await frame.locator("#t").textContent()) === "ready",
    );
    check(
      "CDN 脚本加载并执行、跨域 fetch 成功",
      out.includes("cdn:ok") && out.includes("fetch:1"),
      out,
    );
    check(
      "CDN 样式生效",
      (await frame.evaluate(
        () => getComputedStyle(document.getElementById("t")).color,
      )) === "rgb(1, 2, 3)",
    );

    // 3) 隔离
    check(
      "页面读不到本应用的 sessionStorage（不透明源，SecurityError）",
      out.includes("parent:SecurityError"),
      out,
    );

    // 4) CDN 收到的请求没有 Referer
    const sent = hits.filter((h) => h.url === "/lib.js");
    check(
      "CDN 请求不带 Referer",
      sent.length > 0 && sent.every((h) => h.referer === undefined),
      JSON.stringify(hits.map((h) => h.referer)),
    );
    // 上层文档的选区扫过 iframe 时，浏览器会把整个框涂成选中色（双击文件打开后就会遇到）；iframe 要选不上
    await page.evaluate(() =>
      getSelection().selectAllChildren(document.querySelector(".ws-pv-tv")),
    );
    const swept = await page.locator("iframe.ws-pv-html-frame").screenshot();
    await page.evaluate(() => getSelection().removeAllRanges());
    const clean = await page.locator("iframe.ws-pv-html-frame").screenshot();
    check("上层选区扫过 iframe：不被涂成选中色", swept.equals(clean));
    await shot("1-embedded");

    // 5) 标签缩放：盒子仍铺满窗格，页面视口按比例变窄
    const boxes = () =>
      page.evaluate(() => {
        const f = document.querySelector("iframe.ws-pv-html-frame");
        const b = document.querySelector(".ws-pv-tv-body");
        const fr = f.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return {
          dw: Math.round(br.width - fr.width),
          dh: Math.round(br.height - fr.height),
        };
      });
    const innerW = () => frame.evaluate(() => window.innerWidth);
    const a = await boxes();
    const w0 = await innerW();
    check(
      "基准：iframe 盒子刚好铺满内容区",
      Math.abs(a.dw) <= 1 && Math.abs(a.dh) <= 1,
      JSON.stringify(a),
    );
    const bar = await page.locator(".ws-pv-gap").boundingBox();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -100);
      await sleep(80);
    }
    await page.keyboard.up("Control");
    await sleep(400);
    const b = await boxes();
    const w1 = await innerW();
    check(
      "放大 5 格（150%）：盒子仍铺满内容区，不溢出",
      Math.abs(b.dw) <= 1 && Math.abs(b.dh) <= 1,
      JSON.stringify(b),
    );
    check(
      "页面视口按比例变窄（约为原来的 1/1.5）",
      Math.abs(w1 - w0 / 1.5) <= 2,
      `${w0} -> ${w1}`,
    );
    await shot("2-zoomed");
    await page
      .getByRole("button", { name: /^\d+%$/ })
      .first()
      .click();
    await sleep(400);
    check("点角标：回到原来的视口宽度", (await innerW()) === w0);
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
  cdn.close();
  proc.kill("SIGTERM");
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

const uniq = [...new Set(problems)];
check(
  "全程没有控制台报错、没有失败的接口请求",
  uniq.length === 0,
  uniq.slice(0, 5).join(" | "),
);
if (crashed) {
  console.error(`脚本异常：${crashed.stack ?? crashed}`);
  process.exit(1);
}
const failed = results.filter((x) => !x).length;
console.log(
  failed
    ? `未通过：${failed} 项`
    : `PASS  HTML 内嵌预览：${results.length}/${results.length} 项通过`,
);
process.exit(failed ? 1 : 0);
