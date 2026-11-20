// 供应商页的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，量 jsdom 测不出的几类事。
//  1) 滚动：造 40 个模型 + 14 个自定义端点后，左列表、右详情都能滚到底，窄窗口（上下叠放）也能看到最后一行；
//  2) 显式保存：改了进草稿、不发请求，保存条浮在底部不挤动内容、不跟着滚走；保存才落库；
//     有未保存修改时「测试连接」置灰、换供应商先问；左列表搜索框与页面留白对齐；
//  3) 内置供应商：协议不能探测的那个，添加后「从端点获取」列目录里的模型、挑一个添加，再「删除」回到左侧没有它。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-providers.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "providers-"));
const work = join(base, "work");
mkdirSync(work, { recursive: true });
const port = 17750 + Math.floor(Math.random() * 90);
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
  // 给 deepseek 一个环境凭据：它的状态是已连接，但用户没添加过，不该出现在左侧
  {
    stdio: "ignore",
    cwd: work,
    env: { ...process.env, DEEPSEEK_API_KEY: "sk-env-only-for-check" },
  },
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
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

const ENDPOINT = ["http:/", "127.0.0.1:9/v1"].join("/");

async function seed() {
  const models = Array.from({ length: 40 }, (_, i) => ({
    id: `model-${i}`,
    reasoning: false,
    levels: [],
    input: ["text"],
    ctx: 8000,
    out: 1000,
    source: "manual",
  }));
  await api("POST", "/providers", {
    name: "本地 vLLM",
    slug: "local-vllm",
    api: "openai-completions",
    baseUrl: ENDPOINT,
    models,
  });
  for (let i = 0; i < 14; i++)
    await api("POST", "/providers", {
      name: `端点 ${i}`,
      slug: `ep-${i}`,
      api: "openai-completions",
      baseUrl: ENDPOINT,
    });
}

// 滚动量：一个元素在滚轮之后是不是真的动了、是不是到了底。
const metrics = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el
      ? {
          client: el.clientHeight,
          scroll: el.scrollHeight,
          top: el.scrollTop,
          oy: getComputedStyle(el).overflowY,
        }
      : null;
  }, sel);

const lastRowBottom = (page) =>
  page.evaluate(() => {
    const row = [...document.querySelectorAll("*")].find(
      (e) =>
        e.textContent?.trim().startsWith("最大并发请求数") &&
        e.children.length < 4,
    );
    return row ? Math.round(row.getBoundingClientRect().bottom) : null;
  });

async function openAdvanced(page) {
  const more = page.getByText(/显示其余/);
  if (await more.count()) await more.first().click();
  await page.getByRole("button", { name: "展开高级设置" }).click();
  await sleep(400);
}

async function scrolling(browser) {
  // 宽窗口：左右两栏各自滚
  let ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  let page = await ctx.newPage();
  await page.goto(`${origin}/settings/providers`);
  await page.getByRole("article").waitFor();
  await openAdvanced(page);
  let where = "1280×720";
  const main = await metrics(page, ".st-main");
  check(
    where,
    main?.oy === "hidden" && main.scroll <= main.client + 1,
    `.st-main 自己不该滚：${JSON.stringify(main)}`,
  );
  const detail = await metrics(page, ".st-detail");
  check(
    where,
    !!detail && detail.scroll > detail.client,
    `右详情没有溢出，样本不够长：${JSON.stringify(detail)}`,
  );
  await page.mouse.move(900, 400);
  await page.mouse.wheel(0, 8000);
  await sleep(400);
  const after = await metrics(page, ".st-detail");
  check(
    where,
    !!after && after.top > 0,
    `右详情滚轮后没动：${JSON.stringify(after)}`,
  );
  check(
    where,
    !!after && after.top + after.client >= after.scroll - 1,
    `右详情没滚到底：${JSON.stringify(after)}`,
  );
  const bottom = await lastRowBottom(page);
  check(
    where,
    bottom !== null && bottom <= 720,
    `最后一行（最大并发请求数）在视口之外：${bottom}`,
  );
  const rail = await metrics(page, ".st-rail-list");
  check(
    where,
    !!rail && rail.scroll > rail.client,
    `左列表没有溢出，样本不够长：${JSON.stringify(rail)}`,
  );
  await page.mouse.move(320, 400);
  await page.mouse.wheel(0, 8000);
  await sleep(400);
  const railAfter = await metrics(page, ".st-rail-list");
  check(
    where,
    !!railAfter && railAfter.top > 0,
    `左列表滚轮后没动：${JSON.stringify(railAfter)}`,
  );
  await ctx.close();

  // 窄窗口：上下叠放，滚到底能看见最后一行
  ctx = await browser.newContext({ viewport: { width: 560, height: 800 } });
  page = await ctx.newPage();
  await page.goto(`${origin}/settings/providers`);
  await page.getByRole("article").waitFor();
  await openAdvanced(page);
  where = "560×800";
  await page.mouse.move(280, 600);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 3000);
    await sleep(80);
  }
  await sleep(300);
  const narrow = await lastRowBottom(page);
  check(
    where,
    narrow !== null && narrow <= 800,
    `滚到底后最后一行仍在视口之外：${narrow}`,
  );
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  check(where, !over, "出现横向滚动");
  await ctx.close();
}

async function draftFlow(browser) {
  const where = "显式保存";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 600 },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`页面报错：${e.message}`));
  await page.goto(`${origin}/settings/providers`);
  await page.getByRole("article", { name: "本地 vLLM 详情" }).waitFor();
  const bar = page.getByRole("region", { name: "保存" });
  const saved = async () =>
    (await api("GET", "/providers")).providers.find(
      (p) => p.slug === "local-vllm",
    );

  // 对齐：左列表的搜索框落在页面留白 24
  const main = await page.evaluate(
    () => document.querySelector(".st-main").getBoundingClientRect().left,
  );
  const search = await page.evaluate(
    () =>
      document.querySelector(".st-rail .u-search")?.getBoundingClientRect()
        .left,
  );
  check(
    where,
    search !== undefined && Math.round(search - main) === 24,
    `搜索框离主区 ${Math.round(search - main)}（应为 24）`,
  );

  // 改了进草稿：不发请求；保存条浮在视口底部
  const before = await metrics(page, ".st-detail");
  const next = ENDPOINT.replace("9/v1", "8/v1");
  await page.getByRole("textbox", { name: "Base URL" }).fill(next);
  await bar.waitFor();
  await sleep(400);
  check(where, (await saved()).baseUrl === ENDPOINT, "没点保存就改了服务端");
  const after = await metrics(page, ".st-detail");
  check(
    where,
    after?.client === before?.client,
    `保存条出现时详情高度变了：${before?.client} → ${after?.client}`,
  );
  const box = await bar.boundingBox();
  check(
    where,
    !!box && box.y + box.height <= 600 && box.y > 300,
    `保存条不在视口底部：${JSON.stringify(box)}`,
  );
  await page.mouse.move(900, 300);
  await page.mouse.wheel(0, 9000);
  await sleep(300);
  const box2 = await bar.boundingBox();
  check(where, !!box2 && Math.abs(box2.y - box.y) < 2, "保存条跟着滚走了");

  // 有修改：测试连接置灰；换供应商先问，放弃后没变
  check(
    where,
    await page.getByRole("button", { name: "测试连接" }).isDisabled(),
    "有未保存的修改时「测试连接」没置灰",
  );
  await page
    .getByRole("complementary", { name: "供应商" })
    .getByRole("button", { name: /端点 5/ })
    .first()
    .click();
  const leave = page.getByRole("dialog", { name: "有未保存的修改" });
  await leave.waitFor({ timeout: 3000 });
  await leave.getByRole("button", { name: "放弃修改" }).click();
  await page.getByRole("article", { name: "端点 5 详情" }).waitFor();
  check(where, (await saved()).baseUrl === ENDPOINT, "放弃后服务端还是变了");

  // 回来改一次、保存：落库，保存条消失
  await page
    .getByRole("complementary", { name: "供应商" })
    .getByRole("button", { name: /本地 vLLM/ })
    .first()
    .click();
  await page.getByRole("article", { name: "本地 vLLM 详情" }).waitFor();
  await page.getByRole("textbox", { name: "Base URL" }).fill(next);
  await bar.getByRole("button", { name: "保存" }).click();
  await bar.waitFor({ state: "detached", timeout: 4000 });
  check(where, (await saved()).baseUrl === next, "保存后服务端没变");
  await ctx.close();
}

async function builtinFlow(browser) {
  const where = "内置供应商";
  const { providers } = await api("GET", "/providers");
  const target = providers.find((p) => !p.custom && !p.probeable);
  if (!target)
    return check(
      where,
      false,
      "目录里没有协议不能探测的内置供应商，换一个样本",
    );
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings/providers`);
  await page.getByRole("article").waitFor();
  const rail = page.getByRole("complementary", { name: "供应商" });
  check(
    where,
    (await rail
      .getByRole("button", { name: new RegExp(target.name) })
      .count()) === 0,
    "没配置的内置供应商不该出现在左侧",
  );

  // 添加 → 左侧出现、选中
  await page.getByRole("button", { name: "添加供应商" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("textbox", { name: "搜索内置供应商" }).fill(target.name);
  await dlg
    .getByRole("button", { name: new RegExp(target.name) })
    .first()
    .click();
  await rail
    .getByRole("button", { name: new RegExp(target.name) })
    .first()
    .waitFor({ timeout: 5000 });
  const models = page.getByRole("region", { name: "模型" });
  await models.waitFor();
  const rows = () => models.locator(".pv-model").count();
  check(
    where,
    (await rows()) === 0,
    "刚添加的内置供应商不该带目录里的全部模型",
  );

  // 从端点获取：不能探测，列目录里的模型，不请求端点
  const probed = [];
  page.on(
    "request",
    (r) => r.url().includes("/models/probe") && probed.push(r.url()),
  );
  await models.getByRole("button", { name: "从端点获取" }).click();
  const fetchDlg = page.getByRole("dialog");
  await fetchDlg.getByText(/列的是内置目录/).waitFor({ timeout: 5000 });
  const boxes = fetchDlg.getByRole("checkbox");
  await boxes
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  check(where, (await boxes.count()) > 0, "目录里的模型一个都没列出来");
  await boxes.first().click();
  await fetchDlg.getByRole("button", { name: /^添加所选/ }).click();
  await fetchDlg.waitFor({ state: "detached", timeout: 5000 });
  check(
    where,
    (await rows()) === 1,
    `添加一个后应有 1 个模型，实际 ${await rows()}`,
  );
  check(where, probed.length === 0, "不能探测的供应商不该请求端点");
  const row = models.locator(".pv-model").first();
  check(
    where,
    (await row.getByText("待补全").count()) === 0,
    "目录里的模型应带上规格，不该标待补全",
  );

  // 删除：左侧消失，没有保存的模型
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });
  await sleep(300);
  check(
    where,
    (await rail
      .getByRole("button", { name: new RegExp(target.name) })
      .count()) === 0,
    "删除后仍在左侧",
  );
  const after = (await api("GET", "/providers")).providers.find(
    (p) => p.id === target.id,
  );
  check(
    where,
    after?.models.length === 0,
    `服务端仍留着模型：${after?.models.length}`,
  );
  await ctx.close();
}

async function envCredentialFlow(browser) {
  const where = "环境凭据的内置供应商";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings/providers`);
  await page.getByRole("article").waitFor();
  const rail = page.getByRole("complementary", { name: "供应商" });
  const row = rail.getByRole("button", { name: /DeepSeek/i });
  const seen = (await api("GET", "/providers")).providers.find(
    (p) => p.id === "deepseek",
  );
  check(
    where,
    seen?.status === "ok",
    `样本不成立：环境凭据没让它变成已连接（${seen?.status}）`,
  );
  check(where, seen?.added === false, "只有环境凭据时 added 应为 false");
  check(
    where,
    (await row.count()) === 0,
    "只有环境凭据的内置供应商不该自动出现在左侧",
  );

  await page.getByRole("button", { name: "添加供应商" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("textbox", { name: "搜索内置供应商" }).fill("DeepSeek");
  await dlg
    .getByRole("button", { name: /DeepSeek/i })
    .first()
    .click();
  await row.first().waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });
  await sleep(300);
  check(
    where,
    (await row.count()) === 0,
    "添加后删除，它仍留在左侧（用户看来就是删不掉）",
  );
  await ctx.close();
}

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
  await seed();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    await scrolling(browser);
    await draftFlow(browser);
    await builtinFlow(browser);
    await envCredentialFlow(browser);
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
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

for (const p of problems.slice(0, 40)) console.log(`FAIL  ${p}`);
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = problems.length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 个问题（已检查 ${checks} 处）`
    : `PASS  供应商页：长列表左右栏与窄窗口都能滚到底；显式保存（草稿、保存条贴底、离开保护）；内置供应商添加 → 从目录获取 → 删除、只有环境凭据的不上架，共检查 ${checks} 处`,
);
process.exit(bad ? 1 : 0);
