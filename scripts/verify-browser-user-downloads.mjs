// 用户接管页面上的下载的真机检查：真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 本地假站点
// + 无头 Chromium 当用户的浏览器，不需要真实模型：用户在界面里接管页面、用真鼠标点下载链接，弹窗问存到哪。
//  1) 点下载链接：弹出「保存下载的文件」，写着文件名；页面状态里有这一项
//  2) 保存到本机：用户的浏览器真的收到下载，文件名与字节和站点发出的逐字节相同；弹窗消失，Server 的暂存清空
//  3) 放进工作区目录：文件落在目录根下，字节一致；再放一次同名的自动加序号，不覆盖
//  4) 丢弃：弹窗消失，目录里没有多出文件，页面控制台里留着「已取消下载」
//  5) 排队：两个下载同时挂起时先问一个、写着还有一个在等，处理完再问下一个
//  6) 超过设置里的单个文件上限：这一项在 Server 里作废、弹窗随之关掉，原因用提示条给
//  7) 全程没有控制台报错、没有预期之外的失败接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
//   agent 用的浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用上面装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-user-downloads.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentChromePath, chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const agentChrome = agentChromePath();

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
    await sleep(150);
    v = await fn();
  }
  return v;
}

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-user-downloads-"));
const work = `${realpathSync(base)}/work`;
const proj = `${work}/proj`;
mkdirSync(proj, { recursive: true });
const dataDir = join(base, "data");

// —— 假站点：三个链接固定在视口左侧，剧本按坐标点 ——
const BYTES = Buffer.from(
  Array.from({ length: 60_000 }, (_, i) => (i * 11 + 5) & 255),
);
const SECOND = Buffer.from("second-file-content");
const BIG = Buffer.alloc(1_500_000, 7);
const PAGE = `<!doctype html><meta charset=utf-8><title>下载站</title>
<style>.b{position:fixed;left:100px;width:240px;height:60px;display:block;background:#ddd;font:20px sans-serif}</style>
<a class="b" style="top:100px" href="/report">下载报告</a>
<a class="b" style="top:200px" href="/second">下载第二个</a>
<a class="b" style="top:300px" href="/big">下载大文件</a>
<a class="b" style="top:400px" href="/report" download>排队：报告</a>
<a class="b" style="top:500px" href="/second" download>排队：第二个</a>`;
const attach = (name) => ({
  "content-type": "application/octet-stream",
  "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
});
// 报告可以让响应头晚一点到：排队的用例里，先点它再点第二个，第二个的下载事件反而先到
// （排队用例的两个链接带 download 属性：普通链接是导航，第二次导航会把第一次顶掉）
let reportDelayMs = 0;
const site = http.createServer((req, res) => {
  if (req.url === "/report")
    return void setTimeout(
      () => res.writeHead(200, attach("报告.bin")).end(BYTES),
      reportDelayMs,
    );
  if (req.url === "/second")
    return void res.writeHead(200, attach("second.bin")).end(SECOND);
  if (req.url === "/big")
    return void res.writeHead(200, attach("big.bin")).end(BIG);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;

const port = 19200 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const logs = [];
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
    dataDir,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: work,
    env: {
      ...process.env,
      ...(agentChrome ? { YUANSHU_BROWSER: agentChrome } : {}),
    },
  },
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

const problems = [];
/** 预期里会出现的失败请求（超限那一条的 502）；其余的失败请求都算问题。 */
let expected502 = 0;

/** 暂存目录里还剩的文件数（交付、丢弃后应当清空；清理是异步的，轮询到 0）。 */
const stagedFiles = () => {
  const stage = join(dataDir, "browser-downloads");
  if (!existsSync(stage)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      e.isDirectory() ? walk(join(d, e.name)) : n++;
  };
  walk(stage);
  return n;
};

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");

  const ws = (
    await api("POST", "/workspaces", {
      name: "用户下载",
      directories: [{ path: proj }],
    })
  ).json;
  await api("POST", "/sessions", { workspaceId: ws.id });
  const pagesOf = async () =>
    (await api("GET", `/workspaces/${ws.id}/browser`)).json.pages;
  const pending = async () => (await pagesOf())[0]?.pendingDownloads ?? [];

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error" && !/status of 502/.test(m.text()))
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (!r.url().includes("/api/v1/") || r.status() < 400) return;
      if (r.status() === 502 && expected502 > 0) return void expected502--;
      problems.push(
        `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
      );
    });
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    const wb = page.locator(".ws-wb");
    const dialog = page.getByRole("dialog", { name: "保存下载的文件" });
    /** 画布上的页面坐标 → 屏幕坐标 */
    const onCanvas = async (px, py) => {
      const b = await page.locator(".ws-wb-canvas").first().boundingBox();
      return { x: b.x + (px / 1280) * b.width, y: b.y + (py / 800) * b.height };
    };
    const clickLink = async (top) => {
      const at = await onCanvas(200, top + 30);
      await page.mouse.click(at.x, at.y);
    };

    // —— 用户在界面里开页面（新页面一开始就是手动操作）——
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "用户下载" }).click();
    await page.waitForSelector(".ws-pane");
    await sleep(600);
    await page.getByRole("button", { name: "新建标签页" }).first().click();
    await page.getByRole("menuitem", { name: /浏览器/ }).click();
    await wb.waitFor();
    await wb.getByRole("button", { name: "打开地址" }).click();
    const open = page.getByRole("dialog", { name: "浏览器页面" });
    await open.getByLabel("打开地址").fill(`server:${sitePort}/`);
    await open.getByRole("button", { name: "打开", exact: true }).click();
    const loaded = await until(
      async () => (await pagesOf()).some((p) => p.title === "下载站"),
      20000,
    );
    check(
      "用户开了页面，是手动操作",
      !!loaded && (await pagesOf())[0].controller === "user",
    );
    // 画面出了才点得到
    await until(() =>
      page.evaluate(() => {
        const c = document.querySelector(".ws-wb-canvas");
        return !!c && !c.hidden && c.width === 1280;
      }),
    );
    await sleep(500);

    // 1) 点链接 → 弹窗
    await clickLink(100);
    const shown = await until(() => dialog.isVisible().catch(() => false));
    check(
      "点下载链接：弹出「保存下载的文件」，写着文件名",
      !!shown &&
        (await dialog.getByText("报告.bin", { exact: true }).count()) === 1,
    );
    check(
      "页面状态里有这一项（带中文文件名）",
      (await pending()).map((p) => p.filename).join() === "报告.bin",
      JSON.stringify(await pending()),
    );
    await shot("dialog");

    // 2) 保存到本机：用户的浏览器真的收到下载
    const got = page.waitForEvent("download", { timeout: 15000 });
    await dialog.getByRole("button", { name: "保存到本机" }).click();
    const dl = await got.catch(() => null);
    const localBytes = dl ? readFileSync(await dl.path()) : Buffer.alloc(0);
    check(
      "保存到本机：用户的浏览器收到文件，文件名与字节和站点发出的逐字节相同",
      dl?.suggestedFilename() === "报告.bin" && localBytes.equals(BYTES),
      `${dl?.suggestedFilename()} ${localBytes.length} 字节`,
    );
    check(
      "弹窗消失，清单与 Server 的暂存都清空",
      !!(await until(async () => !(await dialog.isVisible()))) &&
        !!(await until(async () => (await pending()).length === 0)) &&
        !!(await until(() => stagedFiles() === 0)),
      `清单 ${(await pending()).length} 项，暂存 ${stagedFiles()} 个文件`,
    );

    // 3) 放进工作区目录（这个工作区只有一个目录，不出现选择）
    await clickLink(100);
    await dialog.waitFor();
    check(
      "只有一个目录时不出现「放进哪个目录」",
      (await dialog.getByText("放进哪个目录").count()) === 0,
    );
    await dialog.getByRole("button", { name: "放进工作区目录" }).click();
    await until(async () => !(await dialog.isVisible()));
    const first = join(proj, "报告.bin");
    check(
      "放进目录：文件在目录根下，字节一致，界面提示了最终文件名",
      existsSync(first) &&
        readFileSync(first).equals(BYTES) &&
        (await page.getByText("已放进「proj」：报告.bin").count()) === 1,
      JSON.stringify(readdirSync(proj)),
    );
    await clickLink(100);
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "放进工作区目录" }).click();
    await until(async () => !(await dialog.isVisible()));
    const second = join(proj, "报告 (1).bin");
    check(
      "再放一次同名的：自动加序号，原文件不被覆盖",
      existsSync(second) &&
        readFileSync(second).equals(BYTES) &&
        readFileSync(first).equals(BYTES),
      JSON.stringify(readdirSync(proj)),
    );

    // 4) 丢弃
    const before = readdirSync(proj).length;
    await clickLink(100);
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "丢弃" }).click();
    check(
      "丢弃：弹窗消失，清单清空，目录里没有多出文件，暂存为空",
      !!(await until(async () => !(await dialog.isVisible()))) &&
        !!(await until(async () => (await pending()).length === 0)) &&
        readdirSync(proj).length === before &&
        !!(await until(() => stagedFiles() === 0)),
      `${readdirSync(proj).length} 个文件`,
    );
    const consoleOf = async () =>
      (
        await api(
          "GET",
          `/workspaces/${ws.id}/browser/pages/${(await pagesOf())[0].id}/console`,
        )
      ).json.entries.map((e) => e.text);
    check(
      "丢弃：页面控制台里留着「已取消下载 报告.bin：用户丢弃」",
      (await consoleOf()).some((t) =>
        t.includes("已取消下载 报告.bin：用户丢弃"),
      ),
      JSON.stringify((await consoleOf()).slice(-3)),
    );

    // 5) 排队：先点「报告」（响应头晚 1.2 秒到），再点「第二个」（立刻到）：第二个先挂起、先问
    reportDelayMs = 1200;
    await clickLink(400);
    await sleep(100);
    await clickLink(500);
    await dialog.waitFor();
    check(
      "排队：先问先到的 second.bin，写着「还有 1 个下载在等你处理」",
      (await dialog.getByText("second.bin", { exact: true }).count()) === 1 &&
        !!(await until(
          async () =>
            (await dialog.getByText("还有 1 个下载在等你处理").count()) === 1,
          5000,
        )),
    );
    await shot("dialog-queue");
    await dialog.getByRole("button", { name: "丢弃" }).click();
    const next = await until(
      async () =>
        (await dialog.getByText("报告.bin", { exact: true }).count()) === 1,
    );
    check(
      "处理完第一个，接着问下一个（报告.bin），不再写还有在等",
      !!next && (await dialog.getByText(/还有 \d+ 个下载/).count()) === 0,
    );
    await dialog.getByRole("button", { name: "丢弃" }).click();
    await until(async () => !(await dialog.isVisible()));
    reportDelayMs = 0;

    // 6) 超过设置里的单个文件上限（最小 1 MB，大文件 1.5 MB）：这一项在 Server 里作废，弹窗随之关掉，原因用提示条给
    const defaults = (await api("GET", "/defaults")).json;
    const put = await api("PUT", "/defaults", {
      canvasMedia: { ...defaults.canvasMedia, uploadMaxMB: 1 },
    });
    if (put.status !== 200) throw new Error(`改上限失败 ${put.status}`);
    await clickLink(300);
    await dialog.waitFor();
    expected502 = 1;
    await dialog.getByRole("button", { name: "保存到本机" }).click();
    const toastText = await until(async () => {
      const t = await page.locator(".u-toast").allInnerTexts();
      return t.find((x) => x.includes("文件太大")) ?? null;
    });
    check(
      "超过单个文件上限：提示条说明原因（带大小与上限）",
      !!toastText &&
        /1\.\d MB/.test(toastText) &&
        toastText.includes("上限 1 MB"),
      toastText ?? "没有出现提示条",
    );
    await shot("dialog-error");
    check(
      "超限的这一项作废：弹窗关了，Server 清单里没有了，暂存为空",
      !!(await until(async () => !(await dialog.isVisible()))) &&
        !!(await until(async () => (await pending()).length === 0)) &&
        !!(await until(() => stagedFiles() === 0)),
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
  site.closeAllConnections();
  site.close();
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

check(
  "没有控制台报错与预期之外的失败请求",
  problems.length === 0,
  problems.slice(0, 3).join(" | "),
);
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
  `\n用户页下载：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
