// 用户接管页面上的上传的真机检查：真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 会记下收到的表单上传的本地假站点
// + 无头 Chromium 当用户的浏览器，不需要真实模型：用户在界面里接管页面、用真鼠标点页面上的「选择文件」，弹窗问选哪些文件。
//  1) 点单选入口：弹出「选择要上传的文件」，没选文件时「上传」点不了
//  2) 选一个中文名的文件上传：页面的 change 处理读到文件名；再点页面上的「提交」，站点收到原文件名与逐字节相同的内容（选完后文件早已不被 Server 占用）
//  3) 点多选入口选两个文件：页面读到两个名字，站点收到两份、字节都对
//  4) 取消：什么都不交，页面里已选的文件没变
//  5) 超过设置里的单个文件上限：提示条说明原因，弹窗还在、已选的文件还在，没有把文件交给页面
//  6) 全程没有控制台报错、没有预期之外的失败接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
//   agent 用的浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用上面装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-user-uploads.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
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
const base = mkdtempSync(join(root, "tmp", "browser-user-uploads-"));
const work = `${realpathSync(base)}/work`;
const proj = `${work}/proj`;
const local = `${base}/local`; // 「用户电脑上」的文件
mkdirSync(proj, { recursive: true });
mkdirSync(local, { recursive: true });

const rand = (n, seed) =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i * seed + 3) & 255));
const FILES = {
  resume: { name: "简历.pdf", bytes: rand(40_000, 7) },
  a: { name: "a.txt", bytes: rand(1_000, 3) },
  b: { name: "b 文件.bin", bytes: rand(2_000, 5) },
  big: { name: "big.bin", bytes: Buffer.alloc(1_500_000, 9) },
};
for (const f of Object.values(FILES)) {
  f.path = join(local, f.name);
  writeFileSync(f.path, f.bytes);
}

// —— 假站点：单选与多选两个上传入口（固定在视口左侧）；选完把名字写进 #names；「提交」把表单发到 /up，站点记下收到的每个文件 ——
const PAGE = `<!doctype html><meta charset=utf-8><title>上传站</title>
<style>.b{position:fixed;left:100px;width:360px;height:60px;display:block;font:18px sans-serif}</style>
<form method="post" action="/up" enctype="multipart/form-data" target="sink">
  <input class="b" style="top:100px" type="file" name="one" id="one">
  <input class="b" style="top:200px" type="file" name="many" id="many" multiple>
  <button class="b" style="top:300px" type="submit">提交</button>
</form>
<iframe name="sink" style="display:none"></iframe>
<p id="names" style="position:fixed;left:100px;top:400px;font:18px sans-serif"></p>
<script>
  const show = () => {
    const all = [...one.files, ...many.files].map((f) => f.name);
    document.getElementById("names").textContent = "已选：" + all.join("、");
    document.title = "上传站 " + all.length;
  };
  one.onchange = many.onchange = show;
</script>`;
const received = []; // 每次提交收到的文件 { field, filename, body }
const site = http.createServer((req, res) => {
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const boundary = /boundary=(.+)$/.exec(
        req.headers["content-type"] ?? "",
      )?.[1];
      const got = [];
      if (boundary) {
        for (const part of raw.toString("latin1").split(`--${boundary}`)) {
          const head = /name="([^"]*)"; filename="([^"]*)"/.exec(part);
          if (!head || head[2] === "") continue;
          const at = part.indexOf("\r\n\r\n") + 4;
          got.push({
            field: head[1],
            // 文件名是 UTF-8 字节被当 latin1 读出来的，再还原
            filename: Buffer.from(head[2], "latin1").toString("utf8"),
            body: Buffer.from(part.slice(at, part.length - 2), "latin1"),
          });
        }
      }
      received.push(got);
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("ok");
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;

const port = 19300 + Math.floor(Math.random() * 90);
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
    join(base, "data"),
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
/** 预期里会出现的失败请求（超限那一条的 413）；其余的失败请求都算问题。 */
let expectedFail = 0;

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
      name: "用户上传",
      directories: [{ path: proj }],
    })
  ).json;
  await api("POST", "/sessions", { workspaceId: ws.id });
  const pagesOf = async () =>
    (await api("GET", `/workspaces/${ws.id}/browser`)).json.pages;

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error" && !/status of 413/.test(m.text()))
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (!r.url().includes("/api/v1/") || r.status() < 400) return;
      if (r.status() === 413 && expectedFail > 0) return void expectedFail--;
      problems.push(
        `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
      );
    });
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    const wb = page.locator(".ws-wb");
    const dialog = page.getByRole("dialog", { name: "选择要上传的文件" });
    const upBtn = () =>
      dialog.getByRole("button", { name: "上传", exact: true });
    const onCanvas = async (px, py) => {
      const b = await page.locator(".ws-wb-canvas").first().boundingBox();
      return { x: b.x + (px / 1280) * b.width, y: b.y + (py / 800) * b.height };
    };
    const clickAt = async (px, py) => {
      const at = await onCanvas(px, py);
      await page.mouse.click(at.x, at.y);
    };
    const sitePage = async () => (await pagesOf())[0];
    const titleNow = async () => (await sitePage())?.title ?? "";
    /** 点页面上的「提交」，等站点多收到一次表单。 */
    const submit = async () => {
      const n = received.length;
      await clickAt(280, 330);
      return (await until(() => received.length > n)) ? received[n] : null;
    };

    // —— 用户在界面里开页面（新页面一开始就是手动操作）——
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "用户上传" }).click();
    await page.waitForSelector(".ws-pane");
    await sleep(600);
    await page.getByRole("button", { name: "新建标签页" }).first().click();
    await page.getByRole("menuitem", { name: /浏览器/ }).click();
    await wb.waitFor();
    await wb.getByRole("button", { name: "打开地址" }).click();
    const open = page.getByRole("dialog", { name: "浏览器页面" });
    await open.getByLabel("打开地址").fill(`server:${sitePort}/`);
    await open.getByRole("button", { name: "打开", exact: true }).click();
    await until(async () => (await titleNow()).startsWith("上传站"), 20000);
    await until(() =>
      page.evaluate(() => {
        const c = document.querySelector(".ws-wb-canvas");
        return !!c && !c.hidden && c.width === 1280;
      }),
    );
    await sleep(500);
    check("用户开了页面，是手动操作", (await sitePage()).controller === "user");

    // 1) 点单选入口 → 弹窗
    await clickAt(280, 130);
    const shown = await until(() => dialog.isVisible().catch(() => false));
    check(
      "点页面上的单选入口：弹出「选择要上传的文件」，没选文件时「上传」点不了",
      !!shown && (await upBtn().isDisabled()),
    );
    await shot("dialog-empty");

    // 2) 选一个中文名的文件上传
    await dialog.locator("input[type=file]").setInputFiles(FILES.resume.path);
    await shot("dialog-picked");
    await upBtn().click();
    check(
      "上传后：弹窗消失，页面的 change 处理读到文件名（标题里的数量为 1）",
      !!(await until(async () => !(await dialog.isVisible()))) &&
        !!(await until(async () => (await titleNow()) === "上传站 1")),
      await titleNow(),
    );
    const got1 = await submit();
    check(
      "点页面上的「提交」：站点收到原文件名与逐字节相同的内容",
      !!got1 &&
        got1.length === 1 &&
        got1[0].field === "one" &&
        got1[0].filename === FILES.resume.name &&
        got1[0].body.equals(FILES.resume.bytes),
      JSON.stringify(got1?.map((g) => [g.field, g.filename, g.body.length])),
    );

    // 3) 多选入口选两个文件
    await clickAt(280, 230);
    await dialog.waitFor();
    check(
      "多选入口：文件框带 multiple",
      (await dialog.locator("input[type=file]").getAttribute("multiple")) !==
        null,
    );
    await dialog
      .locator("input[type=file]")
      .setInputFiles([FILES.a.path, FILES.b.path]);
    await upBtn().click();
    await until(async () => !(await dialog.isVisible()));
    const got2 = await submit();
    check(
      "多选：站点收到两份，文件名与字节都对（连同上一次选的单选文件共三份）",
      !!got2 &&
        got2.filter((g) => g.field === "many").length === 2 &&
        got2.some(
          (g) => g.filename === FILES.a.name && g.body.equals(FILES.a.bytes),
        ) &&
        got2.some(
          (g) => g.filename === FILES.b.name && g.body.equals(FILES.b.bytes),
        ),
      JSON.stringify(got2?.map((g) => [g.field, g.filename, g.body.length])),
    );

    // 4) 取消：什么都不交，页面保持原样（已选数量不变）
    // 标题由 Server 轮询刷新，多选刚交完时可能还是旧值：等到三个文件都在标题里再取基线
    await until(async () => (await titleNow()) === "上传站 3");
    const titleBefore = await titleNow();
    const countBefore = received.length;
    await clickAt(280, 130);
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "取消" }).click();
    await sleep(500);
    check(
      "取消：弹窗消失，页面里已选的文件没变，站点没有多收到东西",
      !(await dialog.isVisible()) &&
        (await titleNow()) === titleBefore &&
        received.length === countBefore,
      `${titleBefore} → ${await titleNow()}`,
    );

    // 5) 超过设置里的单个文件上限（最小 1 MB，大文件 1.5 MB）
    const defaults = (await api("GET", "/defaults")).json;
    const put = await api("PUT", "/defaults", {
      canvasMedia: { ...defaults.canvasMedia, uploadMaxMB: 1 },
    });
    if (put.status !== 200) throw new Error(`改上限失败 ${put.status}`);
    await clickAt(280, 130);
    await dialog.waitFor();
    await dialog.locator("input[type=file]").setInputFiles(FILES.big.path);
    expectedFail = 1;
    const before = received.length;
    await upBtn().click();
    const toastText = await until(async () => {
      const t = await page.locator(".u-toast").allInnerTexts();
      return t.find((x) => x.includes("文件太大")) ?? null;
    });
    check(
      "超过单个文件上限：提示条说明原因（带大小、上限与文件名）",
      !!toastText &&
        toastText.includes("上限 1 MB") &&
        toastText.includes("big.bin"),
      toastText ?? "没有出现提示条",
    );
    await shot("dialog-error");
    check(
      "超限时弹窗还在、已选的文件还在，页面没有收到文件",
      (await dialog.isVisible()) &&
        (await dialog.getByText("big.bin", { exact: true }).count()) === 1 &&
        (await titleNow()) === titleBefore &&
        received.length === before,
    );
    await dialog.getByRole("button", { name: "取消" }).click();
    await until(async () => !(await dialog.isVisible()));
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
  `\n用户页上传：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
