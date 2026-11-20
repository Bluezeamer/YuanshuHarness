// chat 区（对话流）的真机检查：起真实 Server（临时数据目录）+ 假模型（按剧本回答）+ 无头 Chromium，不需要真实模型。
//  1) 运行中：思考与工具参数只露一行淡色预览（类型标签 + 最新一行），没有光标
//  2) 审批卡：琥珀描边、命令块、批准是唯一的实心按钮；批准后收成一行「已批准」
//  3) 工具分组：相邻同类折成一组一行摘要（读取了 N 个文件 / 运行了 N 条命令 / 编辑了 N 个文件），成功的组默认折叠
//  4) 出错的组默认展开，失败那一行下面是红字输出
//  5) 点开组看每一行（行数 / 增删行），点 write 行看代码块
//  6) 用户消息是右对齐灰底气泡；阅读列最宽 720
//  7) 输入栏：工具行是 附件 · 审批 …… 模型与档位 · 发送；审批可点开切档；模型按钮合并了推理档位
//  8) 斜杠菜单：空输入框按 / 调出，分「命令 / 技能 / MCP」三组
//  9) 页脚：输入卡下面一条分割线 + 居中一行 工作位置（只有主机色圆点）· tok/s · 读条 · 缓存，悬停出小卡；审计页里仍在
// 10) 排队消息：运行中再发的话，是输入卡上方靠右的虚线气泡，不在对话流里
// 11) 左缘导航：每条用户指令一格线，悬停整块展开（离开才收），线长按正态分布，悬停某条出完整内容卡，点击定位并高亮
// 12) 右侧状态：宽时常驻一栏（目标 / 计划 / 团队 / 工作流 / 子代理 / 已加载能力，宽 232），窄时竖排文字标签、悬停向左展开；
//     子代理树按「结束满 10 分钟折起来」的规则收「已结束 N 个」，可切「全部」、点开展开
// 13) 窗格头：没有对话头（标题不重复）；标签条右端是「审计 N」，进审计后换成「← 对话」，页脚两个视图共用；
//     审计页里：左栏是汇总 + 类型下拉 + 搜索 + 标准行（悬停出详情卡），右栏是组成条与五张卡片（全部展开 / 收起、JSON 视图）
// 14) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-chat.mjs [--shots 目录]
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
const base = mkdtempSync(join(root, "tmp", "chat-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "notes.md"), "# 记录\n\n- 周一\n- 周二\n");
writeFileSync(join(work, "b.md"), "第二份\n");

// 剧本：读两个文件（思考慢速流出）→ 失败的命令 → 写一个文件再改它 → 需要审批的命令 → 收尾
const SCRIPT = [
  {
    thinking: "先看看有哪些文件，\n再读 notes.md 和 b.md",
    tools: [
      { name: "read", args: { path: "notes.md" } },
      { name: "read", args: { path: "b.md" } },
    ],
  },
  { tools: [{ name: "bash", args: { command: "cat missing.txt" } }] },
  {
    tools: [
      {
        name: "write",
        args: { path: "hello.ts", content: "const a = 1;\nconsole.log(a);\n" },
      },
      {
        name: "edit",
        args: {
          path: "hello.ts",
          edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
        },
      },
    ],
  },
  {
    tools: [
      {
        name: "bash",
        args: { command: "mkdir -p out && echo hi > out/a.txt" },
      },
    ],
  },
  {
    tools: [
      {
        name: "todo_write",
        args: {
          todos: [
            { content: "读文件", status: "completed" },
            { content: "改实现", status: "in_progress" },
            { content: "跑测试", status: "pending" },
          ],
        },
      },
    ],
  },
  { text: "全部完成。" },
];
const fake = await startFakeModel(SCRIPT, { delay: 60 });

const port = 18100 + Math.floor(Math.random() * 90);
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

    // 子代理树：假模型不方便造出嵌套的子代理，拦下执行体清单换成一棵各种状态的树（其余接口走真服务）
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const sub = (id, parentId, over = {}) => ({
      id,
      parentId,
      depth: parentId === "ROOT" ? 1 : 2,
      source: "task",
      member: null,
      run: null,
      name: `任务 ${id}`,
      role: "编码",
      model: "fake",
      state: "done",
      outcome: "ok",
      result: null,
      ctx: { used: 12000, win: 32000 },
      tools: ["read"],
      since: ago(90),
      ended: ago(30),
      task: `做 ${id}`,
      log: [],
      ...over,
    });
    let fakeTree = false;
    await page.route(/\/api\/v1\/sessions\/[^/]+\/flows$/, async (route) => {
      const real = await route.fetch();
      if (!fakeTree) return route.fulfill({ response: real });
      const root = route.request().url().split("/sessions/")[1].split("/")[0];
      const fix = (x) => ({
        ...x,
        parentId: x.parentId === "ROOT" ? root : x.parentId,
      });
      await route.fulfill({
        response: real,
        json: {
          executions: [
            sub("a1", "ROOT", {
              state: "run",
              outcome: null,
              ended: null,
              since: ago(3),
            }),
            sub("a2", "a1", { ended: ago(40) }),
            sub("b1", "ROOT", { ended: ago(30) }),
            sub("b2", "ROOT", { ended: ago(2) }),
            sub("b3", "ROOT", { outcome: "failed", ended: ago(60) }),
            // 团队成员与工作流 agent：不进子代理树，各有自己的块
            sub("m1", "ROOT", {
              source: "team",
              member: "小王",
              role: "编码",
              state: "run",
              outcome: null,
              ended: null,
              since: ago(2),
            }),
            sub("w1", "ROOT", {
              source: "workflow",
              run: { id: "r1", phase: "查" },
            }),
            sub("w1-kid", "w1"),
          ].map(fix),
          workflow: [
            {
              id: "r1",
              label: "代码审查",
              state: "run",
              since: ago(5),
              ended: null,
              phases: [
                { name: "查", run: 0, done: 6, failed: 1, queued: 0 },
                { name: "写", run: 3, done: 2, failed: 0, queued: 9 },
              ],
              started: 12,
              limit: 1000,
            },
          ],
        },
      });
    });

    // 团队的公告板与改动清单：同样拦成假数据；公告板文件用工作目录里真实存在的 notes.md
    await page.route(/\/api\/v1\/sessions\/[^/]+\/team$/, async (route) => {
      if (!fakeTree) return route.continue();
      await route.fulfill({
        json: {
          board: {
            file: join(work, "notes.md"),
            count: 7,
            recent: [
              {
                no: 5,
                time: "10:01",
                from: "小王",
                to: "all",
                text: "接口改好了",
              },
              { no: 6, time: "10:02", from: "lead", to: "all", text: "继续" },
            ],
          },
          changes: {
            mode: "git",
            total: 2,
            files: [
              { path: "src/a.ts", status: "modified", added: 12, removed: 3 },
              { path: "docs/n.md", status: "added", added: 40, removed: 0 },
            ],
          },
        },
      });
    });
    await page.route(
      /\/api\/v1\/sessions\/[^/]+\/team\/diff/,
      async (route) => {
        await route.fulfill({
          json: {
            path: "src/a.ts",
            diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n keep\n+added line\n tail\n",
          },
        });
      },
    );

    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(work);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);

    const box = page.locator("textarea").first();
    await box.fill("读两个文件，再试几件事。");
    await box.press("Enter");

    // 1) 运行中的一行预览：轮询，看到思考 / 工具的一行预览就记下来
    const seen = { thinking: "", tool: "", caretWithLive: false };
    const approve = page.locator(".ch-approve");
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && !(await approve.count())) {
      const live = await page.evaluate(() => {
        const el = document.querySelector(".ch-live");
        return el
          ? {
              k: el.querySelector(".ch-live-k")?.textContent ?? "",
              t: el.querySelector(".ch-live-t")?.textContent ?? "",
              caret: !!document.querySelector(".ch-caret"),
            }
          : null;
      });
      if (live) {
        if (live.k === "思考") seen.thinking = live.t || seen.thinking;
        else if (live.t) seen.tool = `${live.k}: ${live.t}`;
        if (live.caret) seen.caretWithLive = true;
      }
      await sleep(40);
    }
    check(
      "运行中：思考只露一行预览（最新一行）",
      seen.thinking !== "",
      seen.thinking,
    );
    check("运行中：工具参数 / 输出只露一行预览", seen.tool !== "", seen.tool);
    check("有一行预览时没有光标", !seen.caretWithLive);

    // 2) 审批卡
    await approve.waitFor({ timeout: 30000 });
    await sleep(300);
    const card = await approve.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        border: cs.borderTopColor,
        bg: cs.backgroundColor,
        text: el.textContent ?? "",
        primary: el.querySelectorAll('[data-variant="primary"]').length,
        buttons: [...el.querySelectorAll("button")].map((b) => b.textContent),
      };
    });
    await shot("1-approval");
    check(
      "审批卡：命令块 + 批准 / 拒绝，批准是唯一的实心按钮",
      card.text.includes("mkdir -p out") &&
        card.buttons.includes("批准") &&
        card.buttons.includes("拒绝") &&
        card.primary === 1,
      JSON.stringify(card.buttons),
    );
    check(
      "审批卡：描边是琥珀、不铺底",
      card.border !== "rgba(0, 0, 0, 0)" &&
        (card.bg === "rgba(0, 0, 0, 0)" || card.bg === "rgb(255, 255, 255)"),
      `${card.border} / ${card.bg}`,
    );
    // 10) 排队：停在审批上时模型还在跑，再发一句
    await box.fill("排队的这一句");
    await box.press("Enter");
    const queue = page.locator(".ch-queue");
    await queue.waitFor({ timeout: 10000 });
    await sleep(300);
    const q = await queue.evaluate((el) => {
      const bubble = el.querySelector(".ch-q");
      const b = bubble?.getBoundingClientRect();
      const box = document.querySelector(".ch-box")?.getBoundingClientRect();
      const cs = bubble ? getComputedStyle(bubble) : null;
      return {
        text: el.textContent ?? "",
        dashed: cs?.borderTopStyle,
        above: !!(b && box && b.bottom <= box.top),
        right: !!(b && box && Math.abs(b.right - box.right) <= 2),
        inStream: !!document
          .querySelector(".ch-stream")
          ?.textContent?.includes("排队的这一句"),
      };
    });
    await shot("0-queue");
    check(
      "排队消息：输入卡上方、靠右、虚线气泡，不在对话流里",
      q.dashed === "dashed" && q.above && q.right && !q.inStream,
      JSON.stringify(q),
    );
    check(
      "排队提示：「排队 N 条 · 当前步骤结束后送达」",
      /排队 1 条 · 当前步骤结束后送达/.test(q.text) &&
        q.text.includes("排队的这一句"),
    );

    await approve.getByRole("button", { name: "批准", exact: true }).click();
    await page
      .locator('.ch-settled[data-state="approved"]')
      .waitFor({ timeout: 20000 });
    check("批准后收成一行「已批准」", true);

    // 等对话收尾
    await page.getByText("全部完成。").waitFor({ timeout: 60000 });
    await sleep(800);
    await shot("2-done");

    // 3) 分组
    const labels = await page.$$eval(".ch-group", (gs) =>
      gs
        .map((g) => g.querySelector(".ch-glabel")?.textContent ?? "")
        .filter((t) => !t.startsWith("本轮改动")),
    );
    // 收起的组头跟着第一行的命令 / 路径预览（失败的组默认展开，各行自己写着，不带预览）
    const hints = await page.$$eval(".ch-group", (gs) =>
      gs
        .filter((g) => !(g.textContent ?? "").startsWith("本轮改动"))
        .map(
          (g) =>
            g.querySelector(":scope > .u-lrow .ch-arg")?.textContent ?? null,
        ),
    );
    check(
      "收起的组头跟着第一行的预览（多条补 +N）",
      hints[0] === "notes.md  +1" &&
        hints[3] === "mkdir -p out && echo hi > out/a.txt",
      JSON.stringify(hints),
    );
    check(
      "相邻同类折成一组，一组一行摘要",
      JSON.stringify(labels) ===
        JSON.stringify([
          "读取了 2 个文件",
          "运行了 1 条命令",
          "编辑了 2 个文件",
          "运行了 1 条命令",
          "调用了 todo_write",
        ]),
      JSON.stringify(labels),
    );
    const groups = page.locator(".ch-group");
    const rowsOf = (i) => groups.nth(i).locator(".ch-row");
    check("成功的组默认折叠", (await rowsOf(0).count()) === 0);
    check("出错的组默认展开", (await rowsOf(1).count()) === 1);

    // 4) 失败那一行下面是红字输出
    const err = groups.nth(1).locator('.ch-out[data-kind="error"]');
    const errInfo = await err.evaluate((el) => ({
      text: el.textContent ?? "",
      color: getComputedStyle(el).color,
    }));
    check(
      "失败的行下面是红字输出",
      errInfo.text.includes("No such file") &&
        errInfo.color !== "rgb(24, 24, 27)",
      `${errInfo.color} ${errInfo.text.slice(0, 40)}`,
    );

    // 5) 点开组看每一行；点 write 行看代码块
    await groups.nth(0).locator(".u-lrow-main").first().click();
    const readTrail = await rowsOf(0).locator(".ch-trail").allTextContents();
    check(
      "点开读取组：每行带行数",
      (await rowsOf(0).count()) === 2 &&
        readTrail.every((t) => /\d+ 行/.test(t)),
      readTrail.join(" / "),
    );
    await groups.nth(2).locator(".u-lrow-main").first().click();
    await rowsOf(2).first().locator(".u-lrow-main").click();
    await sleep(500);
    const block = await rowsOf(2).first().locator(".md-block").textContent();
    check("点 write 行看代码块", (block ?? "").includes("console.log"));
    await shot("3-opened");

    // 7) 输入栏
    const bar = await page.evaluate(() => {
      const row = document.querySelector(".ch-toolrow");
      const box = document.querySelector(".ch-box")?.getBoundingClientRect();
      const names = [...(row?.children ?? [])].map(
        (el) =>
          el.getAttribute("aria-label") ?? el.className.toString().slice(0, 20),
      );
      const cs = (sel) => {
        const e = document.querySelector(sel);
        return e ? getComputedStyle(e) : null;
      };
      return {
        names,
        modelText: document.querySelector("[data-modelpick]")?.textContent,
        permText: document.querySelector("[data-permpick]")?.textContent,
        boxBorder: cs(".ch-box")?.borderTopWidth,
        boxW: box?.width ?? 0,
        mcp: !!document.querySelector("[data-mcppick]"),
        slashBtn: !!document.querySelector("[data-slash]"),
      };
    });
    check(
      "工具行：附件 · 审批 …… 模型 · 发送；没有 MCP 与 / 按钮",
      bar.names.length >= 4 &&
        bar.names[0]?.includes("上传文件") &&
        bar.names.at(-1) === "发送" &&
        !bar.mcp &&
        !bar.slashBtn,
      JSON.stringify(bar.names),
    );
    check(
      "审批按钮写「审批 · 档位」，模型按钮带档位",
      /^审批 · /.test(bar.permText ?? "") && /fake/.test(bar.modelText ?? ""),
      `${bar.permText} | ${bar.modelText}`,
    );
    await page.locator("[data-permpick]").click();
    const permPop = page.getByRole("dialog", { name: "审批档位" });
    await permPop.waitFor();
    await sleep(400);
    await shot("4-perm-menu");
    const tiers = await permPop
      .locator("[data-perm-tier]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-perm-tier")));
    check(
      "审批菜单四项：跟随全局 / 规则 / 模型 / 通过",
      JSON.stringify(tiers) ===
        JSON.stringify(["null", "rules", "auto", "full"]),
      JSON.stringify(tiers),
    );
    await permPop.locator('[data-perm-tier="full"] button').click();
    await page.waitForFunction(
      () => document.querySelector("[data-permname]")?.textContent === "通过",
    );
    check("选「通过」立即生效", true);

    await page.locator("[data-modelpick]").click();
    const modelPop = page.getByRole("dialog", { name: "选择模型" });
    await modelPop.waitFor();
    await sleep(400);
    await shot("5-model-menu");
    check(
      "模型选单底部有推理强度",
      (await modelPop.getByRole("radio").count()) >= 2,
    );
    await page.keyboard.press("Escape");

    // 8) 斜杠菜单
    await box.fill("");
    await box.press("/");
    const slashPop = page.getByRole("dialog", { name: "快捷命令与技能" });
    await slashPop.waitFor();
    await sleep(300);
    await shot("6-slash");
    const heads = await slashPop.locator(".ch-slash-h").allTextContents();
    check(
      "斜杠菜单分「命令 / 技能 / MCP」三组（有内容的才出现）",
      heads[0] === "命令" &&
        heads.every((h) => ["命令", "技能", "MCP"].includes(h)),
      JSON.stringify(heads),
    );
    const inView = await slashPop.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0;
    });
    check("斜杠菜单完整落在视口内", inView);
    await box.press("Escape");
    await slashPop.waitFor({ state: "detached" });

    // 9) 页脚
    const foot = await page.evaluate(() => {
      const f = document.querySelector(".ch-foot");
      const b = document.querySelector(".ch-box")?.getBoundingClientRect();
      const r = f?.getBoundingClientRect();
      const m = document.querySelector(".ch-main")?.getBoundingClientRect();
      const cs = f ? getComputedStyle(f) : null;
      return {
        text: (f?.textContent ?? "").replace(/\s+/g, " ").trim(),
        below: !!(r && b && r.top >= b.bottom),
        centered:
          !!(r && m) &&
          Math.abs(r.left + r.width / 2 - (m.left + m.width / 2)) < 2,
        border: cs?.borderTopWidth,
        meter: !!f?.querySelector('[role="meter"]'),
        h: r?.height,
      };
    });
    check(
      "页脚：输入卡下面、整行居中、上面一条分割线",
      foot.below && foot.centered && foot.border === "1px",
      JSON.stringify(foot),
    );
    check(
      "页脚内容：tok/s · 读条 · 缓存",
      /tok\/s/.test(foot.text) && foot.meter && /缓存/.test(foot.text),
      foot.text,
    );
    // agent 工作位置：最前面一项，只有主机色圆点（主机名与目录在悬停卡片里）
    const place = await page.evaluate(() => {
      const el = document.querySelector('.ch-foot [data-foot="place"]');
      const first = document.querySelector(".ch-foot")?.firstElementChild;
      const dot = el?.querySelector(".ch-foot-dot");
      return {
        text: (el?.textContent ?? "").trim(),
        first: !!el && !!first && first.contains(el),
        dot: dot ? getComputedStyle(dot).backgroundColor : "",
      };
    });
    check(
      "页脚最前面是工作位置：只有一枚主机色圆点，圆点旁没有文字",
      place.first && place.text === "" && /^rgb|^oklch|^color/.test(place.dot),
      JSON.stringify(place),
    );
    const item = page.locator('.ch-foot [data-foot="context"]');
    await item.hover();
    const tip = page.getByRole("tooltip");
    await tip.waitFor({ timeout: 3000 });
    await shot("7-foot-card");
    const cardW = await tip.evaluate((el) => el.getBoundingClientRect().width);
    check(
      "悬停出小卡，宽 216，内容是只读的",
      Math.abs(cardW - 216) <= 2 &&
        (await tip.getByRole("button").count()) === 0,
      `${Math.round(cardW)}`,
    );
    await page.mouse.move(5, 5);

    // 标签缩放：Ctrl+滚轮只放大这个标签里要读的字（正文、代码），外壳字不动；点角标回 100%
    const sizes = () =>
      page.evaluate(() => ({
        read: parseFloat(
          getComputedStyle(document.querySelector(".ch-md") ?? document.body)
            .fontSize,
        ),
        shell: parseFloat(
          getComputedStyle(document.querySelector(".ch-foot .t-aux")).fontSize,
        ),
      }));
    const before = await sizes();
    await page.mouse.move(600, 300);
    await page.keyboard.down("Control");
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -100);
      await sleep(80);
    }
    await page.keyboard.up("Control");
    await sleep(200);
    const zoomed = await sizes();
    const zoomBadge = page.getByRole("button", { name: /^1[0-9]{2}%$/ });
    check(
      "Ctrl+滚轮：正文字号放大，外壳字不动，窗格右上角出现比例角标",
      zoomed.read > before.read * 1.2 &&
        zoomed.shell === before.shell &&
        (await zoomBadge.count()) === 1,
      JSON.stringify([before, zoomed]),
    );
    await zoomBadge.click();
    await sleep(200);
    const back = await sizes();
    check("点角标：回到 100%", back.read === before.read, JSON.stringify(back));
    await page.mouse.move(5, 5);

    // 11) 左缘导航
    const ticksN = await page.locator("[data-chat-nav] [data-nav]").count();
    check(
      "左缘导航：一条用户指令一格线（本剧本里只有 2 条）",
      ticksN === 2,
      `${ticksN}`,
    );
    const navBox = await page.evaluate(() => {
      const n = document.querySelector(".ch-nav")?.getBoundingClientRect();
      const ticks = [...document.querySelectorAll(".ch-nav .ch-tick")].map(
        (t) => t.getBoundingClientRect().height,
      );
      const main = document.querySelector(".ch-main")?.getBoundingClientRect();
      return {
        w: Math.round(n?.width ?? 0),
        left: Math.round((n?.left ?? 0) - (main?.left ?? 0)),
        rows: ticks,
        sticky: !!document.querySelector("[data-chat-instruction]"),
        oldJump: !!document.querySelector("[data-chat-quickjump]"),
      };
    });
    check(
      "折叠态：40 宽、贴左缘 4、每行 28；旧的置顶条与 ☰ 都没了",
      navBox.w === 40 &&
        navBox.left === 4 &&
        navBox.rows.every((h) => h === 28) &&
        !navBox.sticky &&
        !navBox.oldJump,
      JSON.stringify(navBox),
    );
    const m0 = await page
      .locator(".ch-nav .ch-tick-mark")
      .first()
      .boundingBox();
    await page.locator(".ch-nav").hover();
    await sleep(500);
    await page.locator("[data-chat-nav] [data-nav='0']").hover();
    await sleep(400);
    const open = await page.evaluate(() => {
      const nav = document.querySelector(".ch-nav");
      const r = nav?.getBoundingClientRect();
      const marks = [...document.querySelectorAll(".ch-tick-mark")].map(
        (m) => m.getBoundingClientRect().width,
      );
      const lefts = [...document.querySelectorAll(".ch-nav-text")].map((t) =>
        Math.round(t.getBoundingClientRect().left),
      );
      return {
        open: nav?.hasAttribute("data-expanded"),
        w: Math.round(r?.width ?? 0),
        marks,
        aligned: new Set(lefts).size === 1,
        textShown: [...document.querySelectorAll(".ch-nav-text")].every(
          (t) => getComputedStyle(t).opacity === "1",
        ),
      };
    });
    await shot("8-nav-open");
    check(
      "悬停展开：宽 180，文字对齐在同一列，鼠标所在那条线最长",
      open.open &&
        open.w === 180 &&
        open.aligned &&
        open.textShown &&
        open.marks[0] === 28 &&
        (open.marks[1] ?? 99) < 28,
      JSON.stringify(open),
    );
    check(
      "线条原地不动：展开前后第一条线的左端位置不变",
      m0 !== null &&
        Math.abs(
          ((await page.locator(".ch-nav .ch-tick-mark").first().boundingBox())
            ?.x ?? -1) - m0.x,
        ) <= 1,
    );
    await page.waitForSelector(".u-hc-card", { timeout: 3000 });
    const navTip = await page.locator(".u-hc-card").first().textContent();
    check(
      "悬停某一条：第二张卡写完整内容与第几条",
      /第 1 条，共 2 条/.test(navTip ?? "") &&
        (navTip ?? "").includes("读两个文件"),
      navTip ?? "",
    );
    // 在整块里移动不收；离开整块才收
    await page.locator("[data-chat-nav] [data-nav='1']").hover();
    await sleep(300);
    check(
      "在整块区域里移动不收起",
      (await page.locator(".ch-nav[data-expanded]").count()) === 1,
    );
    await page.mouse.move(700, 300);
    await sleep(400);
    check(
      "离开整块才收起",
      (await page.locator(".ch-nav[data-expanded]").count()) === 0,
    );
    await page.locator("[data-chat-nav] [data-nav='0']").click();
    await sleep(900);
    const jumped = await page.evaluate(() => {
      const first = document.querySelector(".ch-you");
      const stream = document.querySelector(".ch-stream");
      return {
        hl: first?.classList.contains("is-jump") ?? false,
        top: Math.round(
          (first?.getBoundingClientRect().top ?? 999) -
            (stream?.getBoundingClientRect().top ?? 0),
        ),
      };
    });
    check(
      "点击定位到那条指令并高亮",
      jumped.hl && Math.abs(jumped.top) < 40,
      JSON.stringify(jumped),
    );

    // 12) 右侧状态
    await box.fill("/goal 把 public API 保持向后兼容");
    await box.press("Enter");
    fakeTree = true;
    // 对话窗格旁边还有文件窗格，要窗口很宽窗格才够 1000
    await page.setViewportSize({ width: 2560, height: 900 });
    await page.reload();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await page.locator(".ch-status").waitFor({ timeout: 15000 });
    await page.locator('[data-subagent="a1"]').waitFor({ timeout: 15000 });
    await sleep(500);
    const st = await page.evaluate(() => {
      const el = document.querySelector(".ch-status");
      const r = el?.getBoundingClientRect();
      const main = document.querySelector(".ch-main")?.getBoundingClientRect();
      const shell = document
        .querySelector(".ch-shell")
        ?.getBoundingClientRect();
      return {
        w: Math.round(r?.width ?? 0),
        full: Math.round(r?.height ?? 0) === Math.round(shell?.height ?? -1),
        right: Math.round((r?.right ?? 0) - (shell?.right ?? 0)),
        besideMain: !!(r && main && Math.abs(r.left - main.right) <= 1),
        titles: [...document.querySelectorAll(".ch-sec-h .t-group")].map(
          (e) => e.textContent,
        ),
        shellW: Math.round(shell?.width ?? 0),
      };
    });
    await shot("9-status-wide");
    check(
      "宽时常驻：宽 232、占满高度、紧挨主栏右侧",
      st.w === 232 && st.full && st.right === 0 && st.besideMain,
      JSON.stringify(st),
    );
    check(
      "块的顺序：目标 / 计划 / 团队 / 工作流 / 子代理（假会话没加载技能与 MCP，所以没有「已加载能力」）",
      JSON.stringify(st.titles) ===
        JSON.stringify(["目标", "计划", "团队", "工作流", "子代理"]),
      JSON.stringify(st.titles),
    );
    const side = await page.evaluate(() => ({
      members: [...document.querySelectorAll("[data-member]")].map((e) =>
        e.textContent?.trim(),
      ),
      phases: [...document.querySelectorAll("[data-phase]")].map((e) =>
        e.textContent?.replace(/\s+/g, " ").trim(),
      ),
      foot: document.querySelector("[data-run] > p")?.textContent,
    }));
    check(
      "团队：名册里是成员的名字与角色",
      side.members.length === 1 && side.members[0]?.startsWith("小王"),
      JSON.stringify(side.members),
    );
    check(
      "工作流：每个阶段一行名字与计数，底下是已启动数与上限",
      JSON.stringify(side.phases) ===
        JSON.stringify([
          "查已完成 6 · 失败 1",
          "写已完成 2 · 运行中 3 · 排队 9",
        ]) && side.foot === "已启动 12 个 agent · 单次运行上限 1000",
      JSON.stringify(side),
    );
    const subs = await page.$$eval("[data-subagent]", (els) =>
      els.map((e) => e.getAttribute("data-subagent")),
    );
    check(
      "子代理现状视图：结束满 10 分钟的折起来，没看过的失败与刚结束的留着",
      JSON.stringify(subs) === JSON.stringify(["root", "a1", "b2", "b3"]),
      JSON.stringify(subs),
    );
    const folds = await page.$$eval("[data-folded]", (els) =>
      els.map((e) => e.textContent),
    );
    check(
      "折起来的写在末尾一行「已结束 N 个」（根下 1 个、a1 下 1 个）",
      JSON.stringify(folds) === JSON.stringify(["已结束 1 个", "已结束 1 个"]),
      JSON.stringify(folds),
    );
    await page
      .locator('[data-folded="ROOTID"] .u-lrow-main')
      .first()
      .click()
      .catch(() => {});
    await page.locator("[data-folded]").last().locator(".u-lrow-main").click();
    await sleep(300);
    const afterOpen = await page.$$eval("[data-subagent]", (els) =>
      els.map((e) => e.getAttribute("data-subagent")),
    );
    check(
      "点「已结束 N 个」原地展开",
      afterOpen.includes("b1"),
      JSON.stringify(afterOpen),
    );
    await page.getByRole("radio", { name: /全部/ }).click();
    await sleep(300);
    const all = await page.$$eval("[data-subagent]", (els) =>
      els.map((e) => e.getAttribute("data-subagent")),
    );
    check(
      "切到「全部」列出全部 5 个子代理",
      all.filter((x) => x !== "root").length === 5,
      JSON.stringify(all),
    );
    await page.getByRole("radio", { name: "现状" }).click();
    // 目标 / 计划块
    const gp = await page.evaluate(() => ({
      goal: document.querySelector('[data-block="goal"]')?.textContent ?? "",
      plan: document.querySelector('[data-block="plan"]')?.textContent ?? "",
    }));
    // 目标会自己续跑：假模型只说话不调工具，几秒内就判受阻，所以状态不固定（各状态在 verify-goal 里验）
    check(
      "目标块：正文与状态，有 编辑 / 暂停或继续 / 删除",
      /public API/.test(gp.goal) &&
        /进行中|受阻|已暂停/.test(gp.goal) &&
        /编辑/.test(gp.goal) &&
        /暂停|继续/.test(gp.goal) &&
        /删除/.test(gp.goal),
      gp.goal,
    );
    check(
      "计划块：1 / 3，当前项在列",
      /1 \/ 3/.test(gp.plan) && /改实现/.test(gp.plan),
      gp.plan,
    );

    // 窄：窗口回到 1440，对话窗格不到 1000
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(700);
    const narrow = await page.evaluate(() => {
      const rail = document.querySelector(".ch-rail");
      const tabs = [...document.querySelectorAll(".ch-rail-label")].map(
        (e) => ({
          t: e.textContent,
          vertical: getComputedStyle(e).writingMode,
        }),
      );
      return {
        has: !!rail,
        status: !!document.querySelector(".ch-status"),
        w: Math.round(rail?.getBoundingClientRect().width ?? 0),
        tabs,
        pop: !!document.querySelector(".ch-rail-pop"),
      };
    });
    await shot("10-status-narrow");
    check(
      "窄时只剩竖排文字标签，没有内容",
      narrow.has &&
        !narrow.status &&
        !narrow.pop &&
        narrow.w === 36 &&
        narrow.tabs.length === 5 &&
        narrow.tabs.every((t) => t.vertical.startsWith("vertical")),
      JSON.stringify(narrow),
    );
    await page.getByRole("button", { name: "子代理" }).hover();
    await sleep(500);
    const pop = await page.evaluate(() => {
      const card = document
        .querySelector(".ch-rail-card")
        ?.getBoundingClientRect();
      const rail = document.querySelector(".ch-rail")?.getBoundingClientRect();
      return {
        w: Math.round(card?.width ?? 0),
        left: !!(card && rail && card.right <= rail.left + 0.5),
        gap: Math.round((rail?.left ?? 0) - (card?.right ?? 0)),
        inView: !!card && card.left >= 0 && card.bottom <= window.innerHeight,
        hasTree: !!document.querySelector('.ch-rail-card [data-subagent="a1"]'),
      };
    });
    await shot("11-status-narrow-open");
    check(
      "悬停标签向左展开：卡宽 288、与标签留 8 的空隙、完整在视口内、里面是子代理树",
      pop.w === 288 && pop.left && pop.gap === 8 && pop.inView && pop.hasTree,
      JSON.stringify(pop),
    );
    // 从标签挪到卡片里，卡片不收
    await page.locator(".ch-rail-card").hover();
    await sleep(300);
    check(
      "鼠标从标签移到卡片里不收",
      (await page.locator(".ch-rail-pop").count()) === 1,
    );
    await page.mouse.move(300, 300);
    await sleep(400);
    check("整块离开才收起", (await page.locator(".ch-rail-pop").count()) === 0);

    // 13) 审计入口与对话头
    check(
      "没有对话头：窗格里没有重复的标题行",
      (await page.locator(".ch-head").count()) === 0,
    );
    const auditOpen = page.locator('[data-audit-toggle="open"]');
    const label = (await auditOpen.textContent()) ?? "";
    const pos = await auditOpen.evaluate((el) => {
      const head = el.closest(".ws-pn-head")?.getBoundingClientRect();
      const tabs = document
        .querySelector(".ws-pn-head .ws-pn-tabs")
        ?.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return {
        inHead: !!head,
        afterTabs: !!tabs && b.left >= tabs.right - 1,
        h: Math.round(b.height),
      };
    });
    check(
      "标签条右端有「审计 N」文字按钮（N 是调用数）",
      /^审计\s*\d+$/.test(label.trim()) && pos.inHead && pos.afterTabs,
      `${label.trim()} ${JSON.stringify(pos)}`,
    );
    await auditOpen.click();
    await page.locator('[data-audit-toggle="back"]').waitFor();
    await sleep(800);
    await shot("12-audit");
    const inAudit = await page.evaluate(() => ({
      stream: !!document.querySelector(".ch-stream"),
      nav: !!document.querySelector("[data-chat-nav]"),
      status: !!document.querySelector(".ch-status, .ch-rail"),
      foot: !!document.querySelector(".ch-foot"),
      back: document
        .querySelector('[data-audit-toggle="back"]')
        ?.textContent?.trim(),
      open: !!document.querySelector('[data-audit-toggle="open"]'),
    }));
    check(
      "审计里：流、导航、右侧状态都没有，页脚还在，按钮换成「对话」",
      !inAudit.stream &&
        !inAudit.nav &&
        !inAudit.status &&
        inAudit.foot &&
        inAudit.back === "对话" &&
        !inAudit.open,
      JSON.stringify(inAudit),
    );
    // 13b) 审计页内部：标准行 + 类型下拉 + 五张卡片 + 悬停卡
    await page.waitForSelector("[data-audit] [data-call]");
    const au = await page.evaluate(() => {
      const root = document.querySelector("[data-audit]");
      const rows = [...root.querySelectorAll("[data-call]")];
      return {
        rows: rows.length,
        stdRows: rows.every(
          (r) => r.classList.contains("u-lrow") && r.querySelector(".au-seq"),
        ),
        noBadge: !root.querySelector(".au-k"),
        noChips: !root.querySelector(".au-chips, .u-fchip"),
        sum: root.querySelector("[data-asum]")?.textContent ?? "",
        select: !!root.querySelector('.au-ctl [role="combobox"]'),
        search: !!root.querySelector(".au-ctl .u-search"),
        refresh: !!root.querySelector('[aria-label="刷新"]'),
        head: root.querySelector(".au-dn")?.textContent ?? "",
        bar: root.querySelectorAll(".au-comp-bar rect").length,
        cards: [...root.querySelectorAll(".au-sec .au-sec-t")].map(
          (e) => e.textContent,
        ),
      };
    });
    check(
      "审计左栏：汇总行 + 类型下拉 + 搜索 + 刷新图标；行是标准行（有序号、没有 U/T 徽标、没有筛选胶囊）",
      au.rows >= 2 &&
        au.stdRows &&
        au.noBadge &&
        au.noChips &&
        au.select &&
        au.search &&
        au.refresh &&
        /^\d+ 次调用/.test(au.sum.trim()),
      JSON.stringify(au),
    );
    check(
      "审计详情：「调用 NN」、四色有缝的组成条、系统提示词 / 工具定义 / 历史 / 本轮新增 / 响应卡片",
      /^调用 \d+$/.test(au.head.trim()) &&
        au.bar >= 2 &&
        ["系统提示词", "工具定义", "响应"].every((t) => au.cards.includes(t)) &&
        ((au.cards.includes("历史") && au.cards.includes("本轮新增")) ||
          au.cards.includes("消息")),
      JSON.stringify([au.head, au.bar, au.cards]),
    );
    await shot("12-audit-detail");
    await page.locator("[data-audit] [data-call] .u-lrow-main").first().hover();
    await page.locator(".u-hc-card").first().waitFor({ timeout: 3000 });
    const peek = (await page.locator(".u-hc-card").first().textContent()) ?? "";
    check(
      "悬停一行出详情卡：时间、触发、模型、输入输出、耗时、结束原因",
      ["时间", "触发", "模型", "输入", "输出", "耗时", "结束原因"].every((k) =>
        peek.includes(k),
      ),
      peek.slice(0, 80),
    );
    await page.mouse.move(5, 5);
    await page.getByRole("button", { name: "全部展开" }).click();
    await sleep(300);
    const opened = await page.evaluate(() =>
      [...document.querySelectorAll("[data-audit] .au-sec .u-lrow-main")].map(
        (b) => b.getAttribute("aria-expanded"),
      ),
    );
    check(
      "「全部展开」：每张卡片都展开",
      opened.length >= 4 && opened.every((x) => x === "true"),
      JSON.stringify(opened),
    );
    await page.getByRole("button", { name: "全部收起" }).click();
    await page.getByRole("radio", { name: "JSON" }).click();
    await page.locator("[data-ajson]").waitFor();
    await page.getByRole("radio", { name: "结构" }).click();
    await page.getByRole("combobox", { name: "按调用类型筛选" }).click();
    await page.getByRole("option", { name: /^用户/ }).click();
    await sleep(300);
    const auSubs = await page
      .locator("[data-audit] [data-call] .u-lrow-sub")
      .allTextContents();
    check(
      "类型下拉选「用户」：列表只剩用户输入触发的调用",
      auSubs.length >= 1 && auSubs.every((t) => t.startsWith("用户输入")),
      JSON.stringify(auSubs.slice(0, 3)),
    );
    await page.locator('[data-audit-toggle="back"]').click();
    await page.locator(".ch-stream").waitFor();
    check(
      "点「对话」回到对话流",
      (await page.locator('[data-audit-toggle="open"]').count()) === 1,
    );

    // 6) 气泡与阅读列
    const geo = await page.evaluate(() => {
      const stream = document.querySelector(".ch-stream");
      const bubble = document.querySelector(".ch-bubble");
      const col = [...(stream?.children ?? [])]
        .filter((c) => c instanceof HTMLElement)
        .map((c) => c.getBoundingClientRect());
      const b = bubble?.getBoundingClientRect();
      const colRight = Math.max(...col.map((r) => r.right));
      return {
        maxW: Math.max(...col.map((r) => r.width)),
        bubbleRight: b?.right ?? 0,
        colRight,
        bg: bubble ? getComputedStyle(bubble).backgroundColor : "",
      };
    });
    const maxCss = await page.$eval(
      ".ch-stream > *",
      (el) => getComputedStyle(el).maxWidth,
    );
    check(
      "阅读列最宽 720",
      maxCss === "720px" && geo.maxW <= 721,
      `${maxCss} / ${Math.round(geo.maxW)}`,
    );
    check(
      "用户消息右对齐、灰底",
      Math.abs(geo.bubbleRight - geo.colRight) <= 2 &&
        geo.bg !== "rgba(0, 0, 0, 0)" &&
        geo.bg !== "rgb(255, 255, 255)",
      geo.bg,
    );

    // 7) 团队块的公告板与团队改动（窄栏里悬停「团队」标签展开卡片）
    await page.getByRole("button", { name: "团队" }).hover();
    await page.locator('.ch-rail-card [data-team="board"]').waitFor();
    const rows = await page.evaluate(() => ({
      board: document.querySelector('[data-team="board"]')?.textContent ?? "",
      changes:
        document.querySelector('[data-team="changes"]')?.textContent ?? "",
    }));
    await shot("13-team-rows");
    check(
      "团队块多两行：公告板「7 条」、团队改动「2 个文件」",
      rows.board.includes("公告板") &&
        rows.board.includes("7 条") &&
        rows.changes.includes("团队改动") &&
        rows.changes.includes("2 个文件"),
      JSON.stringify(rows),
    );
    await page.locator('[data-team="changes"] .u-lrow-main').click();
    const files = await page.$$eval('[data-team="files"] [data-file]', (els) =>
      els.map((e) => e.getAttribute("data-file")),
    );
    await shot("14-team-files");
    check(
      "点开团队改动：列出文件",
      JSON.stringify(files) === JSON.stringify(["src/a.ts", "docs/n.md"]),
      JSON.stringify(files),
    );
    await page.locator('[data-file="src/a.ts"] .u-lrow-main').click();
    await page.locator(".ws-df-body").waitFor({ timeout: 10000 });
    const df = await page.evaluate(() => ({
      head: document.querySelector(".ws-df-head")?.textContent ?? "",
      text: document.querySelector(".ws-df-body")?.textContent ?? "",
    }));
    await shot("15-team-diff");
    check(
      "点文件：开对比标签，头写「团队改动」，里面是逐行差异",
      df.head.includes("团队改动") && df.text.includes("added line"),
      JSON.stringify(df).slice(0, 160),
    );
    await page.getByRole("button", { name: "团队" }).hover();
    await page
      .locator('.ch-rail-card [data-team="board"] .u-lrow-main')
      .click();
    await page
      .locator('.ws-pv-meta[title$="notes.md"]')
      .waitFor({ state: "attached", timeout: 10000 });
    check("点公告板：用预览标签打开公告板文件", true);
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
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = results.filter((r) => !r).length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 项`
    : `\nPASS  chat 区：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
