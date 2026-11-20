// 对话流里复制渲染内容给 Markdown 原文的真机检查：起真实 Server（临时数据目录）+ 假模型 + 无头 Chromium，不需要真实模型。
//  1) 选中一条回复里整块的段落 / 列表 / 代码块再复制：剪贴板里是 Markdown 原文（加粗、行内代码、围栏、链接都在）
//  2) 选区跨过工具行、连着两段回复正文：两段都还原成原文，中间工具行的文字照常带上
//  3) 选区只在一个段落里（选一句话，含行内格式）：照浏览器默认复制，不接管
//  4) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-chat-copy.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const base = mkdtempSync(join(root, "tmp", "chatcopy-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "notes.md"), "# 记录\n");

const FIRST = [
  "## 小结",
  "",
  "先说结论：**接口已改好**，用到了 `fetchData()`。",
  "",
  "- 第一项",
  "- 第二项",
  "",
  "```ts",
  "const a = 1;",
  "```",
].join("\n");
const SECOND = [
  "再补一句：[文档](https://example.com/doc) 已更新。",
  "",
  "| 列 | 值 |",
  "| --- | --- |",
  "| a | 1 |",
].join("\n");

// 一条回复里：正文 → 工具调用 → 正文
const fake = await startFakeModel(
  [
    { text: FIRST, tools: [{ name: "read", args: { path: "notes.md" } }] },
    { text: SECOND },
  ],
  { delay: 5 },
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
  { stdio: "ignore", cwd: work, env: { ...process.env, HOME: base } },
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
    const shot = (n) =>
      SHOTS ? page.screenshot({ path: join(SHOTS, `${n}.png`) }) : null;

    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(work);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);
    const box = page.locator("textarea").first();
    await box.fill("总结一下");
    await box.press("Enter");
    await page.locator(".ch-md table").waitFor({ timeout: 30000 });
    await sleep(800);
    await shot("1-reply");

    // 在页面里选中 [from, to] 两个元素之间的内容（含两端整块），真触发一次复制，读 copy 事件写进剪贴板的内容
    const copyBetween = (fromSel, toSel) =>
      page.evaluate(
        ([a, b]) => {
          const from = document.querySelector(a);
          const to = [...document.querySelectorAll(b)].at(-1);
          const r = document.createRange();
          r.setStartBefore(from);
          r.setEndAfter(to);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          let got = null;
          const grab = (e) => {
            got = e.clipboardData.getData("text/plain");
          };
          document.addEventListener("copy", grab);
          document.execCommand("copy");
          document.removeEventListener("copy", grab);
          return got;
        },
        [fromSel, toSel],
      );

    // 1) 第一段回复里整块选中
    const one = await copyBetween(".ch-md h2", ".ch-md pre, .ch-md .md-src");
    check(
      "整块选中一段回复正文再复制：剪贴板里是 Markdown 原文",
      one === FIRST,
      JSON.stringify(one),
    );

    // 2) 跨过工具行，连着两段回复
    const both = await copyBetween(".ch-md h2", ".ch-md table");
    check(
      "选区跨过工具行、连着两段回复：两段都是 Markdown 原文，顺序不乱",
      both !== null &&
        both.startsWith(FIRST) &&
        both.endsWith(SECOND) &&
        both.indexOf("```ts") < both.indexOf("[文档](https://example.com/doc)"),
      JSON.stringify(both),
    );

    // 3) 只选一个段落里的一句话：不接管（取不到 copy 事件里的数据 = 走浏览器默认复制）
    const inner = await page.evaluate(() => {
      const p = [...document.querySelectorAll(".ch-md p")].find((x) =>
        x.textContent.includes("先说结论"),
      );
      const text = p.firstChild;
      const r = document.createRange();
      r.setStart(text, 1);
      r.setEnd(text, 4);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      let handled = false;
      const grab = (e) => {
        handled = e.defaultPrevented;
      };
      document.addEventListener("copy", grab);
      document.execCommand("copy");
      document.removeEventListener("copy", grab);
      return handled;
    });
    check("只选一个段落里的一句话：不接管，照浏览器默认复制", inner === false);
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
    : `PASS  对话流复制 Markdown：${results.length}/${results.length} 项通过`,
);
process.exit(failed ? 1 : 0);
