// pi 扩展在会话里的真机检查：真 Server（临时数据目录与临时 HOME）+ 本地目录当包 + 假模型 + 无头 Chromium。
//  1) 包登记在临时 HOME 的 settings.json 里，开关默认全关；打开后新会话里它注册的工具默认启用、调用时走审批；
//  2) 批准后插件在 execute 里 ctx.ui.notify → 浏览器右下角弹出 toast；通知文本不进对话流。
// 这一条测的是整条链路（白名单放开 → 状态映射 → 审批 → rpc 模式 UI 通道 → extension.ui 事件 → toast），单测拆开测不出接缝。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-plugins.mjs   （SHOTS=目录 顺带存截图）
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "./lib/fake-model.mjs";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "plugins-"));
const home = join(base, "home");
const work = join(base, "work");
const pkg = join(base, "pkg");
for (const d of [home, work, pkg]) mkdirSync(d, { recursive: true });

// 最小的包：一个扩展，注册 hello_plugin，执行时发一条 notify
writeFileSync(
  join(pkg, "package.json"),
  JSON.stringify({
    name: "hello-pkg",
    version: "0.0.1",
    pi: { extensions: ["./index.ts"] },
  }),
);
writeFileSync(
  join(pkg, "index.ts"),
  [
    "const activate = (pi) => {",
    "  pi.registerTool({",
    '    name: "hello_plugin", label: "hello_plugin", description: "示例", parameters: { type: "object", properties: {} },',
    "    async execute(_id, _p, _s, _u, ctx) {",
    '      ctx.ui.notify("来自插件的提示", "warning");',
    '      return { content: [{ type: "text", text: "ok" }], details: {} };',
    "    },",
    "  });",
    "};",
    "export default activate;",
    "",
  ].join("\n"),
);
// 登记包：直接写临时 HOME 的 settings.json（与设置页安装后的形状相同），不碰真实的 ~/.pi
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(home, ".pi", "agent", "settings.json"),
  JSON.stringify({ packages: [pkg] }),
);

const fake = await startFakeModel(
  [{ tools: [{ name: "hello_plugin", args: {} }] }, { text: "完成" }],
  { delay: 20 },
);
const port = 18200 + Math.floor(Math.random() * 90);
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
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) break;
    } catch {}
    await sleep(250);
  }
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
        reasoning: true,
        levels: ["off", "low", "high"],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  // 登记了但没打开的包不进会话：先确认默认是关的，再走设置页同一个接口打开它
  const listed = await api("GET", "/plugins");
  check(
    "默认开关",
    listed.length === 1 && listed[0].enabled === false,
    `登记的包默认应是关的：${JSON.stringify(listed)}`,
  );
  await api("PATCH", `/plugins/${encodeURIComponent(listed[0].source)}`, {
    enabled: true,
  });
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();
    page.on("pageerror", (e) => problems.push(`页面报错：${e.message}`));
    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(work);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);
    const box = page.locator("textarea").first();
    await box.fill("调用一下插件工具");
    await box.press("Enter");

    // 1) 插件工具默认走审批
    const approve = page.locator(".ch-approve");
    await approve.waitFor({ timeout: 40000 });
    check(
      "审批",
      ((await approve.textContent()) ?? "").includes("hello_plugin"),
      "审批弹窗没点名插件工具",
    );
    if (SHOTS)
      await page.screenshot({ path: join(SHOTS, "plugins-approve.png") });
    await page.getByRole("button", { name: "批准", exact: true }).click();

    // 2) 批准后插件的 notify 弹 toast
    const toast = page.getByText("来自插件的提示");
    await toast.waitFor({ timeout: 20000 }).catch(() => {});
    check(
      "通知",
      (await toast.count()) === 1,
      `toast 条数 ${await toast.count()}`,
    );
    if (SHOTS)
      await page.screenshot({ path: join(SHOTS, "plugins-toast.png") });
    const log =
      (await page.getByRole("log", { name: "对话记录" }).textContent()) ?? "";
    check("通知", !log.includes("来自插件的提示"), "通知文本进了对话流");
    await page
      .getByText("完成")
      .first()
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    check(
      "对话",
      (
        (await page.getByRole("log", { name: "对话记录" }).textContent()) ?? ""
      ).includes("完成"),
      "工具执行后对话没有继续",
    );
  } finally {
    await browser.close();
  }
} catch (err) {
  problems.push(`脚本异常：${err instanceof Error ? err.message : err}`);
} finally {
  proc.kill("SIGKILL");
  await fake.close();
  rmSync(base, { recursive: true, force: true });
}

if (problems.length === 0) {
  console.log(`verify-plugins PASS（${checks} 项检查）`);
} else {
  console.log(`verify-plugins FAIL（${problems.length}/${checks}）`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
