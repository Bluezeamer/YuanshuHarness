// 「远程连接」页的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，量 jsdom 测不出的事。
//  1) 对齐：页签文字、左列表搜索框、密钥页与日志页的内容左缘在 1440 / 1920 宽下都落在页面留白 24；
//  2) 滚动：30 条连接时左列表自己滚，详情自己滚，页面不溢出；保存条浮在底部、出现时不挤动编辑区、不随滚动走；
//  3) 草稿：改了不发请求，点保存才真的落库；改了没保存时切换连接要先问；
//  4) 激活：连不上的主机停在「TCP 连接」并给出错误码，状态点变「激活失败」；跳板没激活不发请求；
//  5) 悬停卡片、删除守卫（被当跳板的连接删不了）、删除真的删掉；
//  6) 密钥页：导入、行菜单、被引用的删不了；日志页看得到刚才的失败。
// 连接都指向本机关着的端口，所以激活只会失败，不会真去连外面的机器。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs），以及 ssh-keygen。
// 用法：node scripts/verify-remote.mjs
import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (shots) mkdirSync(shots, { recursive: true });

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "remote-"));
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
const connOf = async (label) =>
  (await api("GET", "/connections")).connections.find((c) => c.label === label);

const ids = {};

async function seed() {
  execSync(`ssh-keygen -q -t ed25519 -N "" -C verify -f ${join(base, "id")}`);
  const pem = readFileSync(join(base, "id"), "utf8");
  ids.key = (
    await api("POST", "/secrets", {
      name: "ci-key",
      kind: "ssh_key",
      value: pem,
    })
  ).id;
  ids.pw = (
    await api("POST", "/secrets", {
      name: "box-pw",
      kind: "password",
      value: "x",
    })
  ).id;
  const make = (label, host, auth, extra = {}) =>
    api("POST", "/connections", {
      label,
      host,
      port: 1,
      user: "ops",
      auth,
      ...extra,
    });
  // 连不上的跳板；gpu-box 经它跳转（激活它会先被「跳板没激活」拦住）
  ids.bastion = (
    await make("bastion", "127.0.0.1", { secretId: ids.key, kind: "key" })
  ).id;
  ids.gpu = (
    await make(
      "gpu-box",
      "10.0.0.8",
      { secretId: ids.pw, kind: "password" },
      {
        jump: [ids.bastion],
      },
    )
  ).id;
  for (let i = 0; i < 30; i++)
    await make(`node-${String(i).padStart(2, "0")}`, `10.1.0.${i + 1}`, {
      secretId: ids.key,
      kind: "key",
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

const atBottom = (m) => !!m && m.top > 0 && m.top + m.client >= m.scroll - 1;

const open = async (page, path = "/settings/remote") => {
  page.on("pageerror", (e) => problems.push(`页面报错：${e.message}`));
  await page.goto(`${origin}${path}`);
  try {
    await page
      .getByRole("tab", { name: /^连接\s*\d/ })
      .waitFor({ timeout: 8000 });
  } catch (err) {
    await shot(page, "open-failed");
    throw err;
  }
  await page.getByRole("complementary", { name: "连接" }).waitFor();
  await sleep(500);
};
const row = (page, label) =>
  page.locator(".u-lrow-label", { hasText: new RegExp(`^${label}$`) });
const pick = async (page, label) => {
  await row(page, label).click();
  await page
    .getByRole("article", { name: `${label} 详情` })
    .waitFor({ timeout: 4000 });
};
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

async function alignment(browser) {
  for (const [w, h] of [
    [1440, 900],
    [1920, 1000],
  ]) {
    const where = `${w}px 对齐`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await open(page);
    const main = await left(page, ".st-main");
    const tab = await left(page, ".st-main [role=tab]");
    const search = await left(page, ".st-rail .u-search");
    check(where, tab - main === 24, `页签文字离主区 ${tab - main}（应为 24）`);
    check(
      where,
      search - main === 24,
      `搜索框离主区 ${search - main}（应为 24）`,
    );
    check(
      where,
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )),
      "出现横向滚动",
    );
    await page.getByRole("tab", { name: /^密钥/ }).click();
    await page.getByRole("button", { name: "导入私钥" }).waitFor();
    const bar = await left(page, ".st-rc-bar");
    check(
      where,
      bar - main === 24,
      `密钥页内容离主区 ${bar - main}（应为 24）`,
    );
    await page.getByRole("tab", { name: /^连接日志/ }).click();
    await page.locator(".st-rc-chips").waitFor();
    const chips = await left(page, ".st-rc-chips");
    check(
      where,
      chips - main === 24,
      `日志页内容离主区 ${chips - main}（应为 24）`,
    );
    await ctx.close();
  }
}

async function scrolling(browser) {
  const where = "滚动与保存条";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const page = await ctx.newPage();
  await open(page);
  const main = await metrics(page, ".st-main");
  check(
    where,
    !!main && main.scroll <= main.client + 1,
    `.st-main 自己不该滚：${JSON.stringify(main)}`,
  );
  const railM = await metrics(page, ".st-rail-list");
  check(
    where,
    !!railM && railM.scroll > railM.client,
    `左列表没有溢出：${JSON.stringify(railM)}`,
  );
  await page.mouse.move(380, 400);
  await page.mouse.wheel(0, 9000);
  await sleep(300);
  check(
    where,
    atBottom(await metrics(page, ".st-rail-list")),
    "左列表没滚到底",
  );

  await pick(page, "node-29");
  const detail = await metrics(page, ".st-detail");
  check(
    where,
    !!detail && detail.scroll > detail.client,
    `详情没有溢出：${JSON.stringify(detail)}`,
  );
  const hBefore = detail?.client;
  await page.getByRole("textbox", { name: "端口" }).fill("2222");
  const bar = page.getByRole("region", { name: "保存" });
  await bar.waitFor();
  await sleep(500);
  const hAfter = (await metrics(page, ".st-detail"))?.client;
  check(
    where,
    hBefore === hAfter,
    `保存条出现时详情区高度变了：${hBefore} → ${hAfter}`,
  );
  const box = await bar.boundingBox();
  check(
    where,
    !!box && box.y + box.height <= 640 && box.y > 400,
    `保存条不在视口底部：${JSON.stringify(box)}`,
  );
  await page.mouse.move(800, 300);
  await page.mouse.wheel(0, 9000);
  await sleep(300);
  check(where, atBottom(await metrics(page, ".st-detail")), "详情没滚到底");
  const box2 = await bar.boundingBox();
  check(where, !!box2 && Math.abs(box2.y - box.y) < 2, "保存条跟着滚走了");
  await ctx.close();
}

async function draft(browser) {
  const where = "草稿与保存";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page);
  await pick(page, "node-00");
  const port = page.getByRole("textbox", { name: "端口" });
  await port.fill("2222");
  await sleep(400);
  check(where, (await connOf("node-00")).port === 1, "没点保存就改了服务端");
  await shot(page, "draft-dirty");
  // 改了没保存：切换连接先问；放弃后切过去，服务端没变
  await row(page, "node-01").click();
  const leave = page.getByRole("dialog", { name: "有未保存的修改" });
  await leave.waitFor({ timeout: 3000 });
  await shot(page, "leave-guard");
  await leave.getByRole("button", { name: "放弃修改" }).click();
  await page.getByRole("article", { name: "node-01 详情" }).waitFor();
  check(where, (await connOf("node-00")).port === 1, "放弃后服务端还是变了");
  // 改了再保存：服务端才真的变
  await pick(page, "node-00");
  await port.fill("2222");
  await page
    .getByRole("region", { name: "保存" })
    .getByRole("button", { name: "保存" })
    .click();
  await page.getByText("已保存").first().waitFor({ timeout: 4000 });
  check(where, (await connOf("node-00")).port === 2222, "保存后服务端没变");
  check(
    where,
    (await page.getByRole("region", { name: "保存" }).count()) === 0,
    "保存后保存条还在",
  );
  // 校验：端口越界时保存被拦
  await port.fill("70000");
  await page
    .getByRole("region", { name: "保存" })
    .getByRole("button", { name: "保存" })
    .click();
  await page
    .getByText(/保存失败：端口/)
    .first()
    .waitFor({ timeout: 3000 });
  check(where, (await connOf("node-00")).port === 2222, "越界的端口被存了");
  await ctx.close();
}

async function activation(browser) {
  const where = "激活";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page);
  // 跳板没激活：不发请求，直接提示
  await pick(page, "gpu-box");
  await page.getByRole("button", { name: "激活", exact: true }).click();
  await page.getByText(/先激活跳板机/).waitFor({ timeout: 3000 });
  check(
    where,
    (await connOf("gpu-box")).status === "inactive",
    "跳板没激活却发起了激活",
  );
  // 连不上的主机：停在 TCP 连接
  await pick(page, "bastion");
  await page.getByRole("button", { name: "激活", exact: true }).click();
  await page.getByRole("list", { name: "激活步骤" }).waitFor({ timeout: 5000 });
  await page.getByText(/TCP 连接失败/).waitFor({ timeout: 15000 });
  await sleep(300);
  await shot(page, "activation-failed");
  const text = await page.getByRole("article").textContent();
  check(where, /tcp_refused|拒绝/.test(text ?? ""), "没有给出错误码或原因");
  check(
    where,
    (await page
      .locator(".st-rail")
      .getByRole("img", { name: "激活失败" })
      .count()) === 1,
    "左列表的状态点没变成「激活失败」",
  );
  check(
    where,
    !(await page
      .getByRole("button", { name: "激活", exact: true })
      .isDisabled()),
    "失败后「激活」不能重试",
  );
  // 日志页看得到这次失败
  await page.getByRole("tab", { name: /^连接日志/ }).click();
  await page
    .getByRole("table", { name: "连接日志" })
    .waitFor({ timeout: 4000 });
  check(
    where,
    (
      (await page.getByRole("table", { name: "连接日志" }).textContent()) ?? ""
    ).includes("bastion"),
    "日志里没有 bastion 的失败记录",
  );
  await shot(page, "log");
  await ctx.close();
}

async function peekAndDelete(browser) {
  const where = "悬停卡片与删除";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page);
  await row(page, "gpu-box").hover();
  const tip = page.getByRole("tooltip");
  await tip.waitFor({ timeout: 3000 });
  const tipText = (await tip.textContent()) ?? "";
  check(
    where,
    tipText.includes("bastion") && tipText.includes("密码"),
    `卡片内容不对：${tipText}`,
  );
  await shot(page, "peek");
  await page.mouse.move(900, 400);

  // 被当跳板的连接：菜单项置灰并写明
  await pick(page, "bastion");
  await page.getByRole("button", { name: "更多操作" }).click();
  const blocked = page.getByRole("menuitem", { name: /^删除连接/ });
  check(where, await blocked.isDisabled(), "被当跳板的连接竟然能删");
  check(
    where,
    ((await blocked.textContent()) ?? "").includes("当跳板"),
    "没写明原因",
  );
  await shot(page, "menu-blocked");
  await page.keyboard.press("Escape");

  // 普通连接：确认后真的删掉
  await pick(page, "node-05");
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "删除连接" }).click();
  const dlg = page.getByRole("dialog", { name: "删除「node-05」" });
  await dlg.waitFor({ timeout: 3000 });
  await shot(page, "delete-dialog");
  await dlg.getByRole("button", { name: "删除" }).click();
  await dlg.waitFor({ state: "detached", timeout: 4000 });
  check(where, !(await connOf("node-05")), "删除后服务端还有这条连接");
  check(
    where,
    (await row(page, "node-05").count()) === 0,
    "删除后左列表还有这一行",
  );
  await ctx.close();
}

async function keysAndNew(browser) {
  const where = "密钥与新建";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page);
  // 新建：必填没填完按钮置灰；「仅创建」不激活
  await page.getByRole("button", { name: "新建连接" }).click();
  const dlg = page.getByRole("dialog", { name: "新建连接" });
  await dlg.waitFor();
  check(
    where,
    await dlg.getByRole("button", { name: "创建并激活" }).isDisabled(),
    "没填完竟然能提交",
  );
  await dlg.getByLabel("名称").fill("fresh-box");
  await dlg.getByLabel("主机").fill("10.9.9.9");
  await dlg.getByLabel("登录用户").fill("root");
  await dlg.getByRole("combobox", { name: "私钥" }).click();
  await page.getByRole("option", { name: "ci-key" }).click();
  await shot(page, "new-dialog");
  await dlg.getByRole("button", { name: "仅创建" }).click();
  await page
    .getByRole("article", { name: "fresh-box 详情" })
    .waitFor({ timeout: 4000 });
  const made = await connOf("fresh-box");
  check(where, !!made && made.status === "inactive", "「仅创建」不该激活");

  // 密钥页：被引用的删不了
  await page.getByRole("tab", { name: /^密钥/ }).click();
  await page.getByRole("table", { name: "密钥" }).waitFor();
  await page.getByRole("button", { name: "ci-key 的操作" }).click();
  const del = page.getByRole("menuitem", { name: /^删除密钥/ });
  check(where, await del.isDisabled(), "被连接引用的密钥竟然能删");
  await shot(page, "keys-menu");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "导入私钥" }).click();
  const imp = page.getByRole("dialog", { name: "导入私钥" });
  await imp.waitFor();
  check(
    where,
    await imp.getByRole("button", { name: "导入并保存" }).isDisabled(),
    "没填完竟然能导入",
  );
  await shot(page, "import-dialog");
  await ctx.close();
}

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${origin}/api/v1/health`)).ok) break;
    } catch {}
    await sleep(250);
  }
  await seed();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    await alignment(browser);
    await scrolling(browser);
    await draft(browser);
    await activation(browser);
    await peekAndDelete(browser);
    await keysAndNew(browser);
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
  console.log(`verify-remote PASS（${checks} 项检查）`);
} else {
  console.log(`verify-remote FAIL（${problems.length}/${checks}）`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
