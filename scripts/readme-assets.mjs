// 生成 README 配图（docs/assets/readme/*.png）：真 Server + 假模型剧本 + 真 Chromium 截图，不是 mock 页面。
//  workspace.png     工作区：对话 + 代码预览 + 终端平铺，agent 真的在演示项目里跑测试、改代码（1600×1000）
//  browser.png       浏览器标签：agent 用 browser_* 工具操作本机起的演示商店页面（1600×1000）
//  capabilities.png  设置 · 工具与能力 · 技能：技能库统一管理，有的对所有会话生效（1600×1025，1.25 倍屏）
//  mobile.png        手机端 /m/：会话列表（需要你）与带审批卡片的对话，两块手机屏合成一张图（1600×1000）
//  hosts.png         示意图：统一工具集经 SSH / SFTP 触达任意主机，HTML + CSS 渲染（1600×900）
// 每个场景各起一个真实 Server（随机端口，不碰 7431）与假模型，场景之间互不影响；数据都在固定的 /tmp/yuanshu-demo/ 下，
// HOME 就指到它（终端里的路径是 ~/webshop），每个场景开始时清空、结束时删除。env 只放行必要的变量，代理等本机配置不会带进界面。
// 演示项目、商店页面、技能、HTML 模板都在 scripts/readme-assets/；场景的剧本与布局写在本文件里。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
//   不联网、不需要真实模型。截图里本机特有的杂物（浏览器标签的缺 emoji 字体提示条）在场景里用样式藏掉。
// 用法：node scripts/readme-assets.mjs [名字...]   不带参数生成全部；名字取自上面五个（不带 .png）；全部约 1 分钟
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeModel } from "./lib/fake-model.mjs";
import { agentChromePath, chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "scripts/readme-assets");
const OUT = join(root, "docs/assets/readme");
const DEMO = "/tmp/yuanshu-demo";
// HOME 就是 DEMO：界面里的路径是 /tmp/yuanshu-demo/webshop，终端提示符里是 ~/webshop
const HOME = DEMO;
const PROJECT = join(HOME, "webshop");

for (const need of [
  "packages/server/dist/bin.js",
  "packages/server/web/index.html",
]) {
  if (!existsSync(join(root, need))) {
    console.error(
      `缺少 ${need}：先 pnpm build，并把 packages/web/dist 同步到 packages/server/web`,
    );
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询到条件成立或超时；返回最后一次的取值。 */
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(step);
    v = await fn();
  }
  return v;
}

// ───────────────────────── 演示环境 ─────────────────────────

/** 起着的 Server 进程：脚本中途出错或被 Ctrl-C 时也要收掉，不留孤儿。 */
const procs = new Set();
const killAll = () => {
  for (const p of procs) p.kill("SIGKILL");
};
process.on("SIGINT", () => {
  killAll();
  rmSync(DEMO, { recursive: true, force: true });
  process.exit(130);
});

const BASHRC = `export PS1='\\[\\e[38;5;71m\\]\\w\\[\\e[0m\\] \\$ '\n`;
const GITCONFIG = "[user]\n\tname = Demo\n\temail = demo@example.com\n";

/** 起一个演示环境：清空 /tmp/yuanshu-demo、起假模型与真 Server、配好供应商与权限档位。 */
async function startDemo({ script, aux, delay = 4, tier = "full" }) {
  rmSync(DEMO, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  writeFileSync(join(HOME, ".bashrc"), BASHRC);
  writeFileSync(join(HOME, ".gitconfig"), GITCONFIG);
  const fake = await startFakeModel(script ?? [{ text: "好的。" }], {
    delay,
    aux,
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const agentChrome = agentChromePath();
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
      join(DEMO, ".data"),
    ],
    {
      stdio: "ignore",
      cwd: HOME,
      // 只放行必要的环境变量：HOME 指到演示目录（不然会悄悄用上真实的 ~/.pi），代理变量不带进终端与 agent 的命令
      env: {
        PATH: process.env.PATH,
        HOME,
        USER: "demo",
        LOGNAME: "demo",
        SHELL: "/bin/bash",
        LANG: "C.UTF-8",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        // 测试失败时只留断言信息，不带绝对路径的调用栈
        NODE_OPTIONS: "--stack-trace-limit=0",
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
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
    if (r.status >= 300)
      throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  procs.add(proc);
  const stop = async () => {
    proc.kill("SIGTERM");
    // 全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
    await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
    if (proc.exitCode === null && proc.signalCode === null)
      proc.kill("SIGKILL");
    procs.delete(proc);
    await Promise.race([fake.close(), sleep(3000)]);
    rmSync(DEMO, { recursive: true, force: true });
  };
  try {
    const up = await until(
      async () => (await fetch(`${origin}/healthz`).catch(() => null))?.ok,
      60000,
      100,
    );
    if (!up) throw new Error("Server 60 秒内没有起来");
    await api("POST", "/providers", {
      name: "Demo",
      slug: "demo",
      api: "openai-completions",
      baseUrl: fake.baseUrl,
      apiKey: "x",
      models: [
        {
          id: "demo-pro",
          name: "demo-pro",
          reasoning: true,
          levels: ["off", "low", "high"],
          input: ["text"],
          ctx: 200000,
          out: 16000,
          source: "manual",
        },
      ],
    });
    await api("PUT", "/defaults", { permissionTier: tier });
  } catch (e) {
    await stop();
    throw e;
  }
  return { origin, api, fake, stop };
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** 演示项目：把 scripts/readme-assets/webshop 拷到 ~/webshop，提交成一个带 bug 的 git 仓库。 */
function seedProject() {
  cpSync(join(SRC, "webshop"), PROJECT, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: PROJECT,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME,
        GIT_AUTHOR_DATE: "2026-11-02T10:00:00+08:00",
        GIT_COMMITTER_DATE: "2026-11-02T10:00:00+08:00",
      },
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "feat(cart): add subtotal and coupon support");
}

async function newPage(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, ...opts });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) =>
    problems.push(`pageerror ${e.message.split("\n")[0]}`),
  );
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/v1/") && r.status() >= 400)
      problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return { ctx, page, problems };
}

const report = (name, problems) => {
  // 控制台报错与失败的接口请求会让截图带着「红字」，不拦着但要提醒
  const uniq = [...new Set(problems)];
  if (uniq.length) console.log(`  ! ${name} 过程中的异常：${uniq.join(" | ")}`);
};

/** 截图落盘到 docs/assets/readme，并报告大小。 */
async function saveShot(page, name, opts = {}) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  return file;
}

/** 建一个工作区（目录是 ~/<名字>）和它的几个会话（标题手动命名，会话是空的）；返回工作区与各会话 id。 */
async function newWorkspace(demo, name, titles) {
  const dir = join(HOME, name);
  mkdirSync(dir, { recursive: true });
  const ws = await demo.api("POST", "/workspaces", {
    name,
    directories: [{ path: dir }],
  });
  const sessions = [];
  for (const title of titles) {
    const { id } = await demo.api("POST", "/sessions", { workspaceId: ws.id });
    await demo.api("PATCH", `/sessions/${id}`, { title });
    sessions.push(id);
  }
  return { id: ws.id, sessions };
}

/** 演示项目 + 左轨：webshop（含当前会话）与另外两个工作区，看起来是在用的；返回 webshop 工作区与当前会话 id。 */
async function setupRail(demo, currentTitle) {
  seedProject();
  const ws = await newWorkspace(demo, "webshop", [
    "升级 Node 到 24",
    "给商品列表加分页",
    currentTitle,
  ]);
  await newWorkspace(demo, "docs-site", ["整理 API 文档目录"]);
  await newWorkspace(demo, "infra", ["排查 staging 构建变慢"]);
  return { ws, sid: ws.sessions[2] };
}

/** 布局文档里的一个窗格（主机固定是 Server 本机）。 */
const pane = (pid, tabs) => ({
  pid,
  host: tabs.some((t) => t.host) ? "server" : null,
  tabs,
  active: tabs[0].id,
});

/** 直接写工作区的布局文档（一个窗口，窗格树由调用方给）：比在界面里拖出同样的版式稳定。 */
async function putLayout(demo, workspaceId, root) {
  const { revision } = await demo.api(
    "GET",
    `/workspaces/${workspaceId}/layout`,
  );
  const firstPane = (n) => (n.children ? firstPane(n.children[0]) : n);
  await demo.api("PUT", `/workspaces/${workspaceId}/layout`, {
    baseRevision: revision,
    document: {
      version: 4,
      windows: {
        list: [{ id: "w1", root, focus: firstPane(root).pid }],
        active: 0,
      },
    },
  });
}

// ───────────────────────── 场景 ─────────────────────────

const scenes = {};

// 取页面 / 元素编号这类要在剧本里读上一步工具结果的小工具
const toolTexts = (messages) =>
  messages
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );

scenes.workspace = async (browser) => {
  const script = [
    {
      text: "先看一下购物车的实现，再跑一遍测试确认失败原因。",
      tools: [{ name: "read", args: { path: "src/cart.js" } }],
    },
    { tools: [{ name: "bash", args: { command: "npm test" } }] },
    {
      text: "找到了：`applyCoupon` 把 `percent`（折扣百分数，10 表示 9 折）当成小数直接去乘，10% 的券变成了减掉 10 倍小计。只需要除以 100。",
      tools: [
        {
          name: "edit",
          args: {
            path: "src/cart.js",
            edits: [
              {
                oldText: "return total - total * coupon.percent;",
                newText: "return total * (1 - coupon.percent / 100);",
              },
            ],
          },
        },
      ],
    },
    { tools: [{ name: "bash", args: { command: "npm test" } }] },
    {
      // 末轮放慢，页脚的 tok/s 才是个像样的数
      delay: 400,
      text: "修好了，6 个用例全部通过。\n\n- **原因**：`applyCoupon` 没把折扣百分数除以 100\n- **改动**：只改了这一行，没有动测试\n- **验证**：`npm test` 6 / 6 通过，`SPRING10` 现在得到 48.32（含运费 8）",
    },
  ];
  const demo = await startDemo({
    script,
    aux: () => "修复购物车优惠券计算",
  });
  const { page, ctx, problems } = await newPage(browser, {
    width: 1600,
    height: 1000,
  });
  try {
    const { ws, sid } = await setupRail(demo, "修复购物车优惠券计算");
    // 布局：左对话，右上预览刚改过的文件，右下终端
    await putLayout(demo, ws.id, {
      dir: "row",
      sizes: [50, 50],
      children: [
        pane("p1", [{ id: "t1", type: "chat", ctab: "chat", sid }]),
        {
          dir: "col",
          sizes: [55, 45],
          children: [
            pane("p2", [
              {
                id: "t2",
                type: "preview",
                host: "server",
                path: join(PROJECT, "src/cart.js"),
              },
              {
                id: "t4",
                type: "preview",
                host: "server",
                path: join(PROJECT, "test/cart.test.js"),
              },
            ]),
            pane("p3", [
              { id: "t3", type: "term", host: "server", cwd: PROJECT },
            ]),
          ],
        },
      ],
    });
    await page.goto(demo.origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "webshop" }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(1500);
    const box = page.locator("textarea").first();
    await box.fill("npm test 挂了两个用例，帮我查一下原因并修好。");
    await box.press("Enter");
    // 末轮结束：「本轮改动」那一行出现、停止按钮消失
    await page.getByText("本轮改动").waitFor({ timeout: 90000 });
    await sleep(1500);
    // 失败的那组默认展开（红字输出很长），收起来；改动的那组展开，看 diff
    await page
      .locator(".ch-group", { hasText: "npm test" })
      .first()
      .locator(".u-lrow")
      .first()
      .click();
    await page
      .locator(".ch-group", { hasText: "编辑了" })
      .locator(".u-lrow")
      .first()
      .click();
    await page
      .locator(".ch-group", { hasText: "编辑了" })
      .locator(".u-lrow")
      .nth(1)
      .click();
    await sleep(500);
    // 终端里跑一遍：清屏后 npm test
    await page.locator(".xterm").first().click();
    await page.keyboard.type("clear\n");
    await sleep(500);
    await page.keyboard.type("npm test\n");
    await page.getByText("duration").last().waitFor();
    // 预览要已经跟上 agent 的改动（文件监听刷新），不然图上的代码还是旧的
    await page.waitForFunction(
      () =>
        document
          .querySelector(".cm-content")
          ?.textContent?.includes("coupon.percent / 100"),
      null,
      { timeout: 15000 },
    );
    // 光标放在 agent 改过的那一行，当前行高亮把视线引过去
    await page
      .locator(".cm-line")
      .nth(12)
      .click({ position: { x: 400, y: 8 } });
    await sleep(600);
    await saveShot(page, "workspace");
  } finally {
    report("workspace", problems);
    await ctx.close();
    await demo.stop();
  }
};

scenes.browser = async (browser) => {
  // 演示商店：本机起一个静态页面；端口尽量用 5173（像个本地开发服务器），被占了就随机
  const storeHtml = readFileSync(join(SRC, "store.html"));
  const store = http.createServer((req, res) => {
    if (req.url !== "/" && !req.url.startsWith("/?")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(storeHtml);
  });
  const listen = (port) =>
    new Promise((ok, fail) => {
      store.once("error", fail);
      store.listen(port, "127.0.0.1", ok);
    });
  await listen(5173).catch(() => listen(0));
  const sitePort = store.address().port;

  // 元素编号从上一步的页面内容里取，两种写法都认：`button "名" [ref=e12]` 与 `e12 button "名"`
  const pageIdOf = (messages) => {
    for (const t of [...toolTexts(messages)].reverse()) {
      const hit = /PAGE ID: ([a-z0-9]+) · HTTP/.exec(t);
      if (hit) return hit[1];
    }
    return "";
  };
  const refOf = (name) => (messages) => {
    let ref = "";
    for (const t of toolTexts(messages)) {
      const hit =
        new RegExp(`"${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(t) ??
        new RegExp(`(e\\d+) [a-z]+ "${name}"`).exec(t);
      if (hit) ref = hit[1];
    }
    return ref;
  };
  const onPage = (name, extra) => ({
    name,
    args: (messages) => ({ pageId: pageIdOf(messages), ...extra(messages) }),
  });
  const script = [
    {
      text: "先确认演示商店已经在本机跑起来了。",
      tools: [
        {
          name: "bash",
          args: {
            command: `curl -s -o /dev/null -w "HTTP %{http_code}  http://localhost:${sitePort}/\\n" http://localhost:${sitePort}/`,
          },
        },
      ],
    },
    {
      text: "页面可以访问，打开看看。",
      tools: [
        { name: "browser_open", args: { target: `server:${sitePort}/` } },
      ],
    },
    { tools: [onPage("browser_snapshot", () => ({}))] },
    // 一轮一个工具：同一轮里的多个调用是并行的，连点同一个按钮会互相丢点击
    {
      text: "先加两件黑色 T 恤和一个软木杯垫。",
      tools: [
        onPage("browser_click", (m) => ({
          ref: refOf("加入购物车：黑色纯棉 T 恤")(m),
        })),
      ],
    },
    {
      tools: [
        onPage("browser_click", (m) => ({
          ref: refOf("加入购物车：黑色纯棉 T 恤")(m),
        })),
      ],
    },
    {
      tools: [
        onPage("browser_click", (m) => ({
          ref: refOf("加入购物车：软木杯垫")(m),
        })),
      ],
    },
    {
      text: "再填优惠券 SPRING10 并应用。",
      tools: [
        onPage("browser_type", (m) => ({
          ref: refOf("优惠券代码")(m),
          text: "SPRING10",
        })),
      ],
    },
    { tools: [onPage("browser_click", (m) => ({ ref: refOf("应用")(m) }))] },
    {
      // 末轮放慢，页脚的 tok/s 才是个像样的数
      delay: 700,
      text: "搞定。购物车里是 2 件黑色纯棉 T 恤和 1 个软木杯垫，用 SPRING10 立减 10% 后，合计 ¥48.32（含运费 ¥8）。",
    },
  ];
  const demo = await startDemo({
    script,
    aux: () => "在演示商店下单",
  }).catch(async (e) => {
    store.close();
    throw e;
  });
  const { page, ctx, problems } = await newPage(browser, {
    width: 1600,
    height: 1000,
  });
  try {
    const { ws, sid } = await setupRail(demo, "在演示商店下单");
    // 浏览器标签先摆进布局：agent 一开页面它就显示出来
    await putLayout(demo, ws.id, {
      dir: "row",
      sizes: [32, 68],
      children: [
        pane("p1", [{ id: "t1", type: "chat", ctab: "chat", sid }]),
        pane("p2", [{ id: "t2", type: "web" }]),
      ],
    });
    // 这台机器没有彩色 emoji 字体、浏览器沙盒也可能没开：对应的提示条是机器特有的杂物，不入镜（重载后也要藏）
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = ".ws-wb-strip { display: none !important; }";
        document.head.append(style);
      });
    });
    const enter = async () => {
      await page.goto(demo.origin);
      await page.waitForSelector(".sh-app");
      await page.locator(".rl-wh", { hasText: "webshop" }).click();
      await page.getByRole("log", { name: "对话记录" }).waitFor();
      // 收起左轨，把宽度让给画面
      await page.getByRole("button", { name: "收起左轨" }).click();
      await sleep(1500);
    };
    await enter();
    const box = page.locator("textarea").first();
    await box.fill(
      "在本机的演示商店里买 2 件黑色 T 恤和 1 个软木杯垫，用优惠券 SPRING10，告诉我合计多少。",
    );
    await box.press("Enter");
    await page.getByText("含运费 ¥8）。").waitFor({ timeout: 120000 });
    // 画面流偶尔没有首帧（画布是空白的）：等不到就重载页面，让它重新连上
    const painted = () =>
      page.evaluate(() => {
        const c = document.querySelector(".ws-wb-canvas");
        return !!c && c.toDataURL().length > 100000;
      });
    if (!(await until(painted, 12000))) {
      await enter();
      if (!(await until(painted, 12000)))
        throw new Error("浏览器画面一直是空白");
    }
    await sleep(1000);
    // 输入框发完消息后还留着焦点环，点一下窗口条的空白处
    await page.mouse.click(900, 18);
    await sleep(300);
    await saveShot(page, "browser");
  } finally {
    report("browser", problems);
    await ctx.close();
    await demo.stop();
    store.close();
  }
};

scenes.capabilities = async (browser) => {
  const demo = await startDemo({});
  // 1280×800 的版面、1.25 倍屏：截出来是 1600×1025，界面比 1600 宽的版面大一圈，缩小到 README 里仍然看得清
  const { page, ctx, problems } = await newPage(
    browser,
    { width: 1280, height: 820 },
    { deviceScaleFactor: 1.25 },
  );
  try {
    // 技能：从 ~/skills/<名> 用 dir 来源装进库；有的开「对所有会话生效」（全局，分发到本机），有的不开
    const GLOBAL = ["commit-helper", "code-review", "api-docs"];
    // 列表里后装的在上面：全局的最后装，排在最前
    const NAMES = [
      "sql-explain",
      "db-migration",
      "release-notes",
      "api-docs",
      "code-review",
      "commit-helper",
    ];
    for (const name of NAMES) {
      const dir = join(HOME, "skills", name);
      cpSync(join(SRC, "skills", name), dir, { recursive: true });
      await demo.api("POST", "/skills/install", {
        source: { kind: "dir", spec: dir },
      });
      if (GLOBAL.includes(name)) {
        await demo.api("PATCH", `/skills/${name}`, { scope: "global" });
        await demo.api("POST", `/skills/${name}/distribute`, {
          hostIds: ["local"],
        });
      }
    }
    // MCP 服务：只登记不检测，页签上有数量
    for (const [name, conf] of [
      [
        "docs-search",
        { command: "npx", args: ["-y", "@acme/docs-search-mcp"] },
      ],
      ["issue-tracker", { url: "https://mcp.example.com/issues" }],
    ])
      await demo.api("POST", "/mcp", {
        json: JSON.stringify({ mcpServers: { [name]: conf } }),
      });
    await page.goto(`${demo.origin}/settings/tools`);
    // 先看一眼 MCP 页签：数量要加载过才会标在页签上
    await page.getByRole("tab", { name: /^MCP/ }).click();
    await page.locator(".st-rail .u-lrow").first().waitFor();
    await page.getByRole("tab", { name: /^技能/ }).click();
    await page.locator(".st-rail .u-lrow").first().waitFor();
    await page.locator(".u-lrow-label", { hasText: /^commit-helper$/ }).click();
    await page.getByRole("article", { name: "commit-helper 详情" }).waitFor();
    await page.mouse.move(900, 790);
    await sleep(800);
    await saveShot(page, "capabilities");
  } finally {
    report("capabilities", problems);
    await ctx.close();
    await demo.stop();
  }
};

/** 通过会话的 WebSocket 发一条用户消息（跟界面发消息同一条路）；连接留着，由调用方在场景结束时关。 */
async function say(demo, sessionId, text) {
  const url = `${demo.origin.replace("http", "ws")}/api/v1/sessions/${sessionId}/stream`;
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`会话流连不上：${sessionId}`));
  });
  const acked = new Promise((ok, fail) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "ack" && m.id === "say")
        m.ok ? ok() : fail(new Error(JSON.stringify(m.error)));
    };
  });
  ws.send(JSON.stringify({ id: "say", type: "send_message", text }));
  await acked;
  return ws;
}

/** 两块手机屏合成一张图：浅色背景、圆角细边，排版在 mobile.html。 */
async function composeMobile(browser, left, right) {
  const uri = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
  const html = readFileSync(join(SRC, "mobile.html"), "utf8")
    .replace("{{LEFT}}", uri(left))
    .replace("{{RIGHT}}", uri(right));
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.waitForFunction(() =>
    [...document.images].every((i) => i.complete),
  );
  await saveShot(page, "mobile");
  await ctx.close();
}

scenes.mobile = async (browser) => {
  const SLOW =
    "先把现有列表接口读一遍，确认返回结构；然后加上 page 与 pageSize 两个参数，默认每页 12 件；前端换成分页器，保留筛选条件；最后补三个用例：第一页、末页、越界页。".repeat(
      6,
    );
  const script = [
    // C：已经做完的会话
    {
      text: "修好了，6 个用例全部通过。原因是 applyCoupon 没把折扣百分数除以 100，只改了这一行。",
    },
    // E：做完的会话
    {
      text: "排查完了：构建变慢是因为 CI 缓存的 key 带上了时间戳，每次都未命中。把 key 改成锁文件的哈希即可。",
    },
    // D：向用户提问
    {
      text: "docs 下有 31 篇文档，我想先确认整理的方式。",
      tools: [
        {
          name: "ask_user",
          args: {
            question: "API 文档想按什么方式整理？",
            options: ["按模块分组", "按版本分组", "保持现状，只修链接"],
          },
        },
      ],
    },
    // B：还在跑的会话（慢速输出，截图时仍在进行）
    { text: SLOW, delay: 250 },
    // A：先读文件，再要运行一条需要审批的命令
    {
      text: "先看看构建脚本怎么写的。",
      tools: [{ name: "read", args: { path: "package.json" } }],
    },
    {
      text: "再确认一下当前的提交。",
      tools: [{ name: "bash", args: { command: "git log --oneline -3" } }],
    },
    {
      text: "构建脚本没问题，提交也是最新的。接下来先构建，再把产物同步到 staging。",
      tools: [
        {
          name: "bash",
          args: {
            command: "npm run build && rsync -az dist/ staging:/srv/webshop/",
          },
        },
      ],
    },
  ];
  const demo = await startDemo({ script, tier: "rules" });
  const { page, ctx, problems } = await newPage(
    browser,
    { width: 390, height: 844 },
    {
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    },
  );
  const sockets = [];
  try {
    seedProject();
    const web = await newWorkspace(demo, "webshop", [
      "升级 Node 到 24",
      "修复购物车优惠券计算",
      "给商品列表加分页",
      "部署到 staging",
    ]);
    const docs = await newWorkspace(demo, "docs-site", [
      "补全 SDK 示例",
      "整理 API 文档目录",
    ]);
    const infra = await newWorkspace(demo, "infra", [
      "清理旧的构建产物",
      "排查 staging 构建变慢",
    ]);
    const [, fixId, pageId, deployId] = web.sessions;
    const steps = [
      [fixId, "npm test 挂了两个用例，帮我查一下原因并修好。"],
      [infra.sessions[1], "最近 staging 的构建比以前慢了一倍，帮忙排查一下。"],
      [docs.sessions[1], "把 docs 下的 API 文档按合适的方式整理一下。"],
      [pageId, "给商品列表加分页，每页 12 件。"],
      [deployId, "把最新构建部署到 staging。"],
    ];
    for (const [sid, text] of steps) {
      sockets.push(await say(demo, sid, text));
      await sleep(2500);
    }
    await page.goto(`${demo.origin}/m/`);
    await page.waitForSelector(".m-row");
    // 部署那个会话先后要两次审批：第一条（git log）批准掉，留下第二条（构建并同步）等用户
    await page.getByText("部署到 staging").first().click();
    await page.waitForSelector(".ch-approve");
    await page
      .locator(".ch-approve")
      .getByRole("button", { name: "批准" })
      .click();
    await page.locator(".ch-approve", { hasText: "rsync" }).waitFor();
    await sleep(1200);
    const chat = await page.screenshot();
    await page.goBack();
    await page.waitForSelector(".m-row");
    await page.locator(".m-scroll").evaluate((el) => {
      el.scrollTop = 0;
    });
    // 触摸后鼠标停在原处会让那一行显示悬停底色，挪到下面的空白处
    await page.mouse.move(200, 835);
    await sleep(1500);
    const list = await page.screenshot();
    await composeMobile(browser, list, chat);
  } finally {
    report("mobile", problems);
    for (const ws of sockets) ws.close();
    await ctx.close();
    await demo.stop();
  }
};

scenes.hosts = async (browser) => {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(SRC, "hosts.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await saveShot(page, "hosts");
  await ctx.close();
};

// ───────────────────────── 入口 ─────────────────────────

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(scenes);
const unknown = names.filter((n) => !scenes[n]);
if (unknown.length) {
  console.error(
    `未知的名字：${unknown.join(", ")}（可选：${Object.keys(scenes).join(", ")}）`,
  );
  process.exit(2);
}

const t0 = Date.now();
let failed = 0;
const browser = await chromium.launch({ channel: "chromium" });
try {
  for (const name of names) {
    const t = Date.now();
    try {
      await scenes[name](browser);
      const file = join(OUT, `${name}.png`);
      const size = existsSync(file) ? statSync(file).size : 0;
      console.log(
        `${name}: ${(size / 1024).toFixed(0)} KB, ${((Date.now() - t) / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      failed++;
      console.log(`${name}: 失败 — ${String(e?.stack ?? e).slice(0, 800)}`);
    }
  }
} finally {
  await browser.close();
  killAll();
  rmSync(DEMO, { recursive: true, force: true });
}
console.log(
  `完成：${names.length - failed}/${names.length}，${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
process.exit(failed ? 1 : 0);
