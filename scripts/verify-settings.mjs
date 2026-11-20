// 设置页可达性的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，在四档视口下
//  1) 工作区左轨底部的「设置」按钮可见、点得到；点它进入第一页；⌘, 同样进入；
//  2) 从左侧导航逐个点到六个设置页：页头、当前项、内容区都正确，没有控制台报错、没有失败的接口请求；
//  3) 每个 /settings/<页> 刷新（直接打开地址）都能打开；
//  4) 「返回工作区」回到工作区，入口仍在。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-settings.mjs [--shots 目录]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  [1280, 800],
  [1024, 768],
  [780, 800],
  [560, 800],
];
const PAGES = [
  ["providers", "供应商与模型"],
  ["remote", "远程连接"],
  ["variables", "隐私变量"],
  ["tools", "工具与能力"],
  ["studio", "提示词与能力"],
  ["defaults", "默认值设置"],
];

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "settings-"));
const work = join(base, "work");
mkdirSync(work, { recursive: true });
const port = 17650 + Math.floor(Math.random() * 90);
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
const report = (where, msg) => problems.push(`${where}: ${msg}`);
let checks = 0;

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    for (const [w, h] of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
      });
      const page = await ctx.newPage();
      let where = `${w}px`;
      // 页面自己的错误、控制台 error、/api 的失败响应都算问题
      page.on("pageerror", (e) =>
        report(where, `pageerror ${e.message.split("\n")[0]}`),
      );
      page.on("console", (m) => {
        if (m.type() === "error")
          report(where, `console.error ${m.text().slice(0, 140)}`);
      });
      page.on("response", (r) => {
        if (r.url().includes("/api/v1/") && r.status() >= 400)
          report(
            where,
            `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
          );
      });
      const shot = async (name) => {
        if (SHOTS)
          await page.screenshot({ path: join(SHOTS, `${w}-${name}.png`) });
      };
      const heading = (label) =>
        page
          .getByRole("heading", { name: label })
          .first()
          .waitFor({ timeout: 8000 });

      // 1) 入口
      await page.goto(origin);
      await page.waitForSelector(".sh-app");
      const entry = page.getByRole("button", { name: "设置", exact: true });
      await entry.waitFor({ timeout: 8000 });
      const box = await entry.boundingBox();
      checks++;
      if (!box || box.width < 20 || box.height < 20)
        report(where, `「设置」入口太小或不可见：${JSON.stringify(box)}`);
      else if (
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > w ||
        box.y + box.height > h
      )
        report(where, `「设置」入口在视口之外：${JSON.stringify(box)}`);
      await entry.click();
      await page.waitForURL("**/settings/providers");
      await heading("供应商与模型");
      await shot("entry");

      // 2) 逐页点到
      for (const [path, label] of PAGES) {
        where = `${w}px 导航→${label}`;
        const link = page
          .getByRole("navigation", { name: "设置分区" })
          .getByRole("link", { name: label });
        await link.click();
        await page.waitForURL(`**/settings/${path}`);
        await heading(label);
        await sleep(500);
        checks++;
        const state = await page.evaluate(() => {
          const main = document.querySelector(".st-main");
          const cur = document.querySelector('.st-nav [aria-current="page"]');
          return {
            text: (main?.textContent ?? "").trim().length,
            cur: cur?.textContent?.trim() ?? null,
            over: document.documentElement.scrollWidth > innerWidth,
          };
        });
        if (state.text === 0) report(where, "内容区空白");
        if (state.cur !== label) report(where, `当前导航项是「${state.cur}」`);
        if (state.over) report(where, "出现横向滚动");
        await shot(`page-${path}`);
      }

      // 3) 返回；⌘, 再进
      where = `${w}px 返回`;
      await page.getByRole("button", { name: "返回工作区" }).click();
      await page.waitForURL(`${origin}/`);
      await page.getByRole("button", { name: "设置", exact: true }).waitFor();
      checks++;
      await page.keyboard.press("Control+,");
      await page
        .waitForURL("**/settings/providers", { timeout: 5000 })
        .catch(() => report(where, "⌘, 没进入设置"));

      // 4) 每页刷新（直接打开地址）
      for (const [path, label] of PAGES) {
        where = `${w}px 直接打开→${label}`;
        await page.goto(`${origin}/settings/${path}`);
        await heading(label);
        checks++;
      }
      await ctx.close();
    }
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
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

const uniq = [...new Set(problems)];
for (const p of uniq.slice(0, 40)) console.log(`FAIL  ${p}`);
if (uniq.length > 40) console.log(`      …另有 ${uniq.length - 40} 条`);
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = uniq.length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 个问题（已检查 ${checks} 处）`
    : `PASS  四档视口 × 入口/六页导航/刷新直开/返回，共检查 ${checks} 处，无控制台报错、无失败接口`,
);
process.exit(bad ? 1 : 0);
