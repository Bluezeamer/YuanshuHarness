// 后台任务回调卡与任务标签的真机检查：起真实 Server（临时数据目录）+ 假模型 + 无头 Chromium。
//  1) bash 超过 remind_after 转后台、跑完后回调唤醒模型：对话流里出现回调卡（已完成）
//  2) 点回调卡：开「任务」标签，完整命令原样显示，输出里有跑完的内容；再点同一张卡只激活、不重复开
//  3) 右栏「后台任务」块只列在跑的任务（已完成的不在）；在跑的任务实时出输出，输出多了贴底跟随，上翻出「回到底部」
//  4) 在任务标签里点停止（二次确认）：状态变「已停止」，右栏的块消失，对话流里多一张停止的回调卡
//  5) 刷新页面：两张卡仍按原位置在（历史接口带回调卡），点开仍能看到完整命令
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-jobs.mjs [--shots 目录]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "./lib/fake-model.mjs";
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

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "jobs-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });
// 临时 HOME：Server 读 <HOME>/.pi/agent，不碰真实的 ~/.pi
const home = join(base, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

const SHORT =
  "for i in 1 2 3; do echo tick-$i; sleep 1; done; echo finished-job";
// 先一口气打 120 行（让输出高过窗格才有「贴底」可言），再每秒一行，直到被停
const LONG =
  'for i in $(seq 1 120); do echo "line-$i"; done; while true; do echo "live-$(date +%s%N)"; sleep 1; done';
const fake = await startFakeModel(
  [
    { tools: [{ name: "bash", args: { command: SHORT, remind_after: 1 } }] },
    { text: "短任务已转后台。MARK1" },
    // 任务跑完后回调把模型唤醒
    { text: "收到短任务的回调。MARK2" },
    { tools: [{ name: "bash", args: { command: LONG, remind_after: 1 } }] },
    { text: "长任务已转后台。MARK3" },
    // 被停止后的回调
    { text: "收到长任务被停止的回调。MARK4" },
  ],
  { delay: 0 },
);

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
  { stdio: "ignore", cwd: work, env: { ...process.env, HOME: home } },
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
  const registered = await api("POST", "/providers", {
    name: "假模型",
    slug: "fake",
    api: "openai-completions",
    baseUrl: fake.baseUrl,
    apiKey: "x",
    models: [
      {
        id: "fake",
        name: "fake",
        reasoning: true,
        levels: ["off", "low", "high"],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  if (registered?.error)
    throw new Error(`注册假模型失败：${JSON.stringify(registered)}`);
  // 默认的「规则」档里 bash 要人工审批；这里只验后台任务，放行
  await api("PUT", "/defaults", { permissionTier: "full" });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1600, height: 900 } })
    ).newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error")
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    const shot = (n) =>
      SHOTS ? page.screenshot({ path: join(SHOTS, `${n}.png`) }) : null;

    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(work);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);

    const box = page.locator("textarea").first();
    const ask = async (text, mark) => {
      await box.fill(text);
      await box.press("Enter");
      try {
        await page.getByText(mark).waitFor({ timeout: 30000 });
      } catch (e) {
        await shot(`fail-${mark}`);
        throw e;
      }
      await sleep(400);
    };
    const cards = () => page.locator("[data-job-notice]");
    // 任务标签与对话标签在同一个窗格里，点回对话标签
    const toChat = async () => {
      await page
        .getByRole("tab", { name: /跑个短任务/ })
        .first()
        .click();
      await box.waitFor();
    };
    const jobView = () => page.locator("[data-job-view]");
    const logBox = () => page.getByRole("log", { name: "任务输出" });
    const gap = () =>
      logBox().evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      );

    // 1) 短任务转后台，跑完后回调把模型唤醒；对话流里有回调卡
    await ask("跑个短任务", "MARK1");
    await page.getByText("MARK2").waitFor({ timeout: 30000 });
    await sleep(500);
    check("跑完后对话流里有一张回调卡", (await cards().count()) === 1);
    const first = cards().first();
    check(
      "卡片是「已完成」，标题是命令的开头",
      (await first.getAttribute("data-state")) === "done" &&
        ((await first.textContent()) ?? "").includes("for i in 1 2 3"),
      (await first.textContent())?.trim().slice(0, 60),
    );
    await shot("1-card");

    // 2) 点卡片：开任务标签，完整命令原样显示、输出里有跑完的内容
    await first.getByRole("button").click();
    await jobView().waitFor();
    check(
      "任务标签里的命令是完整的原文",
      ((await page.locator('[data-jv="input"]').textContent()) ?? "") === SHORT,
    );
    await page
      .locator('[data-jv="log"]')
      .filter({ hasText: "finished-job" })
      .waitFor({ timeout: 10000 });
    const logText = (await page.locator('[data-jv="log"]').textContent()) ?? "";
    check(
      "输出里有三行 tick 与收尾那一行",
      ["tick-1", "tick-2", "tick-3", "finished-job"].every((s) =>
        logText.includes(s),
      ),
    );
    check(
      "状态是「已完成」",
      (await page.locator('[data-jv="state"]').textContent()) === "已完成",
    );
    await shot("2-job-tab");
    // 回到对话标签再点同一张卡：只激活已开的任务标签，不重复开
    await toChat();
    await first.getByRole("button").click();
    await jobView().waitFor();
    await sleep(300);
    check(
      "再点同一张卡只激活，不重复开标签",
      (await page.locator("[data-job-view]").count()) === 1,
    );
    await toChat();

    // 3) 长任务：右栏出现在跑的任务，输出实时增长并贴底
    await ask("再跑个长任务", "MARK3");
    const row = page.locator("[data-job]").filter({ hasText: "seq 1 120" });
    // 窗格不够宽时状态栏收成竖排标签：鼠标移上去才展开那一块
    await page.locator('[data-rail="job"]').hover();
    await row.waitFor({ timeout: 10000 });
    check(
      "右栏「后台任务」里只有在跑的任务，已完成的那个不在",
      (await page.locator('[data-block="job"] [data-job]').count()) === 1 &&
        (await row.getAttribute("data-state")) === "running",
    );
    await row.hover();
    await sleep(400);
    await shot("3-rail");
    await row
      .getByRole("button", { name: /seq 1 120/ })
      .first()
      .click();
    await page
      .locator('[data-job-view][data-job-state="running"]')
      .waitFor({ timeout: 10000 });
    await page
      .locator('[data-jv="log"]')
      .filter({ hasText: "line-120" })
      .waitFor({ timeout: 10000 });
    const before = await page.locator('[data-jv="log"]').textContent();
    await sleep(2500);
    const after = await page.locator('[data-jv="log"]').textContent();
    check(
      "在跑的任务输出实时增长",
      (after ?? "").length > (before ?? "").length,
      `${before?.length} → ${after?.length}`,
    );
    const tall = await logBox().evaluate(
      (el) => el.scrollHeight / el.clientHeight,
    );
    check("前置：输出高过窗格", tall > 1.5, `${tall.toFixed(1)}x`);
    check("输出多了仍贴底跟随", (await gap()) <= 2, `距底 ${await gap()}px`);
    await logBox().evaluate((el) => {
      el.scrollTop = 0;
    });
    await sleep(2500);
    const away = await logBox().evaluate((el) => el.scrollTop);
    check("上翻后不再被拽回底部", away <= 2, `scrollTop ${away}`);
    await page.getByRole("button", { name: "回到底部" }).click();
    await sleep(300);
    check("点「回到底部」回到底", (await gap()) <= 2, `距底 ${await gap()}px`);
    await shot("4-live");

    // 4) 停止（二次确认）：状态变「已停止」，对话流多一张停止的回调卡，模型被唤醒
    await page
      .locator('[data-job-view][data-job-state="running"]')
      .getByRole("button", { name: "停止" })
      .click();
    await page.getByRole("button", { name: "确认停止" }).click();
    await page
      .locator('[data-job-view][data-job-state="stopped"]')
      .waitFor({ timeout: 10000 });
    check(
      "任务标签里状态是「已停止」",
      (await page.locator('[data-jv="state"]').textContent()) === "已停止",
    );
    // 任务结束后右栏的块随之消失（没有别的在跑的任务）
    await page
      .locator('[data-rail="job"]')
      .waitFor({ state: "detached", timeout: 10000 });
    check("任务结束后右栏的「后台任务」块消失", true);
    await toChat();
    // 切回对话标签会触发布局保存（800ms 防抖）；等它落盘再刷新，
    // 否则 pagehide 的 keepalive 写入可能赶不上新页面的读取，刷新后停在任务标签上
    const layoutSaved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith("/layout"),
    );
    await page.getByText("MARK4").waitFor({ timeout: 30000 });
    await sleep(500);
    check(
      "对话流里多了一张「已停止」的卡",
      (await cards().count()) === 2 &&
        (await cards().nth(1).getAttribute("data-state")) === "stopped",
    );
    await shot("5-stopped");

    // 5) 刷新：两张卡仍在，点开仍是完整命令
    await layoutSaved;
    await page.reload();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await cards().first().waitFor({ timeout: 10000 });
    await sleep(500);
    check("刷新后两张卡仍在", (await cards().count()) === 2);
    const states = await cards().evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-state")),
    );
    check(
      "刷新后顺序与状态不变（先完成、后停止）",
      states.join() === "done,stopped",
      states.join(),
    );
    // 刷新后没被点开过的任务标签：标题从右栏拿到的任务清单里补，不是都叫「后台任务」
    await sleep(1500);
    const titles = await page
      .getByRole("tab", { name: /for i in|后台任务/ })
      .allTextContents();
    check(
      "刷新后两个任务标签的标题是各自命令的开头",
      titles.length === 2 && titles.every((t) => t.includes("for i in")),
      titles.join(" | "),
    );
    await shot("6-reload");
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
  await fake.close();
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

const uniq = [...new Set(problems)];
check("全程没有控制台报错", uniq.length === 0, uniq.slice(0, 5).join(" | "));
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = results.filter((r) => !r).length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 项`
    : `\nPASS  后台任务回调卡与任务标签：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
