// 目标（goal.md）自主续跑的真机检查：起真实 Server（临时数据目录）+ 假模型 + 无头 Chromium。
//  1) 用户 /goal 设目标：agent 空闲就立刻续跑，每轮前出一行「目标 · 第 n / 上限 轮」；模型调 update_goal complete 收尾，
//     右栏的目标块随之消失；注入的消息带目标文本，系统提示里没有目标；刷新后卡片仍按原位置在
//  2) 模型自己 create_goal：卡片写「模型设了目标」；连续 3 轮没调工具判受阻，收尾总结后右栏显示受阻与「继续」；
//     点继续轮数重新计数，下一轮模型宣布完成
//  3) 用户点停止：目标暂停（原因是你停止了运行），之后不会被自动拉起来；/goal clear 删除
//  4) 默认轮数上限设成 1：用尽后先给一轮收尾，再判受阻（轮数用完）
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-goal.mjs [--shots 目录]
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
const base = mkdtempSync(join(root, "tmp", "goal-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });
// 临时 HOME：Server 读 <HOME>/.pi/agent 与 <HOME>/.ys，不碰真实的
const home = join(base, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

// 取对话里最近一条目标消息给的 goal_id 与 revision（假模型的工具参数要用）
const goalRefs = (messages) => {
  for (const m of [...messages].reverse()) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((p) => p.text ?? "").join("");
    const hit = /goal_id: (\S+), revision: (\d+)/.exec(text);
    if (hit) return { goal_id: hit[1], revision: Number(hit[2]) };
  }
  throw new Error("对话里没有目标消息");
};
const complete = {
  name: "update_goal",
  args: (messages) => ({ ...goalRefs(messages), action: "complete" }),
};

const fake = await startFakeModel(
  [
    // 1) 用户 /goal：三轮，第三轮宣布完成
    { tools: [{ name: "bash", args: { command: "echo r1" } }] }, //  1
    { text: "第一轮完成 S1R1" }, //                                   2
    { tools: [{ name: "bash", args: { command: "echo r2" } }] }, //  3
    { text: "第二轮完成 S1R2" }, //                                   4
    { tools: [complete] }, //                                         5
    { text: "全部完成 S1DONE" }, //                                   6
    // 2) 模型自己设目标；三轮只说话不调工具 → 受阻；继续后宣布完成
    {
      tools: [{ name: "create_goal", args: { objective: "模型自己设的目标" } }],
    }, // 7
    { text: "已设定目标并开始 S2A" }, //                             8
    { text: "S2R1" }, //                                              9
    { text: "S2R2" }, //                                             10
    { text: "S2R3" }, //                                             11
    { text: "S2WRAP" }, //                                           12（受阻后的收尾）
    { tools: [complete] }, //                                        13
    { text: "S2DONE" }, //                                           14
    // 3) 慢任务：跑着被停止
    { tools: [{ name: "bash", args: { command: "sleep 25" } }] }, // 15
    // 4) 上限 1 轮：一轮后收尾并受阻
    { text: "S4R1" }, //                                             16
    { text: "S4WRAP" }, //                                           17
  ],
  { delay: 0 },
);

const port = 18400 + Math.floor(Math.random() * 90);
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
  // 默认的「规则」档里 bash 要人工审批；这里只验目标，放行
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
    const say = async (text, mark) => {
      await box.fill(text);
      await box.press("Enter");
      if (!mark) return;
      try {
        await page.getByText(mark).waitFor({ timeout: 60000 });
      } catch (e) {
        await shot(`fail-${mark}`);
        throw e;
      }
      await sleep(500);
    };
    // 对话流里的目标卡片：按文档顺序取 data-kind
    const kinds = () =>
      page
        .locator("[data-kind^='goal-']")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
    const cardText = (kind) =>
      page
        .locator(`[data-kind='${kind}']`)
        .evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    // 右栏的目标块；窄窗格里右栏收成竖排标签，要悬停才展开
    const goalBlock = async () => {
      const rail = page.locator('[data-rail="goal"]');
      if (await rail.count()) await rail.hover();
      return page.locator('[data-block="goal"]');
    };
    const blockGone = async () => {
      for (let i = 0; i < 40; i++) {
        if (
          (await page.locator('[data-block="goal"]').count()) === 0 &&
          (await page.locator('[data-rail="goal"]').count()) === 0
        )
          return true;
        await sleep(250);
      }
      return false;
    };
    const idx = (arr, k, from = 0) => arr.indexOf(k, from);

    // ── 1) 用户设目标，三轮，模型宣布完成 ──
    await say("/goal 把测试补齐", "S1DONE");
    const k1 = await kinds();
    check(
      "对话流里依次是：设定、三条续跑线、完成",
      k1.join() === "goal-set,goal-round,goal-round,goal-round,goal-complete",
      k1.join(),
    );
    const rounds = await cardText("goal-round");
    check(
      "续跑线写明「第 n / 50 轮」",
      rounds.length === 3 &&
        rounds.every((t, i) => t.includes(`第 ${i + 1} / 50 轮`)),
      rounds.join(" | "),
    );
    const mains = fake.requests.filter((r) => r.main);
    const firstBody = JSON.stringify(mains[0]?.body.messages ?? []);
    check(
      "第一轮请求里有「[Goal round 1/50]」与目标原文",
      firstBody.includes("[Goal round 1/50]") &&
        firstBody.includes("把测试补齐"),
    );
    const sys = mains[0]?.body.messages?.[0];
    check(
      "系统提示里没有目标文本（目标只在注入消息里）",
      !JSON.stringify(sys).includes("把测试补齐"),
    );
    check("完成后右栏的目标块消失", await blockGone());
    await shot("1-complete");
    await page.reload();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await page
      .locator("[data-kind='goal-complete']")
      .waitFor({ timeout: 10000 });
    const k1r = await kinds();
    check("刷新后卡片仍在，顺序不变", k1r.join() === k1.join(), k1r.join());

    // ── 2) 模型自己设目标；无工具调用 3 轮 → 受阻；继续后完成 ──
    await say("做个大任务 S2", "S2WRAP");
    const g2 = await goalBlock();
    await g2.waitFor({ timeout: 10000 });
    const t2 = (await g2.textContent()) ?? "";
    check(
      "右栏标「模型设定」，状态是受阻（连续 3 轮没有调用工具）",
      t2.includes("模型设定") &&
        t2.includes("受阻：连续 3 轮没有调用工具") &&
        t2.includes("3 / 50 轮"),
      t2.slice(0, 100),
    );
    const k2 = (await kinds()).slice(k1.length);
    check(
      "对话流里：模型设了目标、三条续跑线、受阻（收尾总结跟在后面）",
      k2.join() === "goal-set,goal-round,goal-round,goal-round,goal-blocked",
      k2.join(),
    );
    check(
      "模型设目标的卡片这样写",
      ((await cardText("goal-set"))[1] ?? "").includes("模型设了目标"),
    );
    await shot("2-blocked");
    await g2.locator("[data-goalact='resume']").click();
    await page.getByText("S2DONE").waitFor({ timeout: 60000 });
    await sleep(500);
    const k2b = (await kinds()).slice(k1.length);
    check(
      "点「继续」：多一张恢复卡，轮数重新计数（又出一条第 1 轮），最后完成",
      idx(k2b, "goal-resumed") > 0 &&
        k2b.at(-1) === "goal-complete" &&
        (await cardText("goal-round")).at(-1)?.includes("第 1 / 50 轮"),
      k2b.join(),
    );
    check("完成后右栏的目标块消失", await blockGone());

    // ── 3) 停止即暂停，不会被自动拉起来 ──
    await say("/goal 慢任务 S3", null);
    const g3 = await goalBlock();
    await g3.waitFor({ timeout: 10000 });
    await page
      .getByRole("button", { name: "停止运行" })
      .waitFor({ timeout: 60000 });
    await sleep(1000);
    await page.getByRole("button", { name: "停止运行" }).click();
    await page.locator("[data-kind='goal-paused']").waitFor({ timeout: 15000 });
    const pausedText = (await cardText("goal-paused")).at(-1) ?? "";
    check(
      "卡片写明因为你停止了运行",
      pausedText.includes("目标已暂停：你停止了运行"),
      pausedText,
    );
    const before = fake.requests.length;
    await sleep(3000);
    check("停止后没有再被自动续跑", fake.requests.length === before);
    const g3b = await goalBlock();
    check(
      "右栏显示已暂停与「继续」",
      ((await g3b.textContent()) ?? "").includes("已暂停") &&
        (await g3b.locator("[data-goalact='resume']").count()) === 1,
    );
    await shot("3-paused");
    await say("/goal clear", null);
    await page
      .locator("[data-kind='goal-cleared']")
      .waitFor({ timeout: 10000 });
    check("/goal clear：多一张删除卡，右栏的块消失", await blockGone());

    // ── 4) 默认上限 1 轮：用尽后收尾并受阻 ──
    await api("PUT", "/defaults", { goalMaxRounds: 1 });
    await say("/goal 受限任务 S4", "S4WRAP");
    const g4 = await goalBlock();
    await g4.waitFor({ timeout: 10000 });
    const t4 = (await g4.textContent()) ?? "";
    check(
      "右栏：受阻（轮数用完），已用 1 / 1 轮",
      t4.includes("受阻：轮数用完") && t4.includes("1 / 1 轮"),
      t4.slice(0, 100),
    );
    const blocked = (await cardText("goal-blocked")).at(-1) ?? "";
    check(
      "对话流里有「目标受阻：轮数用完」",
      blocked.includes("目标受阻：轮数用完"),
      blocked,
    );
    const lastBody = JSON.stringify(
      fake.requests.filter((r) => r.main).at(-1)?.body.messages ?? [],
    );
    check(
      "收尾请求里写明轮数上限，并要求总结、不再调工具",
      lastBody.includes("round limit") &&
        lastBody.includes("Do not call any more tools"),
    );
    await shot("4-round-limit");
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
    : `\nPASS  目标自主续跑：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
