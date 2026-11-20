// 页面 JS 对话框的真机检查：真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 本地假站点 + 无头 Chromium 当用户的浏览器
// + 假模型（按剧本真的调 browser_*），不需要真实模型。
//  A 用户在界面里接管页面、用真鼠标点页面上的按钮：
//   1) alert：弹出「页面提示」，写明来源站点与原文，只有「知道了」；答了页面继续
//   2) confirm：「页面请求确认」带多行原文；点「取消」页面得到 false、点「确定」得到 true；Esc 等同取消
//   3) prompt：带默认值的输入框，改成别的内容回车，页面拿到输入
//  B agent 点了会弹 confirm 的按钮：
//   4) 点击立刻返回「BLOCKED BY DIALOG」外壳（不卡 30 秒）；页面状态里带 dialog
//   5) 用户（这里走与界面同一个接口）先答：页面继续；agent 随后的 browser_dialog 得到「没有等待回答的对话框」，没有重复回答
//   6) 已经没有对话框时再答，接口回 409
//  7) 全程没有控制台报错、没有预期之外的失败请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
//   agent 用的浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用上面装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-dialog.mjs [--shots 目录]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "./lib/fake-model.mjs";
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
const base = mkdtempSync(join(root, "tmp", "browser-dialog-"));
const work = `${realpathSync(base)}/work`;
const proj = `${work}/proj`;
mkdirSync(proj, { recursive: true });

// —— 假站点：三个固定位置的按钮，各弹一种对话框，回答写进标题 ——
const PAGE = `<!doctype html><meta charset=utf-8><title>对话框站</title>
<style>.b{position:fixed;left:100px;width:360px;height:60px;display:block;font:18px sans-serif}</style>
<button class="b" style="top:100px" onclick="alert('已保存'); document.title = '已看过提示'">提示</button>
<button class="b" style="top:200px" onclick="document.title = '确认:' + confirm('确定删除吗？\\n删除后不能恢复')">确认</button>
<button class="b" style="top:300px" onclick="document.title = '名字:' + prompt('你的名字？', '小明')">输入</button>`;
const site = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;

// —— 假模型剧本（B）：开页面 → 取快照 → 点「确认」→ 过一会儿才调 browser_dialog（用户已先答了）——
const toolTexts = (messages) =>
  messages
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
const pageIdOf = (messages) => {
  for (const t of [...toolTexts(messages)].reverse()) {
    const hit = /PAGE ID: ([a-z0-9]+) · HTTP/.exec(t);
    if (hit) return hit[1];
  }
  return "";
};
const confirmRefOf = (messages) => {
  let ref = "";
  for (const t of toolTexts(messages)) {
    const hit = /button "确认"[^\n]*\[ref=([^\]]+)\]/.exec(t);
    if (hit) ref = hit[1];
  }
  return ref;
};
const fake = await startFakeModel(
  [
    {
      tools: [
        {
          name: "bash",
          args: { command: `echo "ready on http://localhost:${sitePort}/"` },
        },
      ],
    },
    {
      tools: [
        { name: "browser_open", args: { target: `server:${sitePort}/` } },
      ],
    },
    {
      tools: [
        {
          name: "browser_snapshot",
          args: (messages) => ({ pageId: pageIdOf(messages), raw: true }),
        },
      ],
    },
    {
      tools: [
        {
          name: "browser_click",
          args: (messages) => ({
            pageId: pageIdOf(messages),
            ref: confirmRefOf(messages),
          }),
        },
      ],
    },
    {
      // 这一轮拖慢：看到点击结果之后，脚本有时间先替用户答掉
      delay: 1500,
      tools: [
        {
          name: "browser_dialog",
          args: (messages) => ({ pageId: pageIdOf(messages), accept: true }),
        },
      ],
    },
    { text: "处理完了。" },
  ],
  { delay: 20 },
);

const port = 19400 + Math.floor(Math.random() * 90);
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
      HOME: join(base, "home"),
      ...(agentChrome ? { YUANSHU_BROWSER: agentChrome } : {}),
    },
  },
);
proc.stdout.on("data", (b) => logs.push(b.toString()));
proc.stderr.on("data", (b) => logs.push(b.toString()));
mkdirSync(join(base, "home"), { recursive: true });

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
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  const ws = (
    await api("POST", "/workspaces", {
      name: "对话框",
      directories: [{ path: proj }],
    })
  ).json;
  const session = (await api("POST", "/sessions", { workspaceId: ws.id })).json;
  // 给 agent 发消息走会话的 WebSocket（界面上此刻是浏览器标签，不去找聊天输入框）
  const sock = new WebSocket(
    `ws://127.0.0.1:${port}/api/v1/sessions/${session.id}/stream`,
    ["yuanshu.v1"],
  );
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = rej;
  });
  const pagesOf = async () =>
    (await api("GET", `/workspaces/${ws.id}/browser`)).json.pages;
  const dialogPath = (pid) =>
    `/workspaces/${ws.id}/browser/pages/${pid}/dialog`;

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
      if (m.type() === "error" && !/status of 409/.test(m.text()))
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (!r.url().includes("/api/v1/") || r.status() < 400) return;
      problems.push(
        `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
      );
    });
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    const wb = page.locator(".ws-wb");
    const onCanvas = async (px, py) => {
      const b = await page.locator(".ws-wb-canvas").first().boundingBox();
      return { x: b.x + (px / 1280) * b.width, y: b.y + (py / 800) * b.height };
    };
    const clickAt = async (px, py) => {
      const at = await onCanvas(px, py);
      await page.mouse.click(at.x, at.y);
    };
    const titleNow = async () => (await pagesOf())[0]?.title ?? "";
    const modal = (name) => page.getByRole("dialog", { name });

    // —— 用户在界面里开页面（新页面一开始就是手动操作）——
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "对话框" }).click();
    await page.waitForSelector(".ws-pane");
    await sleep(600);
    await page.getByRole("button", { name: "新建标签页" }).first().click();
    await page.getByRole("menuitem", { name: /浏览器/ }).click();
    await wb.waitFor();
    await wb.getByRole("button", { name: "打开地址" }).click();
    const open = page.getByRole("dialog", { name: "浏览器页面" });
    await open.getByLabel("打开地址").fill(`server:${sitePort}/`);
    await open.getByRole("button", { name: "打开", exact: true }).click();
    await until(async () => (await titleNow()).startsWith("对话框站"), 20000);
    await until(() =>
      page.evaluate(() => {
        const c = document.querySelector(".ws-wb-canvas");
        return !!c && !c.hidden && c.width === 1280;
      }),
    );
    await sleep(500);

    // 1) alert
    await clickAt(280, 130);
    const alertBox = modal("页面提示");
    const shownAlert = await until(() =>
      alertBox.isVisible().catch(() => false),
    );
    check(
      "alert：弹出「页面提示」，写明来源站点与原文，只有「知道了」",
      !!shownAlert &&
        (await alertBox.getByText("已保存").count()) === 1 &&
        (await alertBox.textContent())?.includes("server.localhost") === true &&
        (await alertBox.getByRole("button", { name: "取消" }).count()) === 0,
    );
    await shot("dialog-alert");
    await alertBox.getByRole("button", { name: "知道了" }).click();
    check(
      "答了 alert：弹窗消失，页面 JS 继续（标题变成「已看过提示」）",
      !!(await until(async () => !(await alertBox.isVisible()))) &&
        !!(await until(async () => (await titleNow()) === "已看过提示")),
      await titleNow(),
    );

    // 2) confirm：取消 → false，确定 → true，Esc 等同取消
    const confirmBox = modal("页面请求确认");
    await clickAt(280, 230);
    await confirmBox.waitFor();
    check(
      "confirm：带多行原文",
      (await confirmBox.textContent())?.includes("删除后不能恢复") === true,
    );
    await shot("dialog-confirm");
    await confirmBox.getByRole("button", { name: "取消" }).click();
    check(
      "点「取消」：页面得到 false",
      !!(await until(async () => (await titleNow()) === "确认:false")),
      await titleNow(),
    );
    await clickAt(280, 230);
    await confirmBox.waitFor();
    await confirmBox.getByRole("button", { name: "确定" }).click();
    check(
      "点「确定」：页面得到 true",
      !!(await until(async () => (await titleNow()) === "确认:true")),
      await titleNow(),
    );
    await clickAt(280, 230);
    await confirmBox.waitFor();
    await page.keyboard.press("Escape");
    check(
      "Esc 等同取消：页面得到 false，弹窗不会又弹出来",
      !!(await until(async () => (await titleNow()) === "确认:false")) &&
        !(await until(() => confirmBox.isVisible().catch(() => false), 1200)),
      await titleNow(),
    );

    // 3) prompt：默认值 → 改成别的内容回车
    const promptBox = modal("页面请求输入");
    await clickAt(280, 330);
    await promptBox.waitFor();
    const input = promptBox.getByLabel("回答");
    check(
      "prompt：输入框带页面给的默认值",
      (await input.inputValue()) === "小明",
    );
    await shot("dialog-prompt");
    await input.fill("小红");
    await input.press("Enter");
    check(
      "prompt 回车：页面拿到输入「小红」",
      !!(await until(async () => (await titleNow()) === "名字:小红")),
      await titleNow(),
    );
    await sleep(300);

    // B) agent 点「确认」：用户先答，agent 随后的 browser_dialog 不重复回答
    sock.send(
      JSON.stringify({
        type: "send_message",
        id: "m1",
        text: "把确认按钮点一下。",
      }),
    );
    const sawResult = (text) =>
      fake.requests.some(
        (r) =>
          r.main &&
          (r.body.messages ?? []).some(
            (m) =>
              m.role === "tool" && JSON.stringify(m.content).includes(text),
          ),
      );
    const blocked = await until(() => sawResult("BLOCKED BY DIALOG"), 60000);
    check("agent 点击：立刻拿到 BLOCKED BY DIALOG 外壳（不卡）", !!blocked);
    const agentPage = (await pagesOf()).find((p) => p.dialog !== null);
    check(
      "页面状态里带着这个对话框（confirm 与原文）",
      agentPage?.dialog?.type === "confirm" &&
        agentPage.dialog.message.includes("确定删除吗？"),
      JSON.stringify(agentPage?.dialog),
    );
    if (!agentPage) throw new Error("没有找到挂着对话框的页面");
    const answered = await api("POST", dialogPath(agentPage.id), {
      accept: true,
    });
    check(
      "用户先答：接口 204",
      answered.status === 204,
      String(answered.status),
    );
    check(
      "页面 JS 继续：标题变成「确认:true」",
      !!(await until(
        async () =>
          (await pagesOf()).find((p) => p.id === agentPage.id)?.title ===
          "确认:true",
      )),
    );
    const refused = await until(() => sawResult("没有等待回答的对话框"), 60000);
    check(
      "agent 随后的 browser_dialog 得到「没有等待回答的对话框」，没有重复回答",
      !!refused,
    );
    const again = await api("POST", dialogPath(agentPage.id), { accept: true });
    check(
      "已经没有对话框时再答：409 no_dialog",
      again.status === 409 && again.json?.error === "no_dialog",
      JSON.stringify(again),
    );
    sock.close();

    check(
      "全程没有控制台报错、没有预期之外的失败请求",
      problems.filter((p) => !p.startsWith("409 POST")).length === 0,
      problems.slice(0, 3).join(" | "),
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
  await fake.close();
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
  `\n页面对话框：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
