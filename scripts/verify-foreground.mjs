// 回前台恢复（会话流、列表流）的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，不需要真实模型。
// 用 Playwright 的 routeWebSocket 夹在页面与 Server 之间，能让一条连接「看着开着其实已死」（双向都丢）。
//  1) 连接正常：回前台信号（online）让两条流各发一个 ping，Server 回 ack / pong，之后不会无故重连
//  2) 连接已死：回前台后 ping 没有回音，约 3 秒后页面关掉旧连接、各建一条新连接并拿到新快照
//  3) 连接被对端关掉、正在等重试：回前台立即重连，不必等 1 秒 / 3 秒的退避
//  4) 全程没有控制台报错、没有失败的接口请求
// 浏览器事件流与画面流同一套写法，由单测（store.test / usePageStream.test）覆盖，这里不起浏览器页面。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-foreground.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "foreground-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });
const port = 18100 + Math.floor(Math.random() * 90);
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
  { stdio: "ignore", cwd: work },
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
  // 创建会话要有个能解析的模型；这里不会真的调用它
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
    name: "甲",
    directories: [{ path: work }],
  });
  await api("POST", "/sessions", { workspaceId: ws.id });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
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

    // 页面与 Server 之间的每条流一个记录：dead 时双向都丢，页面看到的就是一条没有任何动静的连接。
    const conns = [];
    await page.routeWebSocket(
      /\/api\/v1\/(library\/stream|sessions\/[^/]+\/stream)$/,
      (route) => {
        const c = {
          kind: route.url().includes("/library/") ? "library" : "session",
          dead: false,
          sent: [],
          received: [],
          pageClosed: false,
          route,
        };
        conns.push(c);
        const server = route.connectToServer();
        route.onMessage((m) => {
          if (typeof m === "string") c.sent.push(m);
          if (!c.dead) server.send(m);
        });
        server.onMessage((m) => {
          if (typeof m === "string") c.received.push(m);
          if (!c.dead) route.send(m);
        });
        route.onClose(() => {
          c.pageClosed = true;
          server.close();
        });
        server.onClose(() => {
          if (!c.dead) route.close();
        });
      },
    );

    const of = (kind) => conns.filter((c) => c.kind === kind);
    const live = (kind) => of(kind).findLast((c) => !c.dead && !c.pageClosed);
    const pings = (c) => c.sent.filter((m) => m.includes('"ping"')).length;
    const gotSnapshot = (c) =>
      c.received.some((m) => m.includes('"type":"snapshot"'));
    // 回前台信号：先让合并窗口（300ms）过去
    const foreground = async () => {
      await sleep(400);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
    };
    const waitFor = async (cond, ms = 8000) => {
      for (let t = 0; t < ms; t += 100) {
        if (cond()) return true;
        await sleep(100);
      }
      return cond();
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "甲" }).click();
    const ready = await waitFor(
      () =>
        live("library") &&
        live("session") &&
        gotSnapshot(live("library")) &&
        gotSnapshot(live("session")),
    );
    check("前提：列表流与会话流都已连上并拿到快照", ready);

    // 1) 连接正常
    let lib = live("library");
    let ses = live("session");
    await foreground();
    const answered = await waitFor(
      () =>
        pings(lib) === 1 &&
        pings(ses) === 1 &&
        lib.received.some((m) => m.includes('"type":"pong"')) &&
        ses.received.some(
          (m) => m.includes('"ok":true') && m.includes('"ack"'),
        ),
      3000,
    );
    check(
      "连接正常：回前台各发一个 ping，Server 回 pong / ack",
      answered,
      `library ping=${pings(lib)} session ping=${pings(ses)}`,
    );
    await sleep(4000);
    check(
      "探针有回音：之后不重连（各只有一条连接，没被关）",
      of("library").length === 1 &&
        of("session").length === 1 &&
        !lib.pageClosed &&
        !ses.pageClosed,
      `library=${of("library").length} session=${of("session").length}`,
    );

    // 2) 连接已死
    lib.dead = true;
    ses.dead = true;
    await foreground();
    const reborn = await waitFor(
      () =>
        of("library").length === 2 &&
        of("session").length === 2 &&
        gotSnapshot(live("library")) &&
        gotSnapshot(live("session")),
      9000,
    );
    check(
      "连接已死：约 3 秒后关掉旧连接，列表流与会话流各建新连接并拿到新快照",
      reborn && lib.pageClosed && ses.pageClosed,
      `library=${of("library").length} session=${of("session").length} 旧连接已关=${lib.pageClosed && ses.pageClosed}`,
    );
    await sleep(1500);

    // 3) 对端关掉连接、正在等重试：回前台立即重连（列表流退避 1 秒、会话流 3 秒）
    lib = live("library");
    ses = live("session");
    const before = [of("library").length, of("session").length];
    lib.route.close();
    ses.route.close();
    await sleep(300);
    await foreground();
    const quick = await waitFor(
      () =>
        of("library").length === before[0] + 1 &&
        of("session").length === before[1] + 1,
      900,
    );
    check(
      "对端关掉连接、在等重试：回前台立即重连，不等退避",
      quick,
      `library=${of("library").length} session=${of("session").length}`,
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
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = results.filter((r) => !r).length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 项`
    : `\nPASS  回前台恢复：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
