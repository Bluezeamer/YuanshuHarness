// 浏览器端口发现的真机检查：起真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 假模型（按剧本真的调 bash 与浏览器工具）
// + 两个本地假站点 + 无头 Chromium 当用户的浏览器，不需要真实模型。接线问题（bash 输出有没有接进「见过的端口」、
// Server 有没有知道自己的端口）单测测不到，这里用真 Server 验。
//  1) agent 在 bash 里打印了站点 A 的地址 → 之后 browser_open 这个端口不用批准，页面直接打开
//  2) agent 打开没出现过的站点 B → 弹「允许 agent 访问这个服务？」卡片；点「拒绝」后工具结果说没被批准、没有页面
//  3) 端口列表接口：只有出现过且此刻在监听的 A（B 没出现过不在）；A 关掉后列表变空
//  4) 页面列表里出「端口」栏，点一下打开一个新页面
//  5) 用户自己在地址栏开 B（不需要批准）能打开；开 Server 自己的端口被代理拒绝（service_denied）
//  6) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
//   agent 用的浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用上面装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-ports.mjs [--shots 目录]
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
const base = mkdtempSync(join(root, "tmp", "browser-ports-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(dir, { recursive: true });

// —— 两个假站点：标题区分是哪一个 ——
const mkSite = (title) =>
  http.createServer((_req, res) =>
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(`<!doctype html><title>${title}</title><h1>${title}</h1>`),
  );
const siteA = mkSite("站点A");
const siteB = mkSite("站点B");
await Promise.all(
  [siteA, siteB].map((s) => new Promise((ok) => s.listen(0, "127.0.0.1", ok))),
);
const portA = siteA.address().port;
const portB = siteB.address().port;

const fake = await startFakeModel(
  [
    {
      tools: [
        {
          name: "bash",
          args: {
            command: `echo "dev server ready on http://localhost:${portA}/"`,
          },
        },
      ],
    },
    { tools: [{ name: "browser_open", args: { target: `server:${portA}/` } }] },
    { tools: [{ name: "browser_open", args: { target: `server:${portB}/` } }] },
    { text: "做完了。" },
  ],
  { delay: 20 },
);

const port = 18800 + Math.floor(Math.random() * 90);
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
  return { status: r.status, text, json: text ? JSON.parse(text) : null };
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
  const ws = (
    await api("POST", "/workspaces", {
      name: "端口",
      directories: [{ path: dir }],
    })
  ).json;
  await api("POST", "/sessions", { workspaceId: ws.id });

  const titles = async () =>
    (await api("GET", `/workspaces/${ws.id}/browser`)).json.pages.map(
      (p) => p.title,
    );
  const ports = async () =>
    (await api("GET", `/workspaces/${ws.id}/browser/ports`)).json.ports;

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
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "端口" }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);
    const box = page.locator("textarea").first();
    await box.fill("看看开发服务器。");
    await box.press("Enter");

    // 1) bash 打印了 A 的地址 → 打开 A 不用批准
    check(
      "bash 输出里出现过的端口：browser_open 不问，页面直接打开",
      !!(await until(async () => (await titles()).includes("站点A"), 40000)),
      JSON.stringify(await titles()),
    );

    // 2) B 没出现过 → 审批卡片
    const log = page.getByRole("log", { name: "对话记录" });
    const cardTitle = log.getByText("允许 agent 访问这个服务？");
    await cardTitle.waitFor({ timeout: 40000 });
    const body = await log.innerText();
    check(
      "没出现过的端口：弹「允许 agent 访问这个服务？」，说的是 B 的端口，不是 A",
      body.includes(`server.localhost:${portB}`) &&
        !body.includes(`server.localhost:${portA}`),
    );
    await shot("ports-1-card");
    await log.getByRole("button", { name: "拒绝", exact: true }).click();
    const refused = await until(
      () =>
        fake.requests.some(
          (r) =>
            r.main &&
            JSON.stringify(r.body.messages ?? []).includes("用户没有批准访问"),
        ),
      30000,
    );
    check(
      "点「拒绝」：模型收到「用户没有批准访问」，没有打开 B",
      !!refused && !(await titles()).includes("站点B"),
      JSON.stringify(await titles()),
    );

    // 3) 端口接口：只有出现过且在监听的 A
    const listed = await ports();
    check(
      "端口列表接口：只有 A（出现过且在监听），B 不在；target 是地址栏写法",
      listed.length === 1 &&
        listed[0].port === portA &&
        listed[0].envId === "local" &&
        listed[0].target === `server:${portA}`,
      JSON.stringify(listed),
    );

    // 4) 页面列表里的「端口」栏
    const wb = page.locator(".ws-wb");
    await wb.waitFor();
    await wb.getByRole("button", { name: /^页面/ }).click();
    const dialog = page.getByRole("dialog", { name: "浏览器页面" });
    await dialog.getByText("端口", { exact: true }).waitFor();
    // 页面 A 那一行的文字也带着同样的地址，所以按整段文字取端口栏里的那一行（它的文字只有地址）
    const portRow = dialog
      .getByRole("button")
      .filter({ hasText: new RegExp(`^本机:${portA}$`) });
    await portRow.waitFor();
    check(
      "页面列表里有「端口」栏，写着「本机:A 的端口」",
      (await portRow.count()) === 1,
    );
    await sleep(300);
    await shot("ports-2-list");
    const before = (await titles()).length;
    await portRow.click();
    check(
      "点这一行：再打开一个页面",
      !!(await until(async () => (await titles()).length === before + 1)),
      `${before} → ${(await titles()).length}`,
    );

    // 3b) A 关掉后列表变空（探测的是此刻真的在不在监听）
    siteA.closeAllConnections();
    await new Promise((ok) => siteA.close(ok));
    check(
      "站点 A 关掉后，端口列表变空",
      (await ports()).length === 0,
      JSON.stringify(await ports()),
    );

    // 5) 用户自己开：B 能开（不需要批准）；Server 自己的端口被代理拒
    const ownB = await api("POST", `/workspaces/${ws.id}/browser/pages`, {
      target: `server:${portB}/`,
    });
    check(
      "用户在地址栏开 B：不需要批准，能打开",
      ownB.status === 201 &&
        ownB.json.deny === null &&
        ownB.json.status === 200,
      `${ownB.status} ${ownB.text.slice(0, 120)}`,
    );
    const self = await api("POST", `/workspaces/${ws.id}/browser/pages`, {
      target: `server:${port}/`,
    });
    check(
      "开 Server 自己的端口：被代理拒绝（service_denied）",
      self.json?.deny === "service_denied",
      `${self.status} ${self.text.slice(0, 160)}`,
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
  siteA.close();
  siteB.close();
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
  `\n浏览器端口发现：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
