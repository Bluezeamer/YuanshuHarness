// 「默认值设置」页的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，量 jsdom 测不出的事。
//  1) 对齐与溢出：页签文字落在页面留白 24；三个页签在 1440 / 1024 / 780 宽下没有横向滚动；
//     模型表里的下拉文字没有被截断；
//  2) 模型与权限：改了进草稿、不发请求；保存条浮在底部、不挤动内容；保存才落库；
//     审批模型配好后「模型」档才可选，清掉审批模型时档位退回「规则」；改了没保存时切页签要先问；
//  3) 会话与任务：填错就地提示、保存被拦住；填对保存后真的落库，重新打开页面仍是新值；
//     压缩与重试：三档预设与展开的数字、保存后写进 <HOME>/.ys/settings.json（别的键原样保留，
//     改回 pi 的值就删掉这一项），文件被手改后重新打开读到的是新值；
//  4) 输入与显示：图片压缩上限默认收起；界面字号拖动即时生效、不出保存条、刷新后仍在。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-defaults.mjs   （SHOTS=目录 顺带存截图）
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (shots) mkdirSync(shots, { recursive: true });

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "defaults-"));
const work = join(base, "work");
mkdirSync(work, { recursive: true });
// 临时 HOME：Server 读 <HOME>/.pi/agent 与 <HOME>/.ys，保存压缩与重试设置时不能写到真实的 ~/.ys
const home = join(base, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
const settingsFile = join(home, ".ys", "settings.json");
const port = 17850 + Math.floor(Math.random() * 90);
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

const problems = [];
let checks = 0;
const check = (where, ok, detail = "") => {
  checks++;
  if (!ok) problems.push(`${where}${detail ? `：${detail}` : ""}`);
};

const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await r.text();
  if (r.status >= 300)
    throw new Error(`${method} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const defaultsNow = () => api("GET", "/defaults");
const agentNow = () => api("GET", "/agent-settings");
const fileNow = () => JSON.parse(readFileSync(settingsFile, "utf8"));
const modelNow = async () => (await api("GET", "/default-model")).default;

// 一个能思考的和一个不能思考的模型；名字故意取得长一点，看下拉会不会截断
const ENDPOINT = ["http:/", "127.0.0.1:9/v1"].join("/");
async function seed() {
  const m = (id, levels) => ({
    id,
    reasoning: levels.length > 0,
    levels,
    input: ["text"],
    ctx: 8000,
    out: 1000,
    source: "manual",
  });
  await api("POST", "/providers", {
    name: "本地 vLLM",
    slug: "local-vllm",
    api: "openai-completions",
    baseUrl: ENDPOINT,
    models: [
      m("qwen3-coder-30b-a3b-instruct", []),
      m("qwen3-thinking-235b", ["off", "minimal", "low", "medium", "high"]),
    ],
  });
  await api("POST", "/providers", {
    name: "另一个供应商",
    slug: "other",
    api: "openai-completions",
    baseUrl: ENDPOINT,
    models: [m("small-fast", [])],
  });
}

const left = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? Math.round(el.getBoundingClientRect().left) : null;
  }, sel);
const metrics = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el
      ? { client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop }
      : null;
  }, sel);
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};
const bar = (page) => page.getByRole("region", { name: "保存" });
const saveNow = async (page) => {
  await bar(page).getByRole("button", { name: "保存" }).click();
  await bar(page).waitFor({ state: "detached", timeout: 4000 });
};
const tab = (page, name) => page.getByRole("tab", { name });
const pick = async (page, trigger, label) => {
  await page.getByLabel(trigger, { exact: true }).click();
  await page.getByRole("option", { name: label }).click();
};

const open = async (page) => {
  page.on("pageerror", (e) => problems.push(`页面报错：${e.message}`));
  await page.goto(`${origin}/settings/defaults`);
  await tab(page, "模型与权限").waitFor({ timeout: 8000 });
  await page.getByLabel("默认模型 供应商", { exact: true }).waitFor();
  await sleep(300);
};

const TABS = ["模型与权限", "会话与任务", "输入与显示"];

async function layout(browser) {
  for (const [w, h] of [
    [1440, 900],
    [1024, 768],
    [780, 800],
  ]) {
    const where = `${w}px 版面`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await open(page);
    const main = await left(page, ".st-main");
    for (const t of TABS) {
      await tab(page, t).click();
      await sleep(250);
      const at = await left(page, ".st-main [role=tab]");
      check(where, at - main === 24, `页签文字离主区 ${at - main}（应为 24）`);
      check(
        where,
        !(await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        )),
        `${t}：出现横向滚动`,
      );
      // 页内的内容也不能把滚动区撑宽
      check(
        where,
        await page.evaluate(() => {
          const s = document.querySelector(".st-scroll");
          return !!s && s.scrollWidth <= s.clientWidth + 1;
        }),
        `${t}：滚动区横向溢出`,
      );
      if (t === "模型与权限") {
        // 下拉里的字不能被省略号吃掉
        const cut = await page.evaluate(() =>
          [...document.querySelectorAll("button[role=combobox]")]
            .filter((b) =>
              [b, ...b.querySelectorAll("*")].some(
                (el) => el.scrollWidth > el.clientWidth + 1,
              ),
            )
            .map((b) => b.getAttribute("aria-label")),
        );
        check(where, cut.length === 0, `下拉文字被截断：${cut.join("、")}`);
      }
    }
    if (w === 1440) {
      await tab(page, "模型与权限").click();
      await sleep(250);
      await shot(page, "defaults-models");
      await tab(page, "会话与任务").click();
      await sleep(250);
      await shot(page, "defaults-session");
      await tab(page, "输入与显示").click();
      await sleep(250);
      await shot(page, "defaults-input");
    }
    await ctx.close();
  }
}

async function modelsTab(browser) {
  const where = "模型与权限";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 480 },
  });
  const page = await ctx.newPage();
  await open(page);

  const scroll0 = await metrics(page, ".st-scroll");
  check(
    where,
    scroll0?.scroll > scroll0?.client,
    `页面没有可滚内容（矮窗口）：${JSON.stringify(scroll0)}`,
  );

  // 改默认模型：进草稿、不发请求；保存条浮在底部、不挤动内容
  await pick(page, "默认模型 模型", "qwen3-thinking-235b");
  await bar(page).waitFor();
  await sleep(400);
  check(
    where,
    (await modelNow())?.model !== "qwen3-thinking-235b",
    "没点保存就改了服务端",
  );
  const scroll1 = await metrics(page, ".st-scroll");
  check(
    where,
    scroll1?.client === scroll0?.client,
    `保存条出现时滚动区高度变了：${scroll0?.client} → ${scroll1?.client}`,
  );
  const box = await bar(page).boundingBox();
  check(
    where,
    !!box && box.y + box.height <= 480 && box.y > 250,
    `保存条不在视口底部：${JSON.stringify(box)}`,
  );
  await page.mouse.move(640, 240);
  await page.mouse.wheel(0, 9000);
  await sleep(300);
  const box2 = await bar(page).boundingBox();
  check(where, !!box2 && Math.abs(box2.y - box.y) < 2, "保存条跟着滚走了");
  await shot(page, "defaults-dirty");
  await saveNow(page);
  const m1 = await modelNow();
  check(
    where,
    m1?.model === "qwen3-thinking-235b" && m1.thinking !== null,
    `保存后服务端没变：${JSON.stringify(m1)}`,
  );

  // 审批模型：配好后「模型」档才可选；清掉时档位退回「规则」
  await page.mouse.wheel(0, -9000);
  const autoTier = page.getByRole("radio", { name: "模型", exact: true });
  check(where, await autoTier.isDisabled(), "没配审批模型时「模型」档没置灰");
  await pick(page, "审批模型 供应商", "另一个供应商");
  check(where, await autoTier.isEnabled(), "配了审批模型「模型」档还是灰的");
  await autoTier.click();
  await saveNow(page);
  const d1 = await defaultsNow();
  check(
    where,
    d1.permissionTier === "auto" && d1.reviewModel?.model === "small-fast",
    `审批模型与档位没一起落库：${JSON.stringify([d1.permissionTier, d1.reviewModel])}`,
  );
  await pick(page, "审批模型 供应商", "未设置");
  check(
    where,
    (await page
      .getByRole("radio", { name: "规则", exact: true })
      .getAttribute("aria-checked")) === "true",
    "清掉审批模型后档位没退回「规则」",
  );
  await saveNow(page);
  const d2 = await defaultsNow();
  check(
    where,
    d2.reviewModel === null && d2.permissionTier === "rules",
    `清除没有落库：${JSON.stringify([d2.permissionTier, d2.reviewModel])}`,
  );

  // 改了没保存：切页签先问；放弃后服务端没变
  await pick(page, "辅助模型 供应商", "本地 vLLM");
  await bar(page).waitFor();
  await tab(page, "会话与任务").click();
  const leave = page.getByRole("dialog", { name: "有未保存的修改" });
  await leave.waitFor({ timeout: 3000 });
  await shot(page, "defaults-leave");
  await leave.getByRole("button", { name: "放弃修改" }).click();
  await page.getByLabel("提醒间隔").waitFor();
  check(where, (await defaultsNow()).auxModel === null, "放弃后服务端还是变了");
  await ctx.close();
}

async function sessionTab(browser) {
  const where = "会话与任务";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page);
  await tab(page, "会话与任务").click();

  // 填错：就地提示、保存被拦住、服务端没动
  await page.getByLabel("提醒间隔").fill("0");
  await page.getByText(/提醒间隔要是 1–1440 的整数/).waitFor();
  await bar(page).getByRole("button", { name: "保存" }).click();
  await page.getByText(/保存失败：有填写不合法的项/).waitFor({ timeout: 3000 });
  check(where, (await defaultsNow()).jobRemindSeconds === 600, "填错也落库了");
  await shot(page, "defaults-invalid");

  // 填对：一次保存三项
  await page.getByLabel("提醒间隔").fill("30");
  await page.getByLabel("每个调用方同时存活").fill("4");
  const start = page.getByLabel("起点路径");
  await start.fill("  /srv/work  ");
  await start.blur();
  check(
    where,
    (await start.inputValue()) === "/srv/work",
    "失焦没去掉首尾空白",
  );
  await saveNow(page);
  const d = await defaultsNow();
  check(
    where,
    d.jobRemindSeconds === 1800 &&
      d.subagentLimits.perCaller === 4 &&
      d.directoryStart === "/srv/work",
    `没有落库：${JSON.stringify([d.jobRemindSeconds, d.subagentLimits, d.directoryStart])}`,
  );

  // 重新打开：读到的是新值，且没有保存条
  await page.reload();
  await tab(page, "会话与任务").click();
  check(
    where,
    (await page.getByLabel("提醒间隔").inputValue()) === "30",
    "重新打开后还是旧值",
  );
  check(where, (await bar(page).count()) === 0, "刚打开就有保存条");

  // 压缩与重试：落在 <HOME>/.ys/settings.json
  const radio = (name) => page.getByRole("radio", { name });
  check(
    where,
    (await radio("pi 默认").getAttribute("aria-checked")) === "true",
    "没写过文件时应停在「pi 默认」",
  );
  check(
    where,
    (await page.getByLabel("预留余量").count()) === 0,
    "数字没有收起",
  );
  await radio("节省上下文").click();
  await shot(page, "defaults-compaction");
  await saveNow(page);
  const a = await agentNow();
  check(
    where,
    a.values.compaction.reserveTokens === 32768 &&
      a.values.compaction.keepRecentTokens === 10000,
    `预设没落库：${JSON.stringify(a.values)}`,
  );
  check(
    where,
    fileNow().compaction?.reserveTokens === 32768,
    "settings.json 里没有写进去",
  );
  check(where, a.file === settingsFile, `文件路径不对：${a.file}`);

  // 展开数字：填错就地提示、保存被拦住
  await page.getByRole("button", { name: "调整数字" }).click();
  await page.getByLabel("预留余量").fill("100");
  await page.getByText(/预留余量要是 4096–65536 的整数/).waitFor();
  await bar(page).getByRole("button", { name: "保存" }).click();
  await page.getByText(/保存失败：有填写不合法的项/).waitFor({ timeout: 3000 });
  check(
    where,
    (await agentNow()).values.compaction.reserveTokens === 32768,
    "填错也落库了",
  );
  await page.getByLabel("预留余量").fill("32768");
  await page.getByLabel("保留最近").fill("12345");
  check(
    where,
    (await radio("自定义").getAttribute("aria-checked")) === "true",
    "数字不在任何一档上时没有显示「自定义」",
  );

  // 手改文件（人或 agent 都会这么做）：加一个我们不认识的键、改重试次数；界面重新打开读到新值，保存不冲掉别的键
  writeFileSync(
    settingsFile,
    JSON.stringify({ retry: { maxRetries: 7 }, other: { keep: true } }),
  );
  await page.reload();
  await tab(page, "会话与任务").click();
  check(
    where,
    (await page.getByLabel("重试次数").inputValue()) === "7",
    "手改文件后界面没读到新值",
  );
  check(
    where,
    (await radio("pi 默认").getAttribute("aria-checked")) === "true",
    "文件里没有压缩项时应回到「pi 默认」",
  );
  await page.getByRole("switch", { name: "自动压缩上下文" }).click();
  await saveNow(page);
  const f = fileNow();
  check(
    where,
    f.compaction?.enabled === false &&
      f.retry?.maxRetries === 7 &&
      f.other?.keep === true,
    `保存冲掉了手写的键：${JSON.stringify(f)}`,
  );
  // 改回 pi 的值 = 删掉这一项
  await page.getByRole("switch", { name: "自动压缩上下文" }).click();
  await saveNow(page);
  check(
    where,
    fileNow().compaction === undefined && fileNow().other?.keep === true,
    `改回默认值没有删键：${JSON.stringify(fileNow())}`,
  );

  // 文件坏了：界面给原因，其余项照常保存，文件原样
  writeFileSync(settingsFile, "{ not json");
  await page.reload();
  await tab(page, "会话与任务").click();
  await page.getByText(/里有被忽略的项/).waitFor({ timeout: 3000 });
  await radio("保留更多细节").click();
  await bar(page).getByRole("button", { name: "保存" }).click();
  await page
    .getByText(/保存失败：压缩与重试：settings\.json 现在不是合法 JSON/)
    .waitFor({ timeout: 3000 });
  check(
    where,
    readFileSync(settingsFile, "utf8") === "{ not json",
    "坏文件被覆盖了",
  );
  await ctx.close();
}

async function inputTab(browser) {
  const where = "输入与显示";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page);
  await tab(page, "输入与显示").click();

  // 图片压缩：上限默认收起，一句话写明现状
  await page
    .getByText("发送前压到 2000×2000 像素、4608 KiB 以内，JPEG 质量 80")
    .waitFor();
  check(
    where,
    (await page.getByLabel("最大宽度").count()) === 0,
    "上限没有收起",
  );
  await page.getByRole("button", { name: "调整上限" }).click();
  await page.getByLabel("最大宽度").fill("1024");
  await shot(page, "defaults-compress");
  await saveNow(page);
  check(
    where,
    (await defaultsNow()).imageCompression.maxWidth === 1024,
    "压缩参数没落库",
  );

  // 界面字号：拖动即时生效，不出保存条，刷新后仍在
  const before = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--fs-read"),
  );
  await page.getByRole("slider", { name: "基准字号滑块" }).fill("20");
  const after = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--fs-read"),
  );
  check(
    where,
    before !== after && after.trim() === "20px",
    `字号没生效：${after}`,
  );
  check(where, (await bar(page).count()) === 0, "字号改动不该出保存条");
  await shot(page, "defaults-font");
  // 恢复默认：回到 16、按钮置灰
  await page.getByRole("button", { name: "恢复默认" }).click();
  const reset = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--fs-read"),
  );
  check(where, reset.trim() === "16px", `恢复默认后不是 16px：${reset}`);
  check(
    where,
    await page.getByRole("button", { name: "恢复默认" }).isDisabled(),
    "已是默认值，「恢复默认」没置灰",
  );
  await page.getByRole("slider", { name: "基准字号滑块" }).fill("20");
  await page.reload();
  const kept = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--fs-read"),
  );
  check(where, kept.trim() === "20px", `刷新后字号没保留：${kept}`);
  await ctx.close();
}

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) break;
    } catch {}
    await sleep(250);
  }
  await seed();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    await layout(browser);
    await modelsTab(browser);
    await sessionTab(browser);
    await inputTab(browser);
  } finally {
    await browser.close();
  }
} catch (err) {
  problems.push(`脚本异常：${err instanceof Error ? err.message : err}`);
} finally {
  proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

if (problems.length === 0) {
  console.log(`verify-defaults PASS（${checks} 项检查）`);
} else {
  console.log(`verify-defaults FAIL（${problems.length}/${checks}）`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
