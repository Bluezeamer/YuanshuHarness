// 服务转发的真机检查：真实 Server（配了令牌，临时数据目录）+ 假模型（让 agent 在 bash 里打印出站点地址，端口才会出现在列表里）
// + 一个本地假站点（HTTP、重定向、Set-Cookie、SSE、WebSocket）+ 无头 Chromium 当用户的浏览器，不需要真实模型。
//  1) 页面列表的端口行点「在本机浏览器打开」：新窗口真的打开了转发出口上的站点（有登录 Cookie），这一行变成「转发中」并写着转发端口
//  2) 转发接口：列表带 target，同一目标再转发返回同一个端口（幂等）
//  3) 出口的闸门：没有会话 Cookie 得 401、站点一个请求都没收到；只带 Authorization 的也不行
//  4) 站点眼里的请求：Host 是 localhost:站点端口，会话 Cookie 被摘掉、别的 Cookie 还在，Origin / Referer 也换成站点自己的
//  5) 站点的回应：指回 localhost 的重定向改回转发出口；Set-Cookie 去掉 Domain，设会话 Cookie 的那条被丢掉
//  6) 用户浏览器里的页面：自己的接口、WebSocket 回声、SSE 都通；但它拿着登录 Cookie 去打 Server 的接口与 WebSocket 会被拒（Origin 校验），
//     对照：同样的代码在 Server 自己的页面里能成功
//  6b) 手动操作：没被检测到的服务也能转发（在「添加转发端口」里输入端口号，不自动开窗口），写错目标有行内提示；
//      「复制转发地址」真的复制出口地址；点 ✕ 停止后这一行消失、端口连不上
//  7) 停止转发：列表清空、端口连不上；再转发拿回最小的空闲端口；Server 重启后同一个转发仍是同一个端口、仍然通
//  8) 全程没有控制台报错、没有预期之外的失败接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-forward.mjs [--shots 目录]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "./lib/fake-model.mjs";
import { agentChromePath, chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const { WebSocketServer } = createRequire(
  join(root, "packages/server/package.json"),
)("ws");

const agentChrome = agentChromePath();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};
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
const base = mkdtempSync(join(root, "tmp", "forward-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(dir, { recursive: true });
const dataDir = join(base, "data");

const TOKEN = "t".repeat(40);
const port = 19700 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${port}`;
const FWD_FROM = port + 50;
const FWD_TO = port + 59;

// —— 假站点：记下收到的每个请求；页面上的脚本会自己去试各种连接，结果放进 window.__r ——
const seen = []; // { url, headers }
let SID = "";
// 页面里跑的探测：自己的接口、WebSocket 回声、SSE；再拿登录 Cookie 去打 Server（应当被拒）
const ATTACK = `(async (serverPort, sid) => {
  const r = {};
  try {
    const res = await fetch("http://127.0.0.1:" + serverPort + "/api/v1/sessions", { credentials: "include" });
    r.attackFetch = "READ " + res.status;
  } catch (e) { r.attackFetch = "BLOCKED"; }
  r.attackWs = await new Promise((ok) => {
    const s = new WebSocket("ws://127.0.0.1:" + serverPort + "/api/v1/sessions/" + sid + "/stream", ["yuanshu.v1"]);
    s.onopen = () => { ok("OPEN"); s.close(); };
    s.onerror = () => ok("BLOCKED");
    setTimeout(() => ok("TIMEOUT"), 5000);
  });
  return r;
})`;
const PROBE = `(async (serverPort, sid) => {
  const r = {};
  try { r.own = (await (await fetch("/hello")).text()); } catch (e) { r.own = "ERR " + e; }
  r.ws = await new Promise((ok) => {
    const s = new WebSocket("ws://" + location.host + "/ws");
    s.onopen = () => s.send("hi");
    s.onmessage = (m) => { ok(String(m.data)); s.close(); };
    s.onerror = () => ok("ERR");
    setTimeout(() => ok("TIMEOUT"), 5000);
  });
  r.sse = await new Promise((ok) => {
    const es = new EventSource("/sse");
    es.onmessage = (m) => { ok(m.data); es.close(); };
    es.onerror = () => { ok("ERR"); es.close(); };
    setTimeout(() => ok("TIMEOUT"), 5000);
  });
  Object.assign(r, await (${ATTACK})(serverPort, sid));
  window.__r = r;
  return r;
})`;
const PAGE =
  () => `<!doctype html><meta charset=utf-8><title>转发站点</title><h1>转发站点</h1>
<script>window.__go = ${PROBE};
addEventListener("load", () => window.__go(${port}, ${JSON.stringify(SID)}));</script>`;
const site = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url === "/hello") return void res.end("hello from site");
  if (req.url === "/echo")
    return void res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(req.headers));
  if (req.url === "/redir")
    return void res
      .writeHead(302, {
        location: `http://localhost:${site.address().port}/landing`,
      })
      .end();
  if (req.url === "/cookies")
    return void res
      .writeHead(200, {
        "set-cookie": [
          "app=1; Domain=localhost; Path=/",
          "ys_session=evil; Path=/",
        ],
      })
      .end("ok");
  if (req.url === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return void res.write("data: tick\n\n");
  }
  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(PAGE());
});
const siteB = http.createServer((_req, res) => res.end("B ok"));
const wss = new WebSocketServer({ server: site, path: "/ws" });
wss.on("connection", (s) => s.on("message", (m) => s.send(`echo:${m}`)));
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;
await new Promise((ok) => siteB.listen(0, "127.0.0.1", ok));
const sitePortB = siteB.address().port;

const fake = await startFakeModel(
  [
    {
      tools: [
        {
          name: "bash",
          args: {
            command: `echo "dev server ready on http://localhost:${sitePort}/"`,
          },
        },
      ],
    },
    { text: "做完了。" },
  ],
  { delay: 20 },
);

const logs = [];
let proc = null;
const startServer = () => {
  proc = spawn(
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
      "--forward-ports",
      `${FWD_FROM}-${FWD_TO}`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: work,
      env: {
        ...process.env,
        YUANSHU_TOKEN: TOKEN,
        ...(agentChrome ? { YUANSHU_BROWSER: agentChrome } : {}),
      },
    },
  );
  proc.stdout.on("data", (b) => logs.push(b.toString()));
  proc.stderr.on("data", (b) => logs.push(b.toString()));
};
const stopServer = async () => {
  proc.kill("SIGTERM");
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
};
const waitUp = async () => {
  for (let i = 0; i < 600; i++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
};
startServer();

const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : null };
};

/** 直接对转发出口发请求；headers 全由调用方给（fetch 不让改 Host / Cookie，所以用 http.request）。 */
const raw = (localPort, path, headers = {}) =>
  new Promise((ok, fail) => {
    const req = http.request(
      { host: "127.0.0.1", port: localPort, path, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () =>
          ok({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", fail);
    req.end();
  });
const refused = (localPort) =>
  raw(localPort, "/hello").then(
    () => false,
    () => true,
  );

const problems = [];
/** 预期里会出现的 400（故意写错目标）；其余的失败请求都算问题。 */
let expectedBad = 0;
const COOKIE = `ys_session=${TOKEN}`;

async function main() {
  await waitUp();
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
  const ws = (
    await api("POST", "/workspaces", {
      name: "转发",
      directories: [{ path: dir }],
    })
  ).json;
  SID = (await api("POST", "/sessions", { workspaceId: ws.id })).json.id;
  const forwards = async () =>
    (await api("GET", `/workspaces/${ws.id}/forwards`)).json.forwards;

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    // 令牌进 sessionStorage：界面据此登录，并把会话 Cookie 落到浏览器里（与用户登录后的状态一致）
    await ctx.addInitScript(
      (t) => sessionStorage.setItem("yuanshu.token", t),
      TOKEN,
    );
    const page = await ctx.newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error" && !/status of 400/.test(m.text()))
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (r.url().startsWith(origin) && r.status() >= 400) {
        // 预期里会出现的一次：故意写错目标那条（400）
        if (r.status() === 400 && expectedBad > 0) return void expectedBad--;
        problems.push(
          `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
      }
    });
    const shot = async (name, p = page) => {
      if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "转发" }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);
    const box = page.locator("textarea").first();
    await box.fill("看看开发服务器。");
    await box.press("Enter");
    await until(
      async () =>
        (await api("GET", `/workspaces/${ws.id}/browser/ports`)).json.ports
          .length === 1,
      40000,
    );

    // 1) 页面列表：端口行 →「在本机浏览器打开」→ 新窗口
    await page.getByRole("button", { name: "新建标签页" }).first().click();
    await page.getByRole("menuitem", { name: /浏览器/ }).click();
    const wb = page.locator(".ws-wb");
    await wb.waitFor();
    await wb.getByRole("button", { name: /^页面/ }).click();
    const dialog = page.getByRole("dialog", { name: "浏览器页面" });
    await dialog.getByLabel("添加转发端口").waitFor();
    const portRow = dialog
      .locator(".u-lrow", { hasText: `本机:${sitePort}` })
      .filter({ has: page.getByRole("button", { name: "在本机浏览器打开" }) });
    await portRow.hover();
    await sleep(300);
    await shot("forward-1-ports");
    let popups = 0;
    page.on("popup", () => popups++);
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      portRow.getByRole("button", { name: "在本机浏览器打开" }).click(),
    ]);
    popup.on("pageerror", (e) =>
      problems.push(`popup pageerror ${e.message.split("\n")[0]}`),
    );
    await popup.waitForURL(`http://127.0.0.1:${FWD_FROM}/`, { timeout: 15000 });
    await popup.waitForFunction(() => window.__r !== undefined, null, {
      timeout: 20000,
    });
    check(
      "点「在本机浏览器打开」：新窗口开在转发出口上，站点页面加载出来了",
      (await popup.title()) === "转发站点",
      popup.url(),
    );
    await shot("forward-2-popup", popup);

    // 2) 接口
    const list = await forwards();
    check(
      "转发接口：列表里有这条，target 是地址栏写法，转发端口在设定的段里，在监听",
      list.length === 1 &&
        list[0].target === `server:${sitePort}` &&
        list[0].localPort === FWD_FROM &&
        list[0].listening === true,
      JSON.stringify(list),
    );
    const again = await api("POST", `/workspaces/${ws.id}/forwards`, {
      target: `server:${sitePort}`,
    });
    check(
      "同一目标再转发：幂等，返回同一个端口，没有多出一条",
      again.status === 200 &&
        again.json.localPort === FWD_FROM &&
        (await forwards()).length === 1,
    );
    const siteRow = () =>
      dialog.locator(".u-lrow", { hasText: `本机:${sitePort}` });
    check(
      "页面列表里这一行变成「转发中」，写着转发端口",
      !!(await until(
        async () =>
          (await siteRow().getByText(`转发端口 ${FWD_FROM}`).count()) === 1 &&
          (await siteRow().getByRole("img", { name: "转发中" }).count()) === 1,
        5000,
      )),
    );
    await sleep(300);
    await shot("forward-3-forwarded");

    // 2b) 不该转发的目标：Server 自己的端口、转发端口、不存在的环境
    const own = await api("POST", `/workspaces/${ws.id}/forwards`, {
      target: `server:${port}`,
    });
    const loop = await api("POST", `/workspaces/${ws.id}/forwards`, {
      target: `server:${FWD_FROM}`,
    });
    const nope = await api("POST", `/workspaces/${ws.id}/forwards`, {
      target: `no-such-env:${sitePort}`,
    });
    check(
      "不该转发的目标被拒：Server 自己的端口与转发端口 403，不存在的主机 400",
      own.status === 403 && loop.status === 403 && nope.status === 400,
      `${own.status}/${loop.status}/${nope.status}`,
    );

    // 3) 闸门
    seen.length = 0;
    const noCookie = await raw(FWD_FROM, "/hello");
    const bearerOnly = await raw(FWD_FROM, "/hello", {
      authorization: `Bearer ${TOKEN}`,
    });
    check(
      "没有会话 Cookie 得 401（只带 Authorization 的也一样），站点一个请求都没收到",
      noCookie.status === 401 &&
        bearerOnly.status === 401 &&
        !noCookie.body.includes("hello") &&
        seen.length === 0,
      `${noCookie.status}/${bearerOnly.status}，站点收到 ${seen.length} 个`,
    );

    // 4) 站点眼里的请求
    const echoed = await raw(FWD_FROM, "/echo", {
      cookie: `${COOKIE}; theme=dark`,
      origin: `http://127.0.0.1:${FWD_FROM}`,
      referer: `http://127.0.0.1:${FWD_FROM}/page?x=1`,
    });
    const h = JSON.parse(echoed.body);
    check(
      "站点收到的请求：Host 是 localhost:站点端口，会话 Cookie 摘掉、别的 Cookie 还在，Origin 与 Referer 换成站点自己的",
      h.host === `localhost:${sitePort}` &&
        h.cookie === "theme=dark" &&
        h.origin === `http://localhost:${sitePort}` &&
        h.referer === `http://localhost:${sitePort}/page?x=1`,
      JSON.stringify({
        host: h.host,
        cookie: h.cookie,
        origin: h.origin,
        referer: h.referer,
      }),
    );

    // 5) 站点的回应
    const redir = await raw(FWD_FROM, "/redir", {
      cookie: COOKIE,
      host: `127.0.0.1:${FWD_FROM}`,
    });
    check(
      "站点指回 localhost 的重定向，被改回转发出口的地址",
      redir.status === 302 &&
        redir.headers.location === `http://127.0.0.1:${FWD_FROM}/landing`,
      redir.headers.location,
    );
    const cookies = await raw(FWD_FROM, "/cookies", { cookie: COOKIE });
    check(
      "站点的 Set-Cookie：Domain 去掉了，设 ys_session 的那条被丢掉",
      JSON.stringify(cookies.headers["set-cookie"]) ===
        JSON.stringify(["app=1; Path=/"]),
      JSON.stringify(cookies.headers["set-cookie"]),
    );

    // 6) 用户浏览器里的页面
    const r = await popup.evaluate(() => window.__r);
    check(
      "转发出来的页面在用户浏览器里：自己的接口、WebSocket 回声、SSE 都通",
      r.own === "hello from site" && r.ws === "echo:hi" && r.sse === "tick",
      JSON.stringify(r),
    );
    check(
      "页面拿着登录 Cookie 去打 Server 的接口与 WebSocket：都被拦住",
      r.attackFetch === "BLOCKED" && r.attackWs === "BLOCKED",
      `fetch=${r.attackFetch} ws=${r.attackWs}`,
    );
    const rejected = logs
      .join("")
      .split("\n")
      .some(
        (l) =>
          l.includes("拒绝了来源不符的请求") &&
          l.includes(`http://127.0.0.1:${FWD_FROM}`),
      );
    check("Server 日志里记着被拒的来源就是转发出口", rejected);
    // 对照：同样的探测放在 Server 自己的页面里，应当成功（说明上面是被 Origin 校验拦的，不是别的原因）
    const ctl = await page.evaluate(
      `(${ATTACK})(${port}, ${JSON.stringify(SID)})`,
    );
    check(
      "对照：同样的代码在 Server 自己的页面里，请求能到达（读到响应或连上 WebSocket）",
      ctl.attackFetch === "READ 200" && ctl.attackWs === "OPEN",
      `fetch=${ctl.attackFetch} ws=${ctl.attackWs}`,
    );

    // 6b) 手动操作：没被检测到的服务（B 从没在 bash 输出里出现过）也能转发
    const addInput = dialog.getByLabel("添加转发端口");
    await addInput.fill("nope:1");
    expectedBad = 1;
    await addInput.press("Enter");
    check(
      "写错目标：输入框下面有行内提示，输入保留",
      !!(await until(
        async () => (await dialog.getByText(/找不到主机 nope/).count()) === 1,
        5000,
      )) && (await addInput.inputValue()) === "nope:1",
    );
    await addInput.fill(String(sitePortB));
    await addInput.press("Enter");
    const rowB = dialog.locator(".u-lrow", { hasText: `本机:${sitePortB}` });
    check(
      "手动添加没被检测到的端口：这一行出现并写着转发端口，输入框清空，没有自动开窗口",
      !!(await until(
        async () =>
          (await rowB.getByText(`转发端口 ${FWD_FROM + 1}`).count()) === 1,
        8000,
      )) &&
        (await addInput.inputValue()) === "" &&
        popups === 1,
      `弹窗 ${popups} 个`,
    );
    await shot("forward-4-manual");
    check(
      "手动转发的服务经出口能访问（带登录 Cookie）",
      (await raw(FWD_FROM + 1, "/", { cookie: COOKIE })).body === "B ok",
    );
    await siteRow().hover();
    await siteRow().getByRole("button", { name: "复制转发地址" }).click();
    const copied = await until(
      async () =>
        (await page.evaluate(() => navigator.clipboard.readText())) ===
        `http://127.0.0.1:${FWD_FROM}/`,
      5000,
    );
    check("「复制转发地址」：剪贴板里是出口地址", !!copied);
    await rowB.hover();
    await rowB.getByRole("button", { name: "停止转发" }).click();
    check(
      "点 ✕ 停止手动转发的端口：这一行消失（它没被检测到），出口连不上",
      !!(await until(async () => (await rowB.count()) === 0)) &&
        !!(await until(() => refused(FWD_FROM + 1))),
    );

    // 7) 停止转发与持久
    const row = dialog.locator(".u-lrow", { hasText: "转发端口" }).first();
    await row.hover();
    await row.getByRole("button", { name: "停止转发" }).click();
    check(
      "点「停止转发」：列表清空，转发端口连不上",
      !!(await until(async () => (await forwards()).length === 0)) &&
        !!(await until(() => refused(FWD_FROM))),
    );
    await popup.close();
    const reopened = await api("POST", `/workspaces/${ws.id}/forwards`, {
      target: `server:${sitePort}`,
    });
    check(
      "再转发：拿回最小的空闲端口，站点又能访问",
      reopened.json?.localPort === FWD_FROM &&
        (await raw(FWD_FROM, "/hello", { cookie: COOKIE })).body ===
          "hello from site",
    );
    await page.close();

    await stopServer();
    startServer();
    await waitUp();
    const after = await raw(FWD_FROM, "/hello", { cookie: COOKIE }).catch(
      () => null,
    );
    check(
      "Server 重启后：同一个转发端口仍在监听，仍能访问站点",
      after?.body === "hello from site" &&
        (await forwards())[0]?.localPort === FWD_FROM,
      after ? after.body : "连不上",
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
  await stopServer().catch(() => {});
  site.closeAllConnections();
  site.close();
  siteB.close();
  await fake.close();
  rmSync(base, { recursive: true, force: true });
}

check(
  "没有控制台报错与预期之外的失败请求",
  problems.length === 0,
  problems.slice(0, 3).join(" | "),
);
if (crashed)
  console.log(
    `脚本异常：${String(crashed.stack ?? crashed.message)
      .split("\n")
      .slice(0, 6)
      .join(" | ")}`,
  );
const failed = results.filter((x) => !x).length + (crashed ? 1 : 0);
if (failed > 0 && logs.length > 0)
  console.log(
    `Server 日志末尾：${logs.join("").split("\n").slice(-8).join(" | ")}`,
  );
console.log(`\n服务转发：${results.length - failed}/${results.length} 项通过`);
process.exit(failed === 0 ? 0 : 1);
