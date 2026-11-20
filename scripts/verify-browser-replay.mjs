// 浏览器回放的真机检查：起真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 假模型（按剧本真的调浏览器工具）
// + 本地假站点 + 无头 Chromium 当用户的浏览器，不需要真实模型。jsdom 测不出布局与图片加载，这里在真浏览器里量。
//  1) agent 做完一串动作（打开、点击、点输入框、输入、按键）后，浏览器标签的「回放」里有这些步，按时间线能翻
//  2) 版式：画面区 16:10、说明在下面一行、没有滚动条；控制行宽窗格一行、窄窗格（≤520px）两行，滑块始终有足够宽度
//  3) 翻步：上一步 / 下一步 / 滑块；画面真的换了（图片地址变、1280×800）；说明跟着变；说明里不出现输入的文字（画面是页面当时的样子，不遮）
//  4) 自动播放：点播放按间隔进步，到头自己停
//  5) 开回放时实时画面流断开、关回放后接回；开关随刷新保持
//  6) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-browser-replay.mjs [--shots 目录]
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
/** 轮询到条件成立或超时；返回最后一次的取值。 */
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(150);
    v = await fn();
  }
  return v;
}

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-replay-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(`${work}/proj`, { recursive: true });

// —— 假站点：每次点击 / 输入都让页面变个样子，回放里每一步的画面才不一样 ——
const SECRET = "my-secret-pw-1234";
const site = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`
    <!doctype html><title>回放站点</title>
    <style>body{margin:0;font:20px sans-serif;background:#fff}
    #go{position:fixed;left:100px;top:100px;width:200px;height:60px}
    #u{position:fixed;left:100px;top:200px;width:400px;height:40px;font-size:20px}
    #bar{position:fixed;left:0;bottom:0;height:60px;background:#0a7;transition:none}</style>
    <button id="go">点我</button><input id="u" aria-label="输入框"><div id="bar" style="width:0"></div>
    <script>
      let n = 0;
      const grow = () => { document.getElementById("bar").style.width = (++n * 240) + "px"; };
      document.getElementById("go").onclick = grow;
      document.getElementById("u").oninput = grow;
      addEventListener("keydown", grow);
    </script>`);
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;

// 取上一个工具结果里的页面编号：「PAGE ID: xxxxxx · HTTP …」
const pageIdOf = (messages) => {
  for (const m of [...messages].reverse()) {
    const text = JSON.stringify(m.content ?? "");
    const hit = /PAGE ID: ([a-z0-9]+) · HTTP/.exec(text);
    if (hit) return hit[1];
  }
  return "";
};
const onPage = (name, extra) => ({
  name,
  args: (messages) => ({ pageId: pageIdOf(messages), ...extra }),
});
const SCRIPT = [
  {
    // 先「启动服务」：命令输出里出现这个端口，之后 browser_open 才不用批准
    tools: [
      {
        name: "bash",
        args: { command: `echo "ready on http://localhost:${sitePort}/"` },
      },
    ],
  },
  {
    tools: [{ name: "browser_open", args: { target: `server:${sitePort}/` } }],
  },
  { tools: [onPage("browser_click", { x: 200, y: 130 })] },
  { tools: [onPage("browser_click", { x: 300, y: 220 })] },
  { tools: [onPage("browser_type", { text: SECRET })] },
  { tools: [onPage("browser_press", { key: "Tab" })] },
  { text: "做完了。" },
];
const fake = await startFakeModel(SCRIPT, { delay: 20 });

const port = 18500 + Math.floor(Math.random() * 90);
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
  {
    stdio: "ignore",
    cwd: work,
    env: {
      ...process.env,
      ...(agentChrome ? { YUANSHU_BROWSER: agentChrome } : {}),
    },
  },
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
        reasoning: false,
        levels: [],
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
        problems.push(
          `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
    });
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    // 1) 用界面建工作区、发一句话：假模型按剧本真的调浏览器工具
    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(`${work}/proj`);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);
    const box = page.locator("textarea").first();
    await box.fill("在浏览器里操作一下。");
    await box.press("Enter");

    // agent 开页面时浏览器标签会自动出现；等整串动作做完（回放里有 5 步）
    const wb = page.locator(".ws-wb");
    // 这个布局里浏览器窗格约 347px，工具条上的「回放」按钮已收进「…」菜单
    const toggleReplay = async () => {
      await wb.getByRole("button", { name: "更多操作" }).click();
      await page.getByRole("menuitem", { name: /回放/ }).click();
    };
    await wb.waitFor({ timeout: 60000 });
    const steps = async () => {
      const ws = await api("GET", "/workspaces");
      const wid = ws?.workspaces?.[0]?.id ?? ws?.[0]?.id;
      const r = await api("GET", `/workspaces/${wid}/browser/replay`);
      return r?.sessions?.[0]?.steps ?? 0;
    };
    check(
      "agent 做完 5 个动作：回放里存了 5 步",
      !!(await until(async () => (await steps()) >= 5, 60000)),
      `${await steps()} 步`,
    );
    await sleep(1500);

    // 2) 打开回放
    await shot("replay-0-before");
    await toggleReplay();
    const rp = page.getByRole("region", { name: "回放" });
    await rp.waitFor();
    const countText = () => rp.locator(".ws-wb-rp-count").innerText();
    /** 拖滑块：range 不支持 fill，用原生 setter 改值再发 input 事件（React 靠它拿到新值）。 */
    const seek = (v) =>
      rp.getByRole("slider", { name: "回放进度" }).evaluate((el, value) => {
        const set = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set;
        set.call(el, String(value));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, v);
    check(
      "打开回放：默认看这个会话最后一步，进度 5 / 5",
      !!(await until(async () => (await countText()) === "5 / 5")),
      await countText(),
    );
    const img = () =>
      page.evaluate(() => {
        const el = document.querySelector("img.ws-wb-canvas");
        return el
          ? { src: el.src, w: el.naturalWidth, h: el.naturalHeight }
          : null;
      });
    check(
      "画面是服务端存的 1280×800 的图",
      !!(await until(async () => (await img())?.w === 1280)),
      JSON.stringify(await img()),
    );
    const note = () => rp.locator(".ws-wb-rp-note").innerText();
    check(
      "说明写着最后一步的动作（按键 Tab）",
      (await note()).includes("按键 Tab"),
      (await note()).replace(/\n/g, " | "),
    );
    await shot("replay-1-last");

    // 3) 版式：一行控制、16:10 画面、没有滚动条
    const geo = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const bar = r(".ws-wb-rp-bar");
      const view = r(".ws-wb-rp .ws-wb-view");
      const stage = r(".ws-wb-rp .ws-wb-stage");
      const root = document.querySelector(".ws-wb");
      const barEl = document.querySelector(".ws-wb-rp-bar");
      const tops = new Set(
        [...(barEl?.children ?? [])].map((c) => {
          const b = c.getBoundingClientRect();
          return Math.round((b.top + b.height / 2) / 4); // 同一行的元素垂直居中，中心相差不到 4px
        }),
      );
      return {
        paneW: Math.round(root?.getBoundingClientRect().width ?? 0),
        rows: tops.size,
        sliderW: Math.round(r(".ws-wb-rp-slider")?.width ?? 0),
        inBar: [...(barEl?.children ?? [])].every((c) => {
          const b = c.getBoundingClientRect();
          return b.top >= bar.top - 1 && b.bottom <= bar.bottom + 1;
        }),
        ratio: view ? view.width / view.height : 0,
        inside:
          !!view &&
          !!stage &&
          view.left >= stage.left - 1 &&
          view.right <= stage.right + 1 &&
          view.top >= stage.top - 1 &&
          view.bottom <= stage.bottom + 1,
        overflowX: root ? root.scrollWidth > root.clientWidth : true,
        overflowY: root ? root.scrollHeight > root.clientHeight : true,
      };
    });
    // 窄窗格（≤520px，三窗格的默认布局）两行，宽窗格一行；两种情况滑块都要有足够的宽度可拖
    const rowsOk = geo.paneW <= 520 ? geo.rows === 2 : geo.rows === 1;
    check(
      "版式：控制行按窗格宽度分一行 / 两行、都在条内；滑块 ≥ 120 宽；画面 16:10 在舞台内；没有滚动条",
      rowsOk &&
        geo.inBar &&
        geo.sliderW >= 120 &&
        Math.abs(geo.ratio - 1.6) < 0.02 &&
        geo.inside &&
        !geo.overflowX &&
        !geo.overflowY,
      JSON.stringify(geo),
    );

    // 4) 翻步
    const last = await img();
    await rp.getByRole("button", { name: "上一步" }).click();
    check(
      "上一步：进度 4 / 5，说明与画面都换了",
      !!(await until(async () => {
        const now = await img();
        return (await countText()) === "4 / 5" && now && now.src !== last?.src;
      })),
      `${await countText()} | ${(await note()).replace(/\n/g, " | ")}`,
    );
    await seek("0");
    check(
      "拖滑块到最前：进度 1 / 5，说明是「打开」那一步",
      !!(await until(async () => (await countText()) === "1 / 5")) &&
        (await note()).includes("打开"),
      (await note()).replace(/\n/g, " | "),
    );
    await shot("replay-2-first");
    const allNotes = [];
    for (let i = 0; i < 5; i++) {
      await seek(String(i));
      await until(async () => (await countText()) === `${i + 1} / 5`);
      allNotes.push(await note());
    }
    check(
      "说明里不出现输入的文字，只有字数",
      !allNotes.join("").includes(SECRET) &&
        allNotes.join("").includes(`${SECRET.length} 字`),
      allNotes.map((n) => n.split("\n")[0]).join(" | "),
    );
    // 第 3 步是点输入框、第 4 步是输入：画面里进度条（站点每次操作加长）一步比一步长，图一张张都不同
    const srcs = [];
    for (let i = 0; i < 5; i++) {
      await seek(String(i));
      await until(async () => (await countText()) === `${i + 1} / 5`);
      await until(async () => (await img())?.w === 1280);
      srcs.push((await img())?.src);
    }
    check(
      "5 步的画面是 5 张不同的图",
      new Set(srcs).size === 5,
      `${new Set(srcs).size} 张`,
    );

    // 5) 自动播放：从第 1 步开始，播到头自己停
    await seek("2");
    await rp.getByRole("button", { name: "播放" }).click();
    check(
      "自动播放：隔一会儿进一步",
      !!(await until(async () => (await countText()) === "4 / 5", 6000)),
      await countText(),
    );
    check(
      "播到最后一步自己停（按钮换回「播放」）",
      !!(await until(
        async () =>
          (await countText()) === "5 / 5" &&
          (await rp.getByRole("button", { name: "播放" }).count()) === 1,
        8000,
      )),
      await countText(),
    );

    // 6) 开回放时实时画面流断开，关回放接回；开关随刷新保持
    await toggleReplay();
    check(
      "关回放：实时画面回来",
      !!(await until(async () =>
        page.evaluate(() => {
          const c = document.querySelector("canvas.ws-wb-canvas");
          return !!c && !c.hidden && c.width === 1280;
        }),
      )),
    );
    await toggleReplay();
    await rp.waitFor();
    await sleep(1500); // 标签视图状态有防抖
    await page.reload();
    await page.waitForSelector(".ws-pane");
    check(
      "刷新页面：回放仍开着",
      !!(await until(
        async () =>
          (await page.getByRole("region", { name: "回放" }).count()) === 1,
      )),
    );

    // 7) 窗口变窄（600 宽）：窗格宽度变了，控制行跟着换行数，仍然不溢出、滑块仍可拖
    await page.setViewportSize({ width: 600, height: 800 });
    await sleep(500);
    const narrow = await page.evaluate(() => {
      const root = document.querySelector(".ws-wb");
      const bar = document.querySelector(".ws-wb-rp-bar");
      const b = bar?.getBoundingClientRect();
      const tops = new Set(
        [...(bar?.children ?? [])].map((c) => {
          const r = c.getBoundingClientRect();
          return Math.round((r.top + r.height / 2) / 4);
        }),
      );
      return {
        paneW: Math.round(root?.getBoundingClientRect().width ?? 0),
        rows: tops.size,
        overflowX: root ? root.scrollWidth > root.clientWidth : true,
        sliderW: Math.round(
          document.querySelector(".ws-wb-rp-slider")?.getBoundingClientRect()
            .width ?? 0,
        ),
        inBar:
          !!bar &&
          !!b &&
          [...bar.children].every((c) => {
            const r = c.getBoundingClientRect();
            return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
          }),
      };
    });
    check(
      "窗口变窄（600 宽）：控制行仍在条内、没有横向滚动、滑块 ≥ 120 宽",
      narrow.inBar && !narrow.overflowX && narrow.sliderW >= 120,
      JSON.stringify(narrow),
    );
    await shot("replay-3-narrow");
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
  site.close();
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
if (crashed)
  console.log(
    `脚本异常：${String(crashed.stack ?? crashed.message)
      .split("\n")
      .slice(0, 6)
      .join(" | ")}`,
  );
const failed = results.filter((x) => !x).length + (crashed ? 1 : 0);
console.log(
  `\n浏览器回放：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
