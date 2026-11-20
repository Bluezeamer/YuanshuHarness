// agent 展示页面与请求使用页面的真机检查：起真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 假模型（按剧本真的调
// browser_show / browser_handoff）+ 本地假站点 + 无头 Chromium 当用户的浏览器，不需要真实模型。
//  1) browser_show：用户界面弹出不自动消失的提示「会话「标题」展示了页面「标题」：说明」（没有手动名的会话标题取首条消息），带「查看」「忽略」；点「忽略」提示消失；
//     模型收到的工具结果如实说「已向 1 个在线界面发出展示提示」
//  2) browser_handoff 的第二个方向：页面此刻是用户在操作，agent 请求使用它——页面上的横幅写「agent 请求使用这个页面」，
//     用户点「交给 agent」后操作权回到 agent，模型收到的结果带 `handoff: user handed the page to the agent`
//  3) 点「查看」：提示消失，浏览器标签切到被展示的页面
//  4) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-browser-show.mjs [--shots 目录]
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
const base = mkdtempSync(join(root, "tmp", "browser-show-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(dir, { recursive: true });

const site = http.createServer((_req, res) => {
  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end("<!doctype html><title>报表页</title><h1>季度报表</h1>");
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
const NOTE = "这是你要的季度报表";
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
          args: (messages) => ({ pageId: pageIdOf(messages), note: NOTE }),
        },
      ],
    },
    { text: "已经展示给你了。" },
    // 第二条消息：页面此刻是用户在操作，请求使用它
    {
      tools: [
        {
          name: "browser_handoff",
          args: (messages) => ({
            pageId: pageIdOf(messages),
            reason: "想接着帮你整理",
          }),
        },
      ],
    },
    {
      tools: [
        {
          name: "browser_show",
          args: (messages) => ({ pageId: pageIdOf(messages) }),
        },
      ],
    },
    { text: "接着做。" },
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
      name: "展示",
      directories: [{ path: dir }],
    })
  ).json;
  await api("POST", "/sessions", { workspaceId: ws.id });

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
    const btn = (name) => wb.getByRole("button", { name, exact: true }).first();
    /** 展示提示（右下角 toast）：按文字找。 */
    const showToast = () => page.locator(".u-toast", { hasText: "展示了页面" });
    /** 模型某次请求里是否带着含某段文字的工具结果。 */
    const sawResult = (text) =>
      fake.requests.some(
        (r) =>
          r.main &&
          (r.body.messages ?? []).some(
            (m) =>
              m.role === "tool" && JSON.stringify(m.content).includes(text),
          ),
      );
    const say = async (text) => {
      const box = page.locator("textarea").first();
      await box.fill(text);
      await box.press("Enter");
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "展示" }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(600);

    // 1) browser_show：不阻塞，提示留着直到用户处理
    await say("把报表展示给我看。");
    await showToast().waitFor({ timeout: 60000 });
    const t1 = (await showToast().textContent()) ?? "";
    check(
      "show：提示写着标题与 agent 的说明",
      t1.includes("展示了页面「报表页」") &&
        t1.includes(NOTE) &&
        t1.startsWith("会话「把报表展示给我看。」"),
      t1,
    );
    check(
      "show：提示带「查看」「忽略」",
      (await showToast().getByRole("button", { name: "查看" }).count()) === 1 &&
        (await showToast().getByRole("button", { name: "忽略" }).count()) === 1,
    );
    await sleep(4000);
    check("show：提示不自动消失", (await showToast().count()) === 1);
    await shot("show-1-toast");
    check(
      "show：模型收到「已向 1 个在线界面发出展示提示」",
      !!(await until(() => sawResult("已向 1 个在线界面发出展示提示"))),
    );
    await showToast().getByRole("button", { name: "忽略" }).click();
    check(
      "点「忽略」：提示消失",
      !!(await until(async () => (await showToast().count()) === 0)),
    );

    // 2) 页面此刻是用户在操作：agent 的 handoff 变成「请求使用」
    await wb.waitFor({ timeout: 30000 });
    await btn("手动操作").click();
    await until(async () => (await btn("交给 agent").count()) === 1);
    await say("接着整理一下。");
    // 工具条上方还可能有别的横幅（沙盒、emoji 字体等随机器而变），只取接管横幅这一条
    const strip = page.locator(".ws-wb-strip", {
      hasText: "agent 请求使用这个页面",
    });
    await strip.getByText(/agent 请求使用这个页面/).waitFor({ timeout: 60000 });
    check(
      "claim：横幅写着请求使用与原因，按钮是「交给 agent」",
      (await strip.textContent())?.includes("想接着帮你整理") === true &&
        (await strip.getByRole("button", { name: "交给 agent" }).count()) === 1,
      (await strip.textContent()) ?? "",
    );
    await shot("show-2-claim-banner");
    await strip.getByRole("button", { name: "交给 agent" }).click();
    check(
      "claim：点「交给 agent」后模型收到 handoff 交还结果",
      !!(await until(() =>
        sawResult("handoff: user handed the page to the agent"),
      )),
    );
    const pages = async () =>
      (await api("GET", `/workspaces/${ws.id}/browser`)).json.pages;
    check(
      "claim：页面操作权回到 agent",
      !!(await until(async () => (await pages())[0]?.controller === "agent")),
      JSON.stringify((await pages()).map((p) => p.controller)),
    );

    // 3) 剧本里紧接着又展示了一次：这回点「查看」，提示消失，标签里是这个页面
    await showToast().waitFor({ timeout: 60000 });
    const t2 = (await showToast().textContent()) ?? "";
    check("再次展示：没有说明时提示里没有冒号", !t2.includes("："), t2);
    await showToast().getByRole("button", { name: "查看" }).click();
    check(
      "点「查看」：提示消失",
      !!(await until(async () => (await showToast().count()) === 0)),
    );
    check(
      "点「查看」：浏览器标签里显示被展示的页面",
      !!(await until(async () =>
        (
          await page.getByLabel("页面地址").inputValue()
        ).includes(`:${sitePort}`),
      )),
      await page.getByLabel("页面地址").inputValue(),
    );
    await shot("show-3-viewed");

    check(
      "全程没有控制台报错、没有失败的接口请求",
      problems.length === 0,
      problems.slice(0, 3).join(" | "),
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
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀（否则每跑一次留一个孤儿 Server）
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
if (crashed)
  console.log(`脚本异常：${String(crashed?.stack ?? crashed).slice(0, 600)}`);
console.log(
  `\n展示页面与请求使用：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 && !crashed ? 0 : 1);
