// 浏览器下载镜像的真机检查：真实 Server（临时数据目录，故意不给浏览器——数据目录里没有 Chromium，只能走下载），
// 无头 Chromium 当用户的浏览器，不用模型。接线问题（设置里的镜像交给引擎的下载）单测测不出，这里用真 Server 验。
//  1) 设置页「浏览器」有「下载镜像」，一开始是空的，没有保存条
//  2) 填一个地址：出现保存条；保存后服务端存下了它，保存条消失，刷新页面后输入框仍是它
//  3) 引擎下载用到了这个镜像：镜像指向一个连不上的地址，装浏览器失败，失败原因里写着「下载源」就是它
//  4) 清空后保存：服务端回到空，刷新后输入框也是空
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-browser-mirror.mjs [--shots 目录]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(200);
    v = await fn();
  }
  return v;
}

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-mirror-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });

const MIRROR = "http://127.0.0.1:9/playwright"; // 没人监听的端口：下载立刻被拒
const port = 19500 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const logs = [];
// 不给 YUANSHU_BROWSER 与镜像环境变量：数据目录里没有 Chromium，引擎只能下载，下载源只能来自设置
const {
  YUANSHU_BROWSER: _b,
  PLAYWRIGHT_DOWNLOAD_HOST: _m,
  ...env
} = process.env;
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
  { stdio: ["ignore", "pipe", "pipe"], cwd: work, env },
);
proc.stdout.on("data", (b) => logs.push(b.toString()));
proc.stderr.on("data", (b) => logs.push(b.toString()));

const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};
const mirrorOnServer = async () =>
  (await api("GET", "/defaults")).json.browserMirror;

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
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };
    const input = page.getByLabel("下载镜像");
    const bar = page.getByRole("region", { name: "保存" });
    const saveBtn = bar.getByRole("button", { name: "保存", exact: true });

    // 1) 设置页：空的，没有保存条
    await page.goto(`${origin}/settings/browser`);
    await input.waitFor();
    await sleep(500); // 等进入设置页的转场结束
    check(
      "设置页「浏览器」有「下载镜像」，一开始是空的，没有保存条",
      (await input.inputValue()) === "" && (await bar.count()) === 0,
    );

    // 2) 填地址、保存、刷新后还在
    await input.fill(`  ${MIRROR} `);
    await bar.waitFor();
    await shot("mirror-1-dirty");
    await saveBtn.click();
    check(
      "保存：服务端存下了去掉空白的地址，保存条消失",
      !!(await until(async () => (await mirrorOnServer()) === MIRROR)) &&
        !!(await until(async () => (await bar.count()) === 0)),
      String(await mirrorOnServer()),
    );
    await page.reload();
    await input.waitFor();
    check(
      "刷新页面后输入框仍是这个地址",
      (await input.inputValue()) === MIRROR,
    );
    await shot("mirror-2-saved");

    // 3) 引擎下载用它：失败原因里写着下载源
    const ws = (
      await api("POST", "/workspaces", {
        name: "镜像",
        directories: [{ path: work }],
      })
    ).json;
    const failure = async () => {
      const { engine } = (await api("GET", `/workspaces/${ws.id}/browser`))
        .json;
      return engine.status === "failed"
        ? (engine.problem?.message ?? "")
        : null;
    };
    await api("POST", "/browser/engine/ensure", {});
    const msg = await until(failure, 90000);
    check(
      "引擎下载失败，失败原因里的「下载源」就是设置里的镜像",
      typeof msg === "string" && msg.includes(`下载源：${MIRROR}`),
      String(msg).split("\n").slice(0, 3).join(" | "),
    );

    // 4) 清空：服务端回到空，刷新后输入框也是空（不再触发下载：官方源可能真的连得上，那就是下 200MB）
    await input.fill("");
    await saveBtn.click();
    await until(async () => (await mirrorOnServer()) === "");
    await page.reload();
    await input.waitFor();
    check(
      "清空后保存：服务端回到空，刷新后输入框也是空",
      (await mirrorOnServer()) === "" && (await input.inputValue()) === "",
    );
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

if (crashed)
  console.log(
    `脚本异常：${String(crashed.stack ?? crashed.message)
      .split("\n")
      .slice(0, 6)
      .join(" | ")}`,
  );
const failed = results.filter((x) => !x).length + (crashed ? 1 : 0);
if (failed > 0 && logs.length > 0)
  console.log(
    `Server 日志末尾：${logs.join("").split("\n").slice(-8).join(" | ")}`,
  );
console.log(
  `\n浏览器下载镜像：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
