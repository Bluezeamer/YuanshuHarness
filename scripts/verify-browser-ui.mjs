// 浏览器标签界面的真机检查：起真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 本地假站点 + 无头 Chromium
// 当用户的浏览器，不需要真实模型。jsdom 测不出布局与输入，这里在真浏览器里量。
//  1) 新建浏览器标签：没有页面时是说明卡片；在页面列表里打开地址后画布出画，地址栏显示「主机名:端口」
//  2) 版式：工具条一行（36 高）、画面区 16:10 且不溢出舞台、窗格没有滚动条；控制台抽屉开关都不破坏画面比例
//  3) 手动态：点击与键盘输入真的到达假站点（含输入法：组词后上屏的中文、直接上屏的全角标点）；后退 / 刷新可用；地址栏回车导航
//     页面自己写剪贴板：点页面里的「分享」按钮（立刻写 / 1.5 秒后才写），本机剪贴板里是页面写的地址，并弹「页面复制了：…」
//     键盘修饰键：Alt 的 keyup 丢了（焦点离开）之后点链接，正常导航、不弹下载（Server 的键盘不会一直按着 Alt）
//     划选复制：在画面上三击选中正文 / 输入框里的字，按 Ctrl+C，本机剪贴板里是页面里选中的文字；没选中时不冲掉剪贴板里原有的内容
//  4) 观察态：点「交给 agent」后工具条换成只读地址 + 「手动操作」，画面上的点击不再到达页面；再接管后恢复
//  5) 控制台：页面里的 console.log 出现在抽屉里
//  6) 页面列表：「我的」分组、页面计数随开关变化，关闭页面后标签换到剩下的页面
//  7) 窄窗口（600 宽）：工具条仍是一行、没有横向滚动
//     窗格宽度（宽 > 640 文字按钮、500–640 只剩图标、400–500 次要动作收进「…」；≤ 400 那一档只出现在三窗格布局里，见 verify-browser-login）：每档工具条一行、地址栏至少 100 宽；「…」菜单里的动作真能用
//  8) 预览标签里的 HTML 文件：「在浏览器中打开」把它摆进浏览器标签
//  9) 刷新页面后标签仍显示同一页，画布重新出画
// 10) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
//   agent 用的浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用上面装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-ui.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(150);
    v = await fn();
  }
  return v;
}

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-ui-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "demo.html"),
  "<!doctype html><title>演示页</title><h1>来自文件的标题</h1>",
);

// —— 假站点：记录页面里发生的事，按钮与输入框用固定定位，页面坐标好算 ——
const hits = [];
const site = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/hit") {
    hits.push(url.searchParams.get("w"));
    res.writeHead(204).end();
    return;
  }
  const body = {
    "/": `<!doctype html><title>站点首页</title>
      <style>body{margin:0;font:20px sans-serif}
      #go{position:fixed;left:100px;top:100px;width:200px;height:60px}
      #u{position:fixed;left:100px;top:200px;width:400px;height:40px;font-size:20px}</style>
      <p id="para" style="position:fixed;left:100px;top:300px;margin:0">页面里可划选的一段话</p>
      <button id="go">点我</button><input id="u" aria-label="输入框">
      <button id="share" style="position:fixed;left:100px;top:400px;width:200px;height:60px">分享</button>
      <a id="lnk" href="/second" style="position:fixed;left:100px;top:560px;width:200px;height:40px">去第二页</a>
      <button id="later" style="position:fixed;left:100px;top:480px;width:200px;height:60px">稍后分享</button>
      <script>
        const hit = (w) => fetch("/hit?w=" + encodeURIComponent(w));
        document.getElementById("go").onclick = () => hit("click");
        document.getElementById("share").onclick = () =>
          navigator.clipboard.writeText("https://share.test/abc");
        document.getElementById("later").onclick = () =>
          setTimeout(() => navigator.clipboard.writeText("https://share.test/later"), 1500);
        document.getElementById("u").oninput = (e) => hit("input:" + e.target.value);
        console.log("hello-console");
      </script>`,
    "/second": "<!doctype html><title>第二页</title><h1>第二页</h1>",
  }[url.pathname];
  if (!body) {
    res.writeHead(404, { "content-type": "text/plain" }).end("nf");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;

const port = 18300 + Math.floor(Math.random() * 90);
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
      ...(agentChrome ? { YUANSHU_BROWSER: agentChrome } : {}),
    },
  },
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
    name: "浏览器",
    directories: [{ path: dir }],
  });
  await api("POST", "/sessions", { workspaceId: ws.id });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error")
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/") && r.status() >= 400)
        problems.push(
          `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
    });
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    const wb = page.locator(".ws-wb");
    const box = (sel) => page.locator(sel).first().boundingBox();
    const addr = () => page.getByLabel("页面地址");
    const btn = (name) => wb.getByRole("button", { name, exact: true }).first();
    const hitsOf = (w) => hits.filter((h) => h === w).length;

    /** 画布上的页面坐标 → 屏幕坐标 */
    const onCanvas = async (px, py) => {
      const b = await box(".ws-wb-canvas");
      return { x: b.x + (px / 1280) * b.width, y: b.y + (py / 800) * b.height };
    };
    /** 画布出过画：显示着、尺寸是服务端的 1280×800 */
    const drawn = () =>
      page.evaluate(() => {
        const c = document.querySelector(".ws-wb-canvas");
        return !!c && !c.hidden && c.width === 1280 && c.height === 800;
      });
    /** 布局量一下：工具条高、画面区比例、有没有溢出舞台、窗格有没有滚动条 */
    const geometry = () =>
      page.evaluate(() => {
        const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
        const bar = r(".ws-wb-bar");
        const view = r(".ws-wb-view");
        const stage = r(".ws-wb-stage");
        const root = document.querySelector(".ws-wb");
        return {
          barH: Math.round(bar?.height ?? 0),
          ratio: view ? view.width / view.height : 0,
          inside:
            !!view &&
            !!stage &&
            view.left >= stage.left - 1 &&
            view.right <= stage.right + 1 &&
            view.top >= stage.top - 1 &&
            view.bottom <= stage.bottom + 1,
          overflowX: root ? root.scrollWidth > root.clientWidth : true,
          overflowY: root ? root.scrollHeight > root.clientHeight : true,
          stageH: Math.round(stage?.height ?? 0),
        };
      });

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "浏览器" }).click();
    await page.waitForSelector(".ws-pane");
    await sleep(600);

    // 1) 新建浏览器标签 → 说明卡片 → 在页面列表里开地址
    await page.getByRole("button", { name: "新建标签页" }).first().click();
    await page.getByRole("menuitem", { name: /浏览器/ }).click();
    await wb.waitFor();
    check(
      "新建浏览器标签：没有页面时是说明卡片",
      (await wb.getByText("还没有页面").count()) > 0,
    );
    await shot("browser-1-empty");
    await wb.getByRole("button", { name: "打开地址" }).click();
    const dialog = page.getByRole("dialog", { name: "浏览器页面" });
    await dialog.getByLabel("打开地址").fill(`server:${sitePort}/`);
    await dialog.getByRole("button", { name: "打开", exact: true }).click();
    const t0 = Date.now();
    check(
      "页面列表里开地址后画布出画（静止页面也有首帧）",
      await until(drawn, 20000),
      `${Date.now() - t0}ms`,
    );
    check(
      "地址栏显示「主机名:端口」，页面是你自己的（手动态）",
      (await addr().inputValue()).includes(`:${sitePort}`) &&
        (await btn("交给 agent").count()) === 1,
      await addr().inputValue(),
    );
    await sleep(400);
    await shot("browser-2-manual");

    const tier = () =>
      page.evaluate(() => {
        const vis = (sel) =>
          [...document.querySelectorAll(sel)].some(
            (e) => getComputedStyle(e).display !== "none",
          );
        const root = document.querySelector(".ws-wb");
        const bar = document.querySelector(".ws-wb-bar");
        const input = document.querySelector(
          '.ws-wb-bar input[aria-label="页面地址"]',
        );
        return {
          paneW: Math.round(root?.getBoundingClientRect().width ?? 0),
          barH: Math.round(bar?.getBoundingClientRect().height ?? 0),
          addrW: Math.round(input?.getBoundingClientRect().width ?? 0),
          more: vis(".ws-wb-more"),
          sec: vis(".ws-wb-sec"),
          nav: vis(".ws-wb-nav"),
          text: vis(".ws-wb-ctext"),
          overflowX: root ? root.scrollWidth > root.clientWidth : true,
        };
      });

    // 2) 版式
    let g = await geometry();
    check(
      "工具条一行（36 高），画面区 16:10、在舞台内、没有滚动条",
      g.barH === 36 &&
        Math.abs(g.ratio - 1.6) < 0.02 &&
        g.inside &&
        !g.overflowX &&
        !g.overflowY,
      JSON.stringify(g),
    );

    // 3) 手动态：点击与键盘到达页面
    const go = await onCanvas(200, 130);
    await page.mouse.click(go.x, go.y);
    check(
      "点击画面上的按钮：页面收到 click",
      await until(() => hitsOf("click") === 1),
      JSON.stringify(hits),
    );
    const field = await onCanvas(300, 220);
    await page.mouse.click(field.x, field.y);
    await page.keyboard.type("hello");
    check(
      "点输入框再打字：页面收到 input:hello",
      await until(() => hits.includes("input:hello")),
      JSON.stringify(hits.slice(-3)),
    );
    // 输入法：CDP 模拟组词（拼音在输入框里是预编辑）再上屏中文，以及不经组词直接上屏的全角标点
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "nihao",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await cdp.send("Input.insertText", { text: "你好" });
    check(
      "输入法组词后上屏：页面收到中文，没有把拼音当成英文字母发过去",
      await until(() => hits.includes("input:hello你好")),
      JSON.stringify(hits.slice(-3)),
    );
    await page.keyboard.insertText("，");
    check(
      "输入法直接上屏的全角标点：页面收到",
      await until(() => hits.includes("input:hello你好，")),
      JSON.stringify(hits.slice(-2)),
    );
    await cdp.detach();

    // 划选复制：选区在服务端的页面里，Ctrl+C 请 Server 取出来再写本机剪贴板
    const clip = () => page.evaluate(() => navigator.clipboard.readText());
    const setClip = (text) =>
      page.evaluate((t) => navigator.clipboard.writeText(t), text);
    const triple = async (px, py) => {
      const at = await onCanvas(px, py);
      await page.mouse.click(at.x, at.y, { clickCount: 3 });
    };
    await setClip("旧内容");
    await triple(150, 310);
    await page.keyboard.press("Control+c");
    check(
      "三击选中正文再按 Ctrl+C：本机剪贴板是页面里选中的那段话",
      !!(await until(async () =>
        (await clip()).includes("页面里可划选的一段话"),
      )),
      JSON.stringify(await clip()),
    );
    check(
      "复制后弹出「已复制」",
      (await page.getByText("已复制", { exact: true }).count()) > 0,
    );
    await shot("browser-2b-copied");
    await setClip("旧内容");
    await triple(300, 220);
    await page.keyboard.press("Control+c");
    check(
      "三击选中输入框里的字再按 Ctrl+C：剪贴板是输入框里的内容",
      !!(await until(async () => (await clip()) === "hello你好，")),
      JSON.stringify(await clip()),
    );
    // 点一下空白处，选区收起；此时再按 Ctrl+C 不该把剪贴板冲成空
    const blank = await onCanvas(900, 600);
    await page.mouse.click(blank.x, blank.y);
    await setClip("旧内容");
    await page.keyboard.press("Control+c");
    await sleep(600);
    check(
      "没有选中任何文字时按 Ctrl+C：剪贴板里原有的内容还在",
      (await clip()) === "旧内容",
      JSON.stringify(await clip()),
    );

    // 页面自己写剪贴板（分享按钮）：用户点击之后几秒内，Server 推给操作窗口，写进本机剪贴板并弹提示
    await setClip("旧内容");
    const share = await onCanvas(200, 430);
    await page.mouse.click(share.x, share.y);
    check(
      "点页面里的分享按钮：本机剪贴板是页面写进去的地址",
      !!(await until(async () => (await clip()) === "https://share.test/abc")),
      JSON.stringify(await clip()),
    );
    check(
      "并弹出「页面复制了：…」",
      !!(await until(
        async () => (await page.getByText(/页面复制了：/).count()) > 0,
      )),
    );
    await shot("browser-2c-page-copied");
    await setClip("旧内容");
    const later = await onCanvas(200, 510);
    await page.mouse.click(later.x, later.y);
    check(
      "点击 1.5 秒后页面才写剪贴板：仍然推到本机",
      !!(await until(
        async () => (await clip()) === "https://share.test/later",
      )),
      JSON.stringify(await clip()),
    );

    // 修饰键的 keyup 丢了（Alt+Tab 之类让焦点离开）：Server 那边的键盘不能一直按着 Alt，否则点链接就成了「下载链接」
    await page.keyboard.down("Alt");
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.up("Alt"); // 焦点已不在画面上，这个 keyup 到不了画面
    await sleep(200);
    const link = await onCanvas(150, 580);
    await page.mouse.click(link.x, link.y);
    check(
      "Alt 的 keyup 丢了之后点链接：正常导航，没有弹下载",
      !!(await until(async () =>
        (await addr().inputValue()).endsWith("/second"),
      )) &&
        (await page.getByRole("dialog", { name: "保存下载的文件" }).count()) ===
          0,
      await addr().inputValue(),
    );
    await btn("后退").click();
    await until(async () => !(await addr().inputValue()).endsWith("/second"));

    // 地址栏导航：回车跳到第二页
    await addr().click();
    await addr().fill(`server:${sitePort}/second`);
    await addr().press("Enter");
    check(
      "地址栏回车：导航到第二页",
      await until(async () => (await addr().inputValue()).endsWith("/second")),
      await addr().inputValue(),
    );
    await btn("后退").click();
    check(
      "后退回到首页",
      await until(async () => !(await addr().inputValue()).endsWith("/second")),
    );

    // 4) 观察态：交给 agent 后画面上的点击不再到达页面
    await btn("交给 agent").click();
    check(
      "交给 agent：工具条换成「手动操作」，地址只读，没有后退 / 前进 / 刷新",
      (await until(async () => (await btn("手动操作").count()) === 1)) &&
        (await addr().evaluate((el) => el.readOnly)) &&
        (await wb
          .getByRole("button", { name: "后退", exact: true })
          .count()) === 0,
    );
    await shot("browser-3-observe");
    const before = hitsOf("click");
    const again = await onCanvas(200, 130);
    await page.mouse.click(again.x, again.y);
    await sleep(600);
    check("观察态：点击画面不会到达页面", hitsOf("click") === before);
    await btn("手动操作").click();
    check(
      "手动操作：接管后工具条换回手动态",
      await until(async () => (await btn("交给 agent").count()) === 1),
    );
    const back = await onCanvas(200, 130);
    await page.mouse.click(back.x, back.y);
    check(
      "接管后点击恢复有效",
      await until(() => hitsOf("click") === before + 1),
    );

    // 5) 控制台抽屉 + 版式不被破坏
    const stageBefore = (await geometry()).stageH;
    await btn("控制台").click();
    const drawer = page.getByRole("region", { name: "控制台" });
    check(
      "控制台抽屉：页面里的 console.log 出现在里面",
      await until(async () =>
        ((await drawer.innerText().catch(() => "")) || "").includes(
          "hello-console",
        ),
      ),
    );
    g = await geometry();
    check(
      "抽屉打开后画面区仍是 16:10、在舞台内，舞台变矮",
      Math.abs(g.ratio - 1.6) < 0.02 &&
        g.inside &&
        !g.overflowY &&
        g.stageH < stageBefore,
      JSON.stringify({ ...g, stageBefore }),
    );
    await shot("browser-4-console");
    await btn("控制台").click();

    // 6) 页面列表：再开第二页，计数、分组、关闭
    await btn("页面 1").click();
    await dialog.getByLabel("打开地址").fill(`server:${sitePort}/second`);
    await dialog.getByRole("button", { name: "打开", exact: true }).click();
    check(
      "再开一页：页面计数变 2",
      await until(async () => (await btn("页面 2").count()) === 1),
    );
    await dialog.waitFor({ state: "hidden" }); // 上一个列表收起完再点，点击才不会落空
    await btn("页面 2").click();
    check(
      "页面列表：有「我的」分组，两个页面都在里面",
      (await dialog.getByText("我的", { exact: true }).count()) === 1 &&
        (await dialog
          .locator(".u-lrow[data-size] .u-lrow-sub, .u-lrow")
          .count()) >= 3,
    );
    await sleep(400); // 等悬浮列表的入场动画走完再截图
    await shot("browser-5-pages");
    const current = dialog.locator(".u-lrow[data-current]");
    await current.hover();
    await current.getByRole("button", { name: "关闭页面" }).click();
    check(
      "关闭当前页：计数回到 1，标签换到剩下的页面",
      (await until(async () => (await btn("页面 1").count()) === 1)) &&
        (await until(drawn)),
    );
    await page.keyboard.press("Escape");

    // 7a) 窗格宽度：宽 > 640 文字按钮，500–640 只剩图标，400–500 次要动作收进「…」（≤ 400 的那一档本布局里到不了，登录脚本的三窗格里量）
    // 扫一遍视口宽度：窗格宽度随视口变，每个宽度按实测的窗格宽度判断该是哪一档
    const seen = new Set();
    let folded = false;
    const bad = [];
    const rows = [];
    for (const width of [640, 720, 800, 900, 1100, 1440, 1900]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(400);
      const t = await tier();
      const want =
        t.paneW <= 400
          ? {
              more: true,
              sec: false,
              nav: false,
              text: false,
              name: "导航也收进「…」",
            }
          : t.paneW <= 500
            ? {
                more: true,
                sec: false,
                nav: true,
                text: false,
                name: "收进「…」",
              }
            : t.paneW <= 640
              ? {
                  more: false,
                  sec: true,
                  nav: true,
                  text: false,
                  name: "只剩图标",
                }
              : {
                  more: false,
                  sec: true,
                  nav: true,
                  text: true,
                  name: "文字按钮",
                };
      seen.add(want.name);
      rows.push(`${t.paneW}px ${want.name} 地址栏${t.addrW}`);
      if (
        !(
          t.barH === 36 &&
          !t.overflowX &&
          t.addrW >= 100 &&
          t.more === want.more &&
          t.sec === want.sec &&
          t.nav === want.nav &&
          t.text === want.text
        )
      )
        bad.push(`${width}→${JSON.stringify(t)}`);
      if (want.name === "收进「…」" && !folded) {
        folded = true;
        await shot("browser-5b-folded");
      }
    }
    check(
      "每一档：工具条一行、没有横向滚动、地址栏至少 100 宽，各档该显示的在、不该显示的不在",
      bad.length === 0,
      bad.length ? bad.join(" | ") : rows.join("；"),
    );
    check(
      "三档都量到了（视口宽度与窗格宽度的对应变了就要调这里的视口）",
      ["收进「…」", "只剩图标", "文字按钮"].every((n) => seen.has(n)),
      [...seen].join(" / "),
    );
    // 7b) 「…」菜单里的动作真能用：视口 800 时窗格约 470px，在「…」那一档里开控制台、关掉
    await page.setViewportSize({ width: 800, height: 900 });
    await sleep(500);
    await wb.getByRole("button", { name: "更多操作" }).click();
    await sleep(400); // 等弹层入场动画结束再截图
    await shot("browser-5c-more");
    check(
      "「…」菜单列出后退 / 前进 / 刷新 / 保存登录 / 回放 / 控制台",
      (await page.getByRole("menuitem").allTextContents()).join("|") ===
        "后退|前进|刷新|保存登录|回放|控制台",
      (await page.getByRole("menuitem").allTextContents()).join("|"),
    );
    await page.getByRole("menuitem", { name: "控制台" }).click();
    check(
      "菜单里选「控制台」：控制台抽屉打开",
      !!(await until(
        async () =>
          (await wb.getByRole("region", { name: "控制台" }).count()) > 0,
      )),
    );
    await wb.getByRole("button", { name: "更多操作" }).click();
    check(
      "再开菜单：控制台那项标「已开」",
      (
        await page.getByRole("menuitem", { name: /控制台/ }).innerText()
      ).includes("已开"),
    );
    await page.getByRole("menuitem", { name: /控制台/ }).click();
    check(
      "再选一次：控制台抽屉收起",
      !!(await until(
        async () =>
          (await wb.getByRole("region", { name: "控制台" }).count()) === 0,
      )),
    );

    // 7) 窄窗口
    await page.setViewportSize({ width: 600, height: 800 });
    await sleep(600);
    g = await geometry();
    check(
      "窄窗口（600 宽）：工具条仍一行，没有横向滚动，画面区仍在舞台内",
      g.barH === 36 && !g.overflowX && g.inside,
      JSON.stringify(g),
    );
    await shot("browser-6-narrow");
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(400);

    // 8) 预览标签里的 HTML 文件
    await page.locator(".ws-pn-tab[data-type='files']").first().click();
    await page.waitForSelector(".ws-fm-row");
    await page
      .locator('.ws-fm-row[data-name="demo.html"] .u-lrow-main')
      .dblclick();
    // HTML 文件默认是源码编辑态，切到「预览」才有入口
    await page.getByRole("radio", { name: "预览" }).click();
    await page.getByRole("button", { name: "在浏览器中打开" }).click();
    check(
      "HTML 预览里点「在浏览器中打开」：浏览器标签显示这个文件页",
      await until(async () =>
        (
          await addr()
            .inputValue()
            .catch(() => "")
        ).includes("demo.html"),
      ),
      await addr()
        .inputValue()
        .catch(() => ""),
    );
    check("文件页画布出画", await until(drawn, 20000));
    await shot("browser-7-html");

    // 9) 刷新后标签仍显示同一页
    const shown = await addr().inputValue();
    await sleep(1500); // 布局保存有防抖
    await page.reload();
    await page.waitForSelector(".ws-pane");
    await wb.waitFor();
    check(
      "刷新页面：浏览器标签仍显示同一页，画布重新出画",
      (await until(async () => (await addr().inputValue()) === shown)) &&
        (await until(drawn, 20000)),
      `${shown} → ${await addr().inputValue()}`,
    );

    // 10) 没有报错
    check(
      "全程没有控制台报错与失败的接口请求",
      problems.length === 0,
      problems.slice(0, 5).join(" | "),
    );
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  check("脚本异常", false, String(e?.stack ?? e).slice(0, 400));
} finally {
  proc.kill();
  site.close();
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀（否则每跑一次留一个孤儿 Server）
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(
  `\n浏览器标签界面：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
