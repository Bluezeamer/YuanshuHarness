// 浏览器登录状态的真机检查：起真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 本地假站点（cookie 与 localStorage 登录）
// + 无头 Chromium 当用户的浏览器，不需要真实模型。站点用 `server.localhost`（环境别名，按站点算），不用联网。
//  1) 手动登录后交还 agent：工具条上出「保存 server.localhost 的登录状态？」；点「忽略」什么都不存；再来一次点「保存」后存下
//     交还的另一条路：agent 发起接管请求（假模型按剧本调 browser_handoff），用户手动登录后在聊天卡片里答「我已操作完成」，同样出提示
//  2) 存下的状态：接口只给站点与条数，响应里没有 cookie 值；数据目录里所有文件（含库与 WAL）都搜不到 cookie 与 localStorage 的值
//  3) 另一个工作区第一次开页面：登录态已注入（cookie 与 localStorage 都在），页面直接是已登录
//     已经开着浏览器的工作区也能拿到：保存时它早就开着，保存后再开站点就是已登录；关掉「允许 agent 使用」时才开的工作区，重新打开开关后同样补上
//  4) 设置页「浏览器」：列出该站点；关掉「允许 agent 使用」后，再新开的工作区不再注入；删除要点两下，删完是空状态
//  5) 版式：手动态工具条仍是一行（36 高）且没有横向滚动，「保存登录状态」按钮在条内（窄窗格 ≤500px 时收进「…」菜单）；设置页站点很多时整页能滚到最后一行、没有横向溢出
//  6) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
//   agent 用的浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用上面装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-login.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
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
const base = mkdtempSync(join(root, "tmp", "browser-login-"));
const work = `${realpathSync(base)}/work`;
const dirs = [1, 2, 3, 4, 5].map((n) => `${work}/proj${n}`);
for (const d of dirs) mkdirSync(d, { recursive: true });

// —— 假站点：/login 种 cookie 再跳 /done，/done 往 localStorage 写值；首页按 cookie 与 localStorage 把状态写进标题 ——
const COOKIE_VALUE = "cookie-secret-7f3a91";
const LS_VALUE = "ls-secret-5c2e08";
const site = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/login") {
    res
      .writeHead(302, {
        "set-cookie": `sid=${COOKIE_VALUE}; Path=/; Max-Age=3600; HttpOnly`,
        location: "/done",
      })
      .end();
    return;
  }
  const html = (body) =>
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(`<!doctype html>${body}`);
  if (path === "/done")
    return html(
      `<title>登录完成</title><h1>登录完成</h1><script>localStorage.setItem("tok", "${LS_VALUE}")</script>`,
    );
  const hasCookie = (req.headers.cookie ?? "").includes(`sid=${COOKIE_VALUE}`);
  html(
    `<title>未登录</title><h1>首页</h1><script>
      const ls = localStorage.getItem("tok");
      document.title = ${JSON.stringify(hasCookie)} ? "已登录 cookie" + (ls ? " ls=" + ls : " ls=无") : "未登录";
    </script>`,
  );
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;

// 取上一个工具结果里的页面编号：「PAGE ID: xxxxxx · HTTP …」
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
    {
      // 先「启动服务」：命令输出里出现这个端口，之后 browser_open 才不用批准
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
          name: "browser_handoff",
          args: (messages) => ({
            pageId: pageIdOf(messages),
            reason: "需要登录",
          }),
        },
      ],
    },
    { text: "好的，我接着做。" },
  ],
  { delay: 20 },
);

const port = 18700 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const dataDir = join(base, "data");
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
    dataDir,
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
  return { status: r.status, text, json: text ? JSON.parse(text) : null };
};

/** 数据目录里所有文件（含库的 WAL）是否出现过某个串。 */
function dataContains(needle) {
  const hit = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (readFileSync(p).includes(needle)) hit.push(p);
    }
  };
  walk(dataDir);
  return hit;
}

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
  const workspace = async (name, dir) => {
    const ws = (
      await api("POST", "/workspaces", { name, directories: [{ path: dir }] })
    ).json;
    await api("POST", "/sessions", { workspaceId: ws.id });
    return ws;
  };
  const ws1 = await workspace("登录甲", dirs[0]);
  const LOGGED_IN = `已登录 cookie ls=${LS_VALUE}`;

  /** 工作区里某个页面此刻的标题（接口读，不经界面）。 */
  const titles = async (wid) =>
    (await api("GET", `/workspaces/${wid}/browser`)).json.pages.map(
      (p) => p.title,
    );
  /** 工作区名 → id：后面要在同一个（已经开着浏览器的）工作区里再开页面。 */
  const wsIds = new Map();
  /** 在一个全新的工作区里用接口开站点首页，等到标题稳定后返回它。 */
  const openFresh = async (name, dir) => {
    const ws = await workspace(name, dir);
    wsIds.set(name, ws.id);
    const r = await api("POST", `/workspaces/${ws.id}/browser/pages`, {
      target: `server:${sitePort}/`,
    });
    if (r.status !== 201) throw new Error(`开页面失败 ${r.status} ${r.text}`);
    const want = (t) => t === "未登录" || t.startsWith("已登录");
    await until(async () => (await titles(ws.id)).some(want), 20000);
    return (await titles(ws.id))[0] ?? "";
  };

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
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
    const addr = () => page.getByLabel("页面地址");
    const btn = (name) => wb.getByRole("button", { name, exact: true }).first();
    const offerText = () => wb.getByText(/保存 server\.localhost 的登录状态/);
    const logins = async () => (await api("GET", "/browser/logins")).json;

    // 保存之前就把另一个工作区的浏览器开着：它的上下文里这个站点什么都没有
    const early = await openFresh("登录早", dirs[4]);
    check(
      "保存前，另一个工作区的浏览器已开着，页面是未登录",
      early === "未登录",
      early,
    );

    // 1) 手动登录：开页面、地址栏跳 /login（种 cookie 与 localStorage）
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "登录甲" }).click();
    await page.waitForSelector(".ws-pane");
    await sleep(600);
    await page.getByRole("button", { name: "新建标签页" }).first().click();
    await page.getByRole("menuitem", { name: /浏览器/ }).click();
    await wb.waitFor();
    await wb.getByRole("button", { name: "打开地址" }).click();
    const dialog = page.getByRole("dialog", { name: "浏览器页面" });
    await dialog.getByLabel("打开地址").fill(`server:${sitePort}/`);
    await dialog.getByRole("button", { name: "打开", exact: true }).click();
    await until(async () => (await titles(ws1.id)).includes("未登录"), 20000);
    await addr().click();
    await addr().fill(`server:${sitePort}/login`);
    await addr().press("Enter");
    check(
      "手动登录：页面跳到 /login 后落在「登录完成」",
      !!(await until(async () => (await titles(ws1.id)).includes("登录完成"))),
      JSON.stringify(await titles(ws1.id)),
    );
    await sleep(500);
    await shot("login-1-manual");

    // 5a) 手动态版式：工具条仍是一行，保存按钮在条内，没有横向滚动
    const geo = () =>
      page.evaluate(() => {
        const bar = document.querySelector(".ws-wb-bar");
        const key = [...document.querySelectorAll(".ws-wb-bar button")].find(
          (b) => b.getAttribute("aria-label") === "保存登录状态",
        );
        const root = document.querySelector(".ws-wb");
        const bb = bar?.getBoundingClientRect();
        const kb = key?.getBoundingClientRect();
        return {
          barH: Math.round(bb?.height ?? 0),
          keyInBar:
            !!bb &&
            !!kb &&
            kb.left >= bb.left &&
            kb.right <= bb.right &&
            kb.top >= bb.top - 1 &&
            kb.bottom <= bb.bottom + 1,
          overflowX: root ? root.scrollWidth > root.clientWidth : true,
        };
      });
    const g = await geo();
    check(
      "手动态：工具条一行（36 高），「保存登录状态」在条内，没有横向滚动",
      g.barH === 36 && g.keyInBar && !g.overflowX,
      JSON.stringify(g),
    );

    // 1) 交还 agent：问要不要保存；先忽略
    await btn("交给 agent").click();
    check(
      "交还 agent 后出现「保存 server.localhost 的登录状态？」",
      !!(await until(async () => (await offerText().count()) === 1)),
    );
    await shot("login-2-offer");
    await wb.getByRole("button", { name: "忽略", exact: true }).click();
    await sleep(300);
    check(
      "点「忽略」：提示收起，什么都没存",
      (await offerText().count()) === 0 && (await logins()).logins.length === 0,
      JSON.stringify(await logins()),
    );

    // 再来一次：接管 → 交还 → 保存
    await btn("手动操作").click();
    await btn("交给 agent").click();
    await offerText().waitFor({ timeout: 10000 });
    // 等保存请求回来：服务端补登录态在响应之前做完，只看库里有没有会抢在它前面
    const saved = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/login"),
    );
    await wb.getByRole("button", { name: "保存", exact: true }).click();
    await saved;
    check(
      "再来一次点「保存」：提示收起，存下了 server.localhost",
      !!(await until(async () => (await logins()).logins.length === 1)) &&
        (await offerText().count()) === 0,
      JSON.stringify(await logins()),
    );

    // 2) 存下的东西：接口没有内容，磁盘上没有明文
    const list = await api("GET", "/browser/logins");
    const entry = list.json.logins[0] ?? {};
    check(
      "接口只给站点、开关、时间与条数",
      entry.site === "server.localhost" &&
        entry.enabled === true &&
        entry.cookies >= 1 &&
        entry.origins >= 1 &&
        Object.keys(entry).sort().join() ===
          "cookies,enabled,origins,savedAt,site",
      JSON.stringify(entry),
    );
    check(
      "响应里没有 cookie 与 localStorage 的值",
      !list.text.includes(COOKIE_VALUE) && !list.text.includes(LS_VALUE),
    );
    // WAL 里的内容要先落进库才算数：触发一次 checkpoint 的办法是等一下再读，这里两种文件都搜
    await sleep(500);
    const leaks = [
      ...dataContains(Buffer.from(COOKIE_VALUE)),
      ...dataContains(Buffer.from(LS_VALUE)),
    ];
    check(
      "数据目录里所有文件都搜不到 cookie 与 localStorage 的值（加密落盘）",
      leaks.length === 0,
      leaks.join(","),
    );

    // 3) 另一个工作区第一次开页面：已注入
    const injected = await openFresh("登录乙", dirs[1]);
    check(
      "另一个工作区新开页面：cookie 与 localStorage 都已注入，直接是已登录",
      injected === `已登录 cookie ls=${LS_VALUE}`,
      injected,
    );

    // 保存的那一刻，早就开着浏览器的工作区也补上了：在里面再开站点首页就是已登录。
    // 放在泄露检查之后：站点把密钥值写进页面标题，标题会存进库，早了会被当成明文泄露。
    await api("POST", `/workspaces/${wsIds.get("登录早")}/browser/pages`, {
      target: `server:${sitePort}/`,
    });
    check(
      "保存后，早就开着浏览器的工作区里再开站点：已登录（cookie 与 localStorage 都补上了）",
      !!(await until(async () =>
        (await titles(wsIds.get("登录早"))).includes(LOGGED_IN),
      )),
      JSON.stringify(await titles(wsIds.get("登录早"))),
    );

    // 4) 设置页：列出、关开关、再新开不注入、删除要点两下
    await page.goto(`${origin}/settings/browser`);
    await page.getByText("server.localhost", { exact: true }).waitFor();
    const sw = page.getByRole("switch", {
      name: "允许 agent 使用 server.localhost 的登录状态",
    });
    check(
      "设置页列出站点，开关是开着的",
      (await sw.getAttribute("aria-checked")) === "true",
    );
    await sleep(500); // 等进入设置页的转场结束再截图
    await shot("login-3-settings");
    await sw.click();
    check(
      "关「允许 agent 使用」：服务端的开关跟着关",
      !!(await until(
        async () => (await logins()).logins[0]?.enabled === false,
      )),
    );
    const off = await openFresh("登录丙", dirs[2]);
    check("关掉之后新开的工作区不再注入，页面是未登录", off === "未登录", off);

    // 重新打开开关：刚才那个在关着时开起来的工作区（上下文里这个站点什么都没有）也补上
    const enabled = page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        r.url().includes("/api/v1/browser/logins/"),
    );
    await sw.click();
    await enabled;
    check(
      "重新打开「允许 agent 使用」：服务端的开关跟着开",
      !!(await until(async () => (await logins()).logins[0]?.enabled === true)),
    );
    await api("POST", `/workspaces/${wsIds.get("登录丙")}/browser/pages`, {
      target: `server:${sitePort}/`,
    });
    check(
      "重新打开开关后，在那个已开着的工作区里再开站点：已登录",
      !!(await until(async () =>
        (await titles(wsIds.get("登录丙"))).includes(LOGGED_IN),
      )),
      JSON.stringify(await titles(wsIds.get("登录丙"))),
    );

    // 5b) 站点很多时整页能滚到最后一行：用假数据替掉读列表的响应，只影响这个页面
    const many = Array.from({ length: 40 }, (_, i) => ({
      site: `site-${String(i).padStart(2, "0")}.example.com`,
      enabled: i % 2 === 0,
      savedAt: "2026-11-13T08:05:00.000Z",
      cookies: 5 + i,
      origins: 1,
    }));
    const other = await ctx.newPage();
    await other.route("**/api/v1/browser/logins", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { logins: many } })
        : route.continue(),
    );
    await other.goto(`${origin}/settings/browser`);
    await other.getByText("site-39.example.com", { exact: true }).waitFor();
    const scrollInfo = await other.evaluate(() => {
      const el = document.querySelector(".st-scroll");
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      const last = [...document.querySelectorAll(".u-row")].at(-1);
      const lb = last.getBoundingClientRect();
      const eb = el.getBoundingClientRect();
      return {
        scrollable: el.scrollHeight > el.clientHeight,
        before,
        after: el.scrollTop,
        lastVisible: lb.bottom <= eb.bottom + 1 && lb.top >= eb.top,
        overflowX: el.scrollWidth > el.clientWidth,
      };
    });
    check(
      "设置页站点很多：整页可滚、滚到底看得见最后一行，没有横向溢出",
      scrollInfo.scrollable &&
        scrollInfo.after > scrollInfo.before &&
        scrollInfo.lastVisible &&
        !scrollInfo.overflowX,
      JSON.stringify(scrollInfo),
    );
    if (SHOTS)
      await other.screenshot({ path: join(SHOTS, "login-4-many.png") });
    await other.close();

    // 4) 删除：点两下
    const del = page.getByRole("button", {
      name: "删除 server.localhost 的登录状态",
    });
    await del.click();
    // 等按钮真的换成「确认…」再点第二下：不等的话第二下会落在上膛之前，被当成又一次第一下
    await del.getByText("确认…").waitFor();
    check("删除第一下只是上膛：站点还在", (await logins()).logins.length === 1);
    await del.click();
    // 服务端删完页面才重读列表，所以两边都要等，不能服务端一空就去数页面
    const emptied = !!(await until(
      async () => (await logins()).logins.length === 0,
    ));
    const emptyShown = !!(await until(
      async () => (await page.getByText("还没有保存登录状态").count()) === 1,
    ));
    check(
      "删除第二下执行：列表空了，页面给出空状态",
      emptied && emptyShown,
      `服务端空=${emptied} 页面空状态=${emptyShown}`,
    );
    await shot("login-5-empty");

    // 1b) 聊天卡片这条路：agent 请求接管，用户在浏览器标签里手动登录，再到聊天里答「我已操作完成」——标签里没有任何交还动作
    const ws4 = await workspace("登录丁", dirs[3]);
    await page.goto(origin);
    await page.locator(".rl-wh", { hasText: "登录丁" }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);
    const box = page.locator("textarea").first();
    await box.fill("去登录一下。");
    await box.press("Enter");
    await wb.waitFor({ timeout: 60000 });
    const card = page.getByRole("button", { name: "我已操作完成" });
    await card.first().waitFor({ timeout: 60000 });
    await btn("手动操作").click();
    // 三窗格里浏览器窗格只有约 350px：工具条仍是一行，不横向滚动，后退 / 前进 / 刷新与「保存登录」都收进「…」，地址栏至少 100 宽
    await sleep(500);
    const narrow = await page.evaluate(() => {
      const root = document.querySelector(".ws-wb");
      const bar = document.querySelector(".ws-wb-bar");
      const key = document.querySelector(
        '.ws-wb-bar [aria-label="保存登录状态"]',
      );
      const more = document.querySelector(".ws-wb-bar .ws-wb-more");
      const navShown = [...document.querySelectorAll(".ws-wb-nav")].some(
        (e) => getComputedStyle(e).display !== "none",
      );
      const input = document.querySelector(
        '.ws-wb-bar input[aria-label="页面地址"]',
      );
      return {
        addrW: Math.round(input?.getBoundingClientRect().width ?? 0),
        moreShown: !!more && getComputedStyle(more).display !== "none",
        navShown,
        paneW: Math.round(root?.getBoundingClientRect().width ?? 0),
        barH: Math.round(bar?.getBoundingClientRect().height ?? 0),
        keyHidden: !!key && getComputedStyle(key).display === "none",
        overflowX: root ? root.scrollWidth > root.clientWidth : true,
      };
    });
    check(
      "窄窗格（≤400px）手动态：工具条仍是一行、没有横向滚动，导航与「保存登录」收进「…」，地址栏至少 100 宽",
      narrow.paneW <= 400 &&
        narrow.barH === 36 &&
        narrow.keyHidden &&
        narrow.moreShown &&
        !narrow.navShown &&
        narrow.addrW >= 100 &&
        !narrow.overflowX,
      JSON.stringify(narrow),
    );
    // 窄窗格里地址栏只剩 0 宽，登录改用接口在同一个浏览器上下文里再开一页 /login（cookie 与 localStorage 同样种进上下文）
    await api("POST", `/workspaces/${ws4.id}/browser/pages`, {
      target: `server:${sitePort}/login`,
    });
    await until(async () => (await titles(ws4.id)).includes("登录完成"), 20000);
    await sleep(500);
    await shot("login-6-chat-before");
    // 答复聊天卡片（聊天区里那一颗；接管横幅里还有一颗同名的，不点它）
    await page
      .getByRole("log", { name: "对话记录" })
      .getByRole("button", { name: "我已操作完成" })
      .click();
    check(
      "在聊天卡片里答「我已操作完成」：浏览器标签里同样出现保存提示",
      !!(await until(async () => (await offerText().count()) === 1)),
    );
    await shot("login-7-chat-offer");
    await wb.getByRole("button", { name: "保存", exact: true }).click();
    check(
      "在这条路径上点「保存」：存下了 server.localhost",
      !!(await until(async () => (await logins()).logins.length === 1)),
      JSON.stringify(await logins()),
    );
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
  site.close();
  await fake.close();
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
if (crashed)
  console.log(
    `脚本异常：${String(crashed.stack ?? crashed.message)
      .split("\n")
      .slice(0, 6)
      .join(" | ")}`,
  );
const failed = results.filter((x) => !x).length + (crashed ? 1 : 0);
console.log(
  `\n浏览器登录状态：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
