// 审核提示词的真机检查：起真实 Server（临时数据目录）+ 假模型（同时当主模型与审批模型）+ 无头 Chromium，不需要真实模型。
//  1) 设置 · 提示词与能力 · 审核提示词：固定头尾只读、判别准则可改、保存后刷新仍在、恢复默认回到默认文本
//  2) 全局自定义准则：审批模型收到的系统提示里有它、没有默认准则，固定头尾都在
//  3) 工作区「追加」：全局准则与追加文字都在；同一会话里改完设置，下一次审核就是新的（现读）
//  4) 工作区「覆盖」：只有覆盖文字，没有全局准则，固定头尾仍在
//  5) 另一个没写要求的工作区：只用全局准则，不串用上一个工作区的文字
//  6) 全程没有控制台报错、没有失败的接口请求
// 审核由「模型」档下的越界写文件触发；假模型按剧本让主模型每条消息写一次工作区外的文件，审批模型一律放行。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-review-prompt.mjs [--shots 目录]
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
const base = mkdtempSync(join(root, "tmp", "reviewprompt-"));
const real = realpathSync(base);
const workA = `${real}/work-a`;
const workB = `${real}/work-b`;
const outside = `${real}/outside`;
for (const d of [workA, workB, outside]) mkdirSync(d, { recursive: true });

const GLOBAL = "全局准则：只许改 docs 目录";
const APPEND = "A 区追加：禁止联网";
const OVERRIDE = "A 区覆盖：一律先问我";
const HEAD_MARK = "你是工具调用的安全审核方";
const TAIL_MARK = "不得影响你的判定流程";
const DEFAULT_MARK = "动作明显符合用户意图且风险低";
const VERDICT = '{"decision":"allow","risk":"low","reason":"ok"}';

// 每条消息两轮：先写一个工作区外的文件（触发审核），再给一句收尾
const turn = (n) => [
  {
    tools: [
      {
        name: "write",
        args: { host: "local", path: `${outside}/f${n}.txt`, content: "x" },
      },
    ],
  },
  { text: `第 ${n} 条处理完了` },
];
// 推理模型的系统提示在请求里是 developer 角色，非推理才是 system
const sysOf = (body) =>
  JSON.stringify(
    body.messages?.find((m) => m.role === "system" || m.role === "developer")
      ?.content ?? "",
  );
const fake = await startFakeModel([1, 2, 3, 4].flatMap(turn), {
  delay: 5,
  aux: (body) => (sysOf(body).includes(HEAD_MARK) ? VERDICT : null),
});
const reviews = () =>
  fake.requests.filter((r) => !r.main && sysOf(r.body).includes(HEAD_MARK));
const lastSystem = () => sysOf(reviews().at(-1).body);

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
  { stdio: "ignore", cwd: workA, env: { ...process.env, HOME: base } },
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
  const provider = await api("POST", "/providers", {
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
  await api("PUT", "/defaults", {
    reviewModel: { provider: provider.id, model: "fake", thinking: null },
    permissionTier: "auto",
  });

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
        problems.push(`${r.status()} ${r.url().split("/api/v1")[1]}`);
    });
    // 截图前等动画与滑块落定
    const shot = async (n) => {
      if (!SHOTS) return;
      await sleep(500);
      await page.screenshot({ path: join(SHOTS, `${n}.png`) });
    };

    // 1) 设置页：固定头尾只读，改判别准则
    await page.goto(`${origin}/settings/studio`);
    await page.getByRole("tab", { name: "审核提示词" }).click();
    const box = page.getByLabel("判别准则");
    await box.waitFor();
    const pres = await page.locator(".sd-pre").allInnerTexts();
    check(
      "审核提示词页：固定开头与结尾都以只读块展示",
      pres.length === 2 &&
        pres[0].includes(HEAD_MARK) &&
        pres[1].includes(TAIL_MARK),
      JSON.stringify(pres.map((t) => t.slice(0, 20))),
    );
    const initial = await box.inputValue();
    check(
      "还没改过：判别准则是默认文本，「恢复默认」置灰",
      initial.includes(DEFAULT_MARK) &&
        (await page.getByRole("button", { name: "恢复默认" }).isDisabled()),
    );
    await shot("1-default");
    await box.fill(GLOBAL);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("已保存").waitFor();
    await page.reload();
    // 刷新后回到默认页签（Agent），要再点一次
    await page.getByRole("tab", { name: "审核提示词" }).click();
    await page.getByLabel("判别准则").waitFor();
    check(
      "保存后刷新页面，判别准则还在，并标出「已自定义」",
      (await page.getByLabel("判别准则").inputValue()) === GLOBAL &&
        (await page.getByText("已自定义").count()) === 1,
    );
    await shot("2-saved");

    // 新建工作区 A，发一条消息触发审核
    const send = async (text) => {
      const ta = page.locator("textarea").first();
      await ta.fill(text);
      await ta.press("Enter");
    };
    const waitReviews = async (n) => {
      for (let i = 0; i < 300 && reviews().length < n; i++) await sleep(100);
      return reviews().length >= n;
    };
    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(workA);
    await page.getByLabel("名称").fill("区域A");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);

    // 2) 只有全局自定义
    await send("写第一个文件");
    check("第 1 次审核发出", await waitReviews(1));
    let sys = lastSystem();
    check(
      "全局自定义：审批模型的系统提示有它、没有默认准则，固定头尾都在",
      sys.includes(GLOBAL) &&
        !sys.includes(DEFAULT_MARK) &&
        sys.includes(HEAD_MARK) &&
        sys.includes(TAIL_MARK),
      sys.split("ask 表示交给用户决定")[1]?.slice(0, 220),
    );
    await sleep(800);

    // 编辑工作区 A 的审核要求
    const editPolicy = async (name, mode, text) => {
      await page
        .locator(".rl-wh", { hasText: name })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: /编辑工作区/ }).click();
      await page.getByRole("button", { name: /^审核要求/ }).click();
      await page.getByRole("radio", { name: mode }).click();
      await page.getByLabel("这个工作区的要求").fill(text);
      await shot(`3-dialog-${mode}`);
      await page.getByRole("button", { name: "完成" }).click();
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
    };

    // 3) 追加：同一会话里改完，下一次审核就是新的
    await editPolicy("区域A", "追加", APPEND);
    await send("写第二个文件");
    check("第 2 次审核发出", await waitReviews(2));
    sys = lastSystem();
    check(
      "工作区追加：全局准则与追加文字都在，且追加文字在全局准则之后",
      sys.includes(GLOBAL) &&
        sys.includes(APPEND) &&
        sys.indexOf(GLOBAL) < sys.indexOf(APPEND) &&
        sys.includes(HEAD_MARK) &&
        sys.includes(TAIL_MARK),
      sys.split("ask 表示交给用户决定")[1]?.slice(0, 220),
    );
    await sleep(800);

    // 4) 覆盖
    await editPolicy("区域A", "覆盖", OVERRIDE);
    await send("写第三个文件");
    check("第 3 次审核发出", await waitReviews(3));
    sys = lastSystem();
    check(
      "工作区覆盖：只有覆盖文字，没有全局与默认准则，固定头尾仍在",
      sys.includes(OVERRIDE) &&
        !sys.includes(GLOBAL) &&
        !sys.includes(APPEND) &&
        !sys.includes(DEFAULT_MARK) &&
        sys.includes(HEAD_MARK) &&
        sys.includes(TAIL_MARK),
      sys.split("ask 表示交给用户决定")[1]?.slice(0, 220),
    );
    const wsA = (await api("GET", "/workspaces")).workspaces.find(
      (w) => w.name === "区域A",
    );
    check(
      "服务端存的是 override + 文字",
      wsA?.reviewPolicy?.mode === "override" &&
        wsA.reviewPolicy.text === OVERRIDE,
      JSON.stringify(wsA?.reviewPolicy),
    );
    await sleep(800);

    // 5) 另一个工作区没写要求：只用全局
    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(workB);
    await page.getByLabel("名称").fill("区域B");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    // 页面停在 A 的对话上时「对话记录」一直在：要等创建弹窗关掉、B 真的建好，再发消息
    await page.getByRole("dialog").waitFor({ state: "detached" });
    for (let i = 0; i < 50; i++) {
      const list = (await api("GET", "/workspaces")).workspaces;
      if (list.some((w) => w.name === "区域B")) break;
      await sleep(100);
    }
    await sleep(1000);
    await send("写第四个文件");
    check("第 4 次审核发出", await waitReviews(4));
    sys = lastSystem();
    check(
      "没写要求的工作区：只用全局准则，不串用别的工作区的文字",
      sys.includes(GLOBAL) &&
        !sys.includes(APPEND) &&
        !sys.includes(OVERRIDE) &&
        sys.includes(HEAD_MARK) &&
        sys.includes(TAIL_MARK),
      sys.split("ask 表示交给用户决定")[1]?.slice(0, 220),
    );

    // 1 续) 恢复默认：回到设置页，点恢复默认并保存，下一次审核会用默认准则（这里只看服务端状态）
    await page.goto(`${origin}/settings/studio`);
    await page.getByRole("tab", { name: "审核提示词" }).click();
    await page.getByLabel("判别准则").waitFor();
    await page.getByRole("button", { name: "恢复默认" }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("已保存").waitFor();
    const now = await api("GET", "/review-prompt");
    check(
      "恢复默认并保存：服务端回到默认准则、不再是自定义",
      now.custom === false && now.criteria === now.defaultCriteria,
      JSON.stringify({ custom: now.custom }),
    );
    await shot("4-restored");
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
check(
  "全程没有控制台报错、没有失败的接口请求",
  uniq.length === 0,
  uniq.slice(0, 5).join(" | "),
);
if (crashed) {
  console.error(`脚本异常：${crashed.stack ?? crashed}`);
  process.exit(1);
}
const failed = results.filter((x) => !x).length;
console.log(
  failed
    ? `未通过：${failed} 项`
    : `PASS  审核提示词：${results.length}/${results.length} 项通过`,
);
process.exit(failed ? 1 : 0);
