// 隐私变量页与「编辑工作区 · 隐私变量」的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，量 jsdom 测不出的事。
//  1) 对齐：页签文字、左列表搜索框在 1440 / 1920 宽下落在同一个 x（页面留白 24）；
//  2) 滚动：30 个变量时左列表、右详情各自能滚到底，页面本身不溢出；
//  3) 悬停卡片：停留后浮出、只读不接鼠标、离开收起；
//  4) 保存：改了出保存条，保存成功后服务端真的变了；失败时弹提示并保留草稿；
//  5) 离开保护：有未保存的修改时，切换变量、点设置导航都先问；
//  6) 启用关系：在变量详情里勾工作区、在「编辑工作区」里按组勾选，服务端清单都对。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-variables.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "variables-"));
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
  { stdio: "ignore", cwd: work },
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

const ids = {};

async function seed() {
  for (const name of ["元枢", "官网", "笔记"]) {
    const dir = join(base, `ws-${name}`);
    mkdirSync(dir, { recursive: true });
    const w = await api("POST", "/workspaces", {
      directories: [{ path: dir }],
      name,
    });
    ids[name] = w.id;
  }
  const make = (name, desc, group) =>
    api("POST", "/variables", {
      name,
      desc,
      kind: "text",
      value: `secret-value-${name}`,
      policy: "ask",
      expiry: { kind: "days", days: 30 },
      ...(group ? { group } : {}),
    });
  ids.gitlab = (
    await make("gitlab_token", "GitLab 令牌：克隆和推送私有仓库。", "Git 权限")
  ).id;
  ids.github = (
    await make("github_token", "GitHub 令牌：推送开源仓库。", "Git 权限")
  ).id;
  ids.deploy = (await make("deploy_key", "部署机的 SSH 私钥。", "Git 权限")).id;
  ids.aws = (await make("aws_access_key", "AWS 访问密钥。", "云服务")).id;
  for (let i = 0; i < 26; i++)
    await make(
      `filler_token_${String(i).padStart(2, "0")}`,
      `凑数的变量 ${i}`,
      i % 2 ? "凑数" : null,
    );
}

const left = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? Math.round(el.getBoundingClientRect().left) : null;
  }, sel);

async function alignment(browser) {
  for (const [w, h] of [
    [1440, 900],
    [1920, 1000],
  ]) {
    const where = `${w}px 对齐`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(`${origin}/settings/variables`);
    await page.getByRole("tab", { name: "变量" }).waitFor();
    await page.getByRole("complementary", { name: "变量" }).waitFor();
    await sleep(500);
    const main = await left(page, ".st-main");
    const tab = await left(page, ".st-main [role=tab]");
    const search = await left(page, ".st-rail .u-search");
    check(
      where,
      tab - main === 24,
      `页签文字离主区左缘 ${tab - main}（应为 24）`,
    );
    check(
      where,
      search - main === 24,
      `搜索框离主区左缘 ${search - main}（应为 24）`,
    );
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    check(where, !over, "出现横向滚动");
    // 外壳没有顶栏、没有外框
    const shell = await page.evaluate(() => ({
      header: !!document.querySelector(".st-head, .st-sheet"),
      status: /全部更改已保存/.test(document.body.textContent ?? ""),
    }));
    check(
      where,
      !shell.header && !shell.status,
      `外壳里还有旧的顶栏或保存态：${JSON.stringify(shell)}`,
    );
    await ctx.close();
  }
}

const metrics = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el
      ? { client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop }
      : null;
  }, sel);

async function scrolling(browser) {
  const where = "滚动";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings/variables`);
  await page.getByRole("complementary", { name: "变量" }).waitFor();
  await sleep(500);
  const main = await metrics(page, ".st-main");
  check(
    where,
    !!main && main.scroll <= main.client + 1,
    `.st-main 自己不该滚：${JSON.stringify(main)}`,
  );
  const rail = await metrics(page, ".st-rail-list");
  check(
    where,
    !!rail && rail.scroll > rail.client,
    `左列表没有溢出，样本不够长：${JSON.stringify(rail)}`,
  );
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 9000);
  await sleep(400);
  const railAfter = await metrics(page, ".st-rail-list");
  check(
    where,
    !!railAfter &&
      railAfter.top > 0 &&
      railAfter.top + railAfter.client >= railAfter.scroll - 1,
    `左列表没滚到底：${JSON.stringify(railAfter)}`,
  );
  const detail = await metrics(page, ".st-detail");
  check(
    where,
    !!detail && detail.scroll > detail.client,
    `右详情没有溢出：${JSON.stringify(detail)}`,
  );
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, 9000);
  await sleep(400);
  const detailAfter = await metrics(page, ".st-detail");
  check(
    where,
    !!detailAfter &&
      detailAfter.top > 0 &&
      detailAfter.top + detailAfter.client >= detailAfter.scroll - 1,
    `右详情没滚到底：${JSON.stringify(detailAfter)}`,
  );
  await ctx.close();
}

async function hoverCard(browser) {
  const where = "悬停卡片";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings/variables`);
  await page.getByRole("complementary", { name: "变量" }).waitFor();
  const row = page
    .locator(".st-rail .u-lrow-label", { hasText: "gitlab_token" })
    .first();
  await row.waitFor();
  await row.hover();
  check(
    where,
    (await page.getByRole("tooltip").count()) === 0,
    "刚悬停就弹了（应有停留延迟）",
  );
  await sleep(700);
  const card = page.getByRole("tooltip");
  check(where, (await card.count()) === 1, "停留后没有浮出卡片");
  const text = (await card.textContent().catch(() => "")) ?? "";
  check(
    where,
    text.includes("GitLab 令牌：克隆和推送私有仓库。") &&
      text.includes("Git 权限"),
    `卡片内容不对：${text}`,
  );
  const pe = await card
    .evaluate((e) => getComputedStyle(e).pointerEvents)
    .catch(() => "");
  check(where, pe === "none", `卡片会接鼠标事件：${pe}`);
  await page.mouse.move(900, 600);
  await sleep(200);
  check(
    where,
    (await page.getByRole("tooltip").count()) === 0,
    "移开后卡片没收起",
  );
  // 点「⋯」后不弹卡片盖住菜单
  await row.hover();
  await page.getByRole("button", { name: "gitlab_token 的操作" }).click();
  await sleep(700);
  check(
    where,
    (await page.getByRole("tooltip").count()) === 0,
    "点开「⋯」菜单后卡片又弹出来了",
  );
  await ctx.close();
}

async function saving(browser) {
  const where = "保存";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings/variables`);
  await page.getByRole("complementary", { name: "变量" }).waitFor();
  await page
    .locator(".st-rail .u-lrow-label", { hasText: "github_token" })
    .first()
    .click();
  const desc = page.getByRole("textbox", { name: "描述", exact: true });
  await desc.waitFor();
  check(
    where,
    (await page.getByRole("region", { name: "保存" }).count()) === 0,
    "没改就出了保存条",
  );
  await desc.fill("GitHub 令牌（改过）");
  await page.getByRole("region", { name: "保存" }).waitFor({ timeout: 3000 });

  // 失败：拦下 PATCH，提示弹出、草稿与保存条都留着
  await page.route("**/api/v1/variables/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, body: "{}" })
      : route.continue(),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .locator(".u-toast", { hasText: "保存失败" })
    .waitFor({ timeout: 4000 });
  check(
    where,
    (await desc.inputValue()) === "GitHub 令牌（改过）",
    "失败后草稿丢了",
  );
  check(
    where,
    (await page.getByRole("region", { name: "保存" }).count()) === 1,
    "失败后保存条消失了",
  );
  await page.unroute("**/api/v1/variables/*");

  // 成功：服务端真的变了
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .locator(".u-toast", { hasText: "已保存" })
    .waitFor({ timeout: 4000 });
  await page
    .getByRole("region", { name: "保存" })
    .waitFor({ state: "detached", timeout: 3000 });
  const { variables } = await api("GET", "/variables");
  check(
    where,
    variables.find((v) => v.id === ids.github)?.desc === "GitHub 令牌（改过）",
    "保存后服务端的描述没变",
  );

  // 离开保护：切换变量、点设置导航
  await desc.fill("又改了一次");
  await page
    .locator(".st-rail .u-lrow-label", { hasText: "deploy_key" })
    .first()
    .click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor({ timeout: 3000 });
  check(
    where,
    /有未保存的修改/.test((await dlg.textContent()) ?? ""),
    "切换变量没有先问",
  );
  await dlg.getByRole("button", { name: "取消" }).click();
  check(where, (await desc.inputValue()) === "又改了一次", "取消后草稿丢了");
  await page.getByRole("link", { name: "远程连接" }).click();
  await dlg.waitFor({ timeout: 3000 });
  check(
    where,
    new URL(page.url()).pathname === "/settings/variables",
    "点设置导航没有先问就走了",
  );
  await dlg.getByRole("button", { name: "放弃修改" }).click();
  await page.waitForURL("**/settings/remote");
  await ctx.close();
}

async function enabling(browser) {
  const where = "启用关系";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  // 在变量详情里勾工作区
  await page.goto(`${origin}/settings/variables`);
  await page.getByRole("complementary", { name: "变量" }).waitFor();
  await page
    .locator(".st-rail .u-lrow-label", { hasText: "aws_access_key" })
    .first()
    .click();
  await page.getByRole("checkbox", { name: /官网/ }).click();
  await page.getByRole("checkbox", { name: /笔记/ }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .locator(".u-toast", { hasText: "已保存" })
    .waitFor({ timeout: 4000 });
  let v = (await api("GET", "/variables")).variables.find(
    (x) => x.id === ids.aws,
  );
  check(
    where,
    JSON.stringify(v?.workspaces) ===
      JSON.stringify([ids["官网"], ids["笔记"]].sort()),
    `变量详情里勾选后服务端是 ${JSON.stringify(v?.workspaces)}`,
  );

  // 在「编辑工作区」里按组勾选
  await page.goto(`${origin}/`);
  await page.getByRole("button", { name: "工作区菜单" }).first().waitFor();
  const target = (await api("GET", "/workspaces")).workspaces.find(
    (w) => w.id === ids["元枢"],
  );
  const block = page.locator(".rl-ws", { hasText: target.name }).first();
  await block.hover();
  await block.getByRole("button", { name: "工作区菜单" }).click();
  await page.getByRole("menuitem", { name: /编辑工作区/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: /^隐私变量/ }).click();
  await dlg.getByRole("checkbox", { name: /^Git 权限/ }).click();
  const n = await dlg.getByText(/已启用 \d+ \/ \d+/).textContent();
  check(where, /已启用 3 \//.test(n ?? ""), `勾组后计数是 ${n}（应为 3）`);
  await dlg.getByRole("button", { name: "完成" }).click();
  await dlg.getByRole("button", { name: "保存", exact: true }).click();
  await dlg.waitFor({ state: "detached", timeout: 5000 });
  const enabled = (await api("GET", `/workspaces/${ids["元枢"]}/variables`))
    .variables;
  check(
    where,
    JSON.stringify(enabled) ===
      JSON.stringify([ids.gitlab, ids.github, ids.deploy].sort()),
    `编辑工作区里勾组后服务端是 ${JSON.stringify(enabled)}`,
  );
  v = (await api("GET", "/variables")).variables.find(
    (x) => x.id === ids.gitlab,
  );
  check(
    where,
    v?.workspaces.includes(ids["元枢"]),
    "变量视图里没反映出工作区启用了它",
  );
  await ctx.close();
}

let crashed = null;
try {
  for (let i = 0; i < 600; i++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) break;
    } catch {}
    await sleep(100);
  }
  await seed();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    await alignment(browser);
    await scrolling(browser);
    await hoverCard(browser);
    await saving(browser);
    await enabling(browser);
  } finally {
    await browser.close();
  }
} catch (e) {
  crashed = e;
} finally {
  proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

if (crashed) {
  console.error(`verify-variables 崩了：${crashed?.stack ?? crashed}`);
  process.exit(2);
}
if (problems.length) {
  console.error(
    `verify-variables 发现 ${problems.length} 处问题（共检查 ${checks} 项）：`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`verify-variables PASS（${checks} 项检查）`);
