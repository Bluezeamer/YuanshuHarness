// 真实模型的「界面端到端」：全新数据目录、不用任何旧接口预置，只靠 WebUI 把一个可用的模型配出来并聊天。
// 流程：设置 → 供应商 → 添加自定义端点 → 从端点导入模型 → 设为默认 → 新建会话 → 发消息 → 调工具 → 批准 → 终端附着。
// 模型地址与密钥只从 tmp/model（pi models.json 形状，已被 gitignore）读取，不会打印。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/e2e-ui.mjs [--model <路径>] [--shots <目录>]
import { spawn } from "node:child_process";
import {
  existsSync,
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
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const MODEL_FILE = arg("--model") ?? join(root, "tmp", "model");
const SHOTS = arg("--shots") ? resolve(arg("--shots")) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
if (!existsSync(MODEL_FILE)) {
  console.error(`缺少模型配置：${MODEL_FILE}`);
  process.exit(2);
}
const provider = Object.values(
  JSON.parse(readFileSync(MODEL_FILE, "utf8")).providers,
)[0];
const model = provider.models[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = `UI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "e2e-ui-"));
const work = join(base, "work");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "secret.txt"), `${SECRET}\n`);
const port = 17700 + Math.floor(Math.random() * 90);
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
const api = async (path) => (await fetch(`${origin}/api/v1${path}`)).json();
// 失败时能看到卡在哪一步、当时的页面
let step = "启动";
let current = null;
let lastCreate = null;

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
  // 起点：一个什么都没配的 Server
  check(
    "全新 Server：没有默认模型、没有会话",
    (await api("/default-model")).default === null &&
      (await api("/sessions")).sessions.length === 0,
  );

  const browser = await chromium.launch({ channel: "chromium" });
  const shot = async (page, name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    current = page;
    // 失败时回看界面实际发给服务端的创建会话请求（只含配置，不含密钥）
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/v1/sessions"))
        lastCreate = r.postData();
    });
    await page.goto(`${origin}/settings/providers`);

    step = "1 添加自定义端点";
    // 1) 添加自定义端点（名称、标识、协议、Base URL、Key）
    await page.getByRole("button", { name: "添加自定义端点" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("名称").fill("e2e 端点");
    await dlg.getByLabel("标识").fill("e2e-ui");
    await dlg.getByLabel("请求协议").selectOption(provider.api);
    await dlg.getByLabel("Base URL").fill(provider.baseUrl);
    if (provider.apiKey) await dlg.getByLabel("API Key").fill(provider.apiKey);
    await dlg.getByRole("button", { name: "保存端点" }).click();
    await page.getByRole("heading", { name: "e2e 端点" }).waitFor();
    const list = (await api("/providers")).providers;
    check(
      "界面添加自定义端点成功，服务端已登记",
      list.some((p) => p.custom && p.slug === "e2e-ui"),
    );
    await shot(page, "1-provider");

    step = "2 从端点导入模型";
    // 2) 从端点导入模型（真实 /models 列表）
    await page.getByRole("button", { name: "添加模型" }).click();
    await page.getByRole("button", { name: "获取模型列表" }).click();
    const row = page.getByRole("checkbox", { name: model.id }).first();
    await row.waitFor({ timeout: 20_000 });
    await row.click();
    await page.getByRole("button", { name: /导入已选/ }).click();
    // 只导入一个模型时会自动展开，按钮文案是「收起」
    await page
      .getByRole("button", { name: new RegExp(`(展开|收起) ${model.id}`) })
      .waitFor();
    const mine = (await api("/providers")).providers.find(
      (p) => p.slug === "e2e-ui",
    );
    check(
      "从端点导入模型：真实端点返回了目标模型 id",
      mine.models.some((m) => m.id === model.id),
    );

    step = "3 默认模型";
    // 3) 默认模型：第一次配好就应有默认；模型库只读地标出它，更改在「默认值设置」页
    const auto = (await api("/default-model")).default;
    check(
      "第一个模型自动成为全局默认",
      auto?.provider === mine.id && auto?.model === model.id,
    );
    await page.getByRole("tab", { name: /模型库/ }).click();
    await page.getByText("默认模型在「默认值设置」里更改。").waitFor();
    // 默认值是异步重读的：等「默认」标记出现，而不是读一次
    const marked = await page
      // 目录里别家也有同名模型：按「供应商列是 e2e-ui」且含模型 id 取我配的那一行
      .locator(".st-lib tbody tr", { hasText: "e2e-ui" })
      .filter({ hasText: model.id })
      .first()
      .getByText("默认", { exact: true })
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    check("模型库该行标「默认」（只读）", marked);
    await shot(page, "2-library");

    // 「默认值设置」页：默认模型显示的是它；目录起点可改，服务端已存
    await page.goto(`${origin}/settings/defaults`);
    await page
      .getByRole("heading", { name: "默认值设置" })
      .first()
      .waitFor({ timeout: 10_000 });
    const picked = await page
      .locator("select")
      .evaluateAll((els) =>
        els.map((el) => el.selectedOptions[0]?.textContent ?? ""),
      );
    check(
      "「默认值设置」页的默认模型选的是它",
      picked.some(
        (t) => t.includes(model.name ?? model.id) || t.includes(model.id),
      ),
      JSON.stringify(picked),
    );
    const start = page.getByRole("textbox", { name: "起点路径" });
    await start.fill("/tmp");
    await start.press("Enter");
    await sleep(800);
    check(
      "改目录起点：服务端已存",
      (await api("/defaults")).directoryStart === "/tmp",
    );
    await start.fill("~");
    await start.press("Enter");
    await sleep(800);
    check(
      "改回 ~：服务端已存",
      (await api("/defaults")).directoryStart === "~",
    );
    await shot(page, "2b-defaults");

    step = "4 新建会话";
    // 4) 新建工作区（建好自动开一个新对话），不预置任何旧登记
    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(work);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    // 建好工作区会自动开一个新对话，标题是「新对话」
    await page.getByRole("heading", { level: 2, name: "新对话" }).waitFor();
    check(
      "界面创建会话成功并被选中",
      (await api("/sessions")).sessions.length === 1,
    );

    step = "5 发消息";
    // 5) 发消息：真实模型回复
    const box = page.locator("textarea").first();
    await box.fill("用一句话回答：2+3 等于几？");
    await box.press("Enter");
    // 以审计里出现 ≥1 次真实模型调用为准（不能靠匹配回复文字：报错文案里也有数字）
    await page
      .getByRole("button", { name: /^审计 [1-9]/ })
      .waitFor({ timeout: 120_000 });
    check("真实模型回复了第一轮（模型来自界面里配置的供应商）", true);
    await shot(page, "3-chat");

    step = "6 工具调用与审批";
    // 6) 工具调用 + 人工审批：批准后继续
    await box.fill(
      `请用 bash 工具执行 \`touch approved.txt && cat secret.txt\`，然后把 secret.txt 的内容告诉我。`,
    );
    await box.press("Enter");
    await page
      .getByRole("button", { name: "批准" })
      .first()
      .click({ timeout: 120_000 });
    await page.getByText(SECRET).last().waitFor({ timeout: 120_000 });
    check("工具调用经人工审批后执行，结果回到对话", true);
    await shot(page, "4-approved");

    step = "7 审计";
    // 7) 审计里能看到这几次模型请求，并带调用数
    // run.ended 之后才重取用量，所以等计数到位而不是读一次：3 次 = 首轮 1 次 + 工具轮 2 次（调工具、总结）
    const audit = page.getByRole("button", { name: /^审计/ });
    await page
      .getByRole("button", { name: /^审计 [3-9]/ })
      .waitFor({ timeout: 60_000 });
    const n = Number((await audit.textContent()).replace(/\D/g, ""));
    check("窗格头的「审计 N」带调用数（≥3 次模型请求）", n >= 3, `${n} 次`);
    await audit.click();
    await page
      .getByText(/调用 \d+/)
      .first()
      .waitFor({ timeout: 20_000 });
    await shot(page, "5-audit");

    step = "8 终端";
    // 8) 终端：新建标签页 → 终端，附着后能读到同一份文件
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await page.getByRole("button", { name: "新建标签页" }).last().click();
    await page.getByRole("menuitem", { name: "终端" }).click();
    await page
      .locator(".xterm-helper-textarea")
      .first()
      .waitFor({ timeout: 20_000 });
    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("cat secret.txt && ls approved.txt");
    await page.keyboard.press("Enter");
    await page
      .locator(".ws-term")
      .getByText(SECRET)
      .first()
      .waitFor({ timeout: 20_000 });
    // 窗格里可能还有预置的、从没打开过的终端标签；后面要切回的是这一个，不能按「第一个终端标签」去找
    const firstTid = await page
      .locator(".ws-term")
      .first()
      .evaluate((el) => el.closest("[data-tid]")?.getAttribute("data-tid"));
    check("终端附着：读到暗号并看到 bash 工具创建的文件", Boolean(firstTid));
    await shot(page, "6-terminal");

    // 同一窗格再开第二个终端：服务端应当真的多出一个终端，而且两个标签各是各的 shell
    step = "9 同窗格多开终端";
    const termsBefore = (await api("/terminals")).terminals.length;
    await page.getByRole("button", { name: "新建标签页" }).last().click();
    await page.getByRole("menuitem", { name: "终端" }).click();
    await sleep(2500);
    const termsAfter = (await api("/terminals")).terminals;
    check(
      "同窗格第二个终端：服务端多出一个终端（不是复用第一个）",
      termsAfter.length === termsBefore + 1,
      `${termsBefore} → ${termsAfter.length}`,
    );
    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("echo second-term-$((6*7))");
    await page.keyboard.press("Enter");
    await page
      .locator(".ws-term")
      .getByText("second-term-42")
      .first()
      .waitFor({ timeout: 20_000 });
    // 切回第一个终端：它里面不该出现第二个终端的输出
    await page
      .locator(`.ws-pn-tab[data-tid="${firstTid}"] [role="tab"]`)
      .click();
    await sleep(800);
    const firstText = await page.locator(".ws-term").first().innerText();
    const leaked = firstText.includes("second-term-42");
    const keepsOwn = firstText.includes(SECRET);
    check(
      "两个终端各是各的 shell：第一个里没有第二个的输出，但仍有自己的",
      !leaked && keepsOwn,
      `混入第二个的输出=${leaked}，保留自己的输出=${keepsOwn}`,
    );
    // 切回第一个只是重新接回，不能顺手再建终端
    check(
      "切回第一个终端：服务端终端数不变（接回而不是新建）",
      (await api("/terminals")).terminals.length === termsAfter.length,
    );
    await shot(page, "7-two-terminals");
  } catch (e) {
    console.log(
      `      default-model：${JSON.stringify(await api("/default-model").catch(() => null))}`,
    );
    if (lastCreate)
      console.log(`      POST /sessions 请求体：${lastCreate.slice(0, 600)}`);
    if (current && SHOTS)
      await current
        .screenshot({ path: join(SHOTS, "failed.png") })
        .catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  check(`步骤「${step}」未完成`, false, String(e.message).split("\n")[0]);
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
