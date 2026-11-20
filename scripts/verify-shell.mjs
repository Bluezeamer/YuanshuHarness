// 新外壳（工作区左轨 + 一屏一工作区）的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，不需要真实模型。
//  1) 选中工作区：默认窗口 = 临时对话标签 + 文件/终端窗格
//  2) 会话行拖到窗格右缘：多一个窗格；别的工作区的会话不被接受
//  3) 切到另一个工作区再切回、刷新：布局原样（每个工作区各存一份）
//  4) 「+ 新对话」：多一个会话，临时标签换成它（对照服务端存的布局）
//  5) 工作区头拖到分组头 / 「未分组」 / 另一个工作区前 / 组尾落点：服务端的分组与顺序跟着变
//  6) 分组头菜单：编辑分组（改名 + 换色）、解散分组（工作区回到未分组）
//  6b) 置顶工作区 / 会话（排到最前、行上有图钉）；会话行悬停的「归档」按钮直接归档
//  7) 「新对话（带配置）」建出带所选配置的会话；会话菜单「会话设置」改名写回服务端
//  8) 悬停卡片：会话行（状态、目录、时间、编号）与工作区头（描述、对话统计、目录、时间）停留后出现在右侧；离开 / Esc 收起；都没有原生 title
//  9) 窄屏：≤1120 默认收起为 62px，≤900 横成顶部条，都没有横向滚动；收起态的浮层里行也有卡片
// 10) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-shell.mjs [--shots 目录]
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

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "shell-"));
const work = `${realpathSync(base)}/work`;
const dirs = { a: `${work}/a`, b: `${work}/b` };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const port = 18000 + Math.floor(Math.random() * 90);
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
  // 创建会话要有个能解析的模型；这里不会真的调用它
  await api("POST", "/providers", {
    name: "占位",
    slug: "placeholder",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "x",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  const wsA = await api("POST", "/workspaces", {
    name: "甲",
    description: "接口与前端的主战场",
    directories: [{ path: dirs.a }],
  });
  const wsB = await api("POST", "/workspaces", {
    name: "乙",
    directories: [{ path: dirs.b }],
  });
  for (const ws of [wsA, wsB])
    for (let i = 0; i < 3; i++)
      await api("POST", "/sessions", { workspaceId: ws.id });

  const layoutOf = async (id) => {
    const { document } = await api("GET", `/workspaces/${id}/layout`);
    const tabs = [];
    const walk = (n) =>
      n.pid ? tabs.push(...n.tabs) : n.children.forEach(walk);
    for (const w of document?.windows?.list ?? []) walk(w.root);
    return tabs;
  };
  const orderOf = async () =>
    (await api("GET", "/workspaces")).workspaces
      .sort((x, y) => x.order - y.order)
      .map((w) => w.name);

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
    const state = () =>
      page.evaluate(() => ({
        rows: document.querySelectorAll(".rl-ws[data-current] .rl-row").length,
        tabs: [...document.querySelectorAll(".ws-pn-tab")].map(
          (t) => `${t.dataset.type}${t.dataset.temp ? "*" : ""}`,
        ),
        panes: document.querySelectorAll(".ws-pane").length,
      }));
    const chats = (s) => s.tabs.filter((t) => t.startsWith("chat")).length;
    const head = (n) => page.locator(".rl-wh", { hasText: n });
    const filesPane = () => page.locator(".ws-pane").nth(1);
    const rightEdge = async () => {
      const b = await filesPane().boundingBox();
      return { x: b.width - 12, y: b.height / 2 };
    };

    // 1) 选中甲：默认窗口
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await head("甲").click();
    await sleep(1500);
    let s = await state();
    check(
      "选中工作区：临时对话标签 + 文件/终端窗格（2 个窗格）",
      s.panes === 2 && s.tabs.includes("chat*") && s.rows === 3,
      JSON.stringify(s),
    );

    // 2) 拖会话进窗格；别的工作区的会话不接受
    await page
      .locator(".rl-ws[data-current] .rl-row:not([data-viewing])")
      .first()
      .dragTo(filesPane(), { targetPosition: await rightEdge() });
    await sleep(500);
    s = await state();
    check(
      "拖本工作区的会话到窗格右缘：多一个窗格，共 2 个对话标签",
      s.panes === 3 && chats(s) === 2,
      JSON.stringify(s),
    );
    const placed = s;
    await page.locator(".rl-ws:not([data-current]) .rl-chev").first().click();
    await page
      .locator(".rl-ws:not([data-current]) .rl-row")
      .first()
      .dragTo(filesPane(), { targetPosition: await rightEdge() });
    await sleep(500);
    s = await state();
    check(
      "拖别的工作区的会话：不生效",
      JSON.stringify(s.tabs) === JSON.stringify(placed.tabs),
      JSON.stringify(s),
    );
    await shot("1-placed");
    await sleep(1500);

    // 3) 切走再切回、刷新
    await head("乙").click();
    await sleep(1500);
    s = await state();
    check("切到乙：是它自己的默认窗口", s.panes === 2, JSON.stringify(s));
    await head("甲").click();
    await sleep(1500);
    s = await state();
    check(
      "切回甲：布局原样",
      JSON.stringify(s.tabs) === JSON.stringify(placed.tabs),
      JSON.stringify(s),
    );
    await page.reload();
    await page.waitForSelector(".sh-app");
    await sleep(1800);
    s = await state();
    check(
      "刷新后：布局保持",
      JSON.stringify(s.tabs) === JSON.stringify(placed.tabs),
      JSON.stringify(s),
    );

    // 4) 新对话：临时标签换成新会话
    const sessionsBefore = (await api("GET", "/sessions")).sessions.length;
    await page.locator(".rl-ws[data-current] .rl-new .u-lrow-main").click();
    await sleep(2200);
    const mine = (await api("GET", "/sessions")).sessions
      .filter((x) => x.workspaceId === wsA.id)
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    const newest = mine.at(-1)?.id;
    const tabs = await layoutOf(wsA.id);
    check(
      "点「新对话」：多一个会话，临时标签换成它",
      (await api("GET", "/sessions")).sessions.length === sessionsBefore + 1 &&
        tabs.some((t) => t.type === "chat" && t.temp && t.sid === newest),
      JSON.stringify(
        tabs
          .filter((t) => t.type === "chat")
          .map((t) => [t.sid?.slice(-4), t.temp]),
      ),
    );
    await shot("2-newchat");

    // 5) 工作区拖拽：先让乙入组（分组靠第一个成员长出来），再拖甲
    const group = await api("POST", "/workspace-groups", { name: "主线" });
    await api("PATCH", `/workspaces/${wsB.id}`, { groupId: group.id });
    await page.reload();
    await page.waitForSelector(".sh-app");
    await sleep(1500);
    const groupOf = async (name) =>
      (await api("GET", "/workspaces")).workspaces.find((w) => w.name === name)
        ?.groupId ?? null;
    await head("甲").dragTo(page.locator(".rl-ghead", { hasText: "主线" }));
    await sleep(1200);
    check("拖到分组头：入组", (await groupOf("甲")) === group.id);
    // 全员都在组里时「未分组」落点是拖起后才出现的，dragTo 会在拖起前就找目标，所以手动走鼠标
    const from = await head("甲").boundingBox();
    await page.mouse.move(from.x + 60, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 40, { steps: 5 });
    const zone = page.locator(".rl-ungrouped");
    await zone.waitFor({ timeout: 5000 });
    const zb = await zone.boundingBox();
    await page.mouse.move(zb.x + 20, zb.y + 8, { steps: 8 });
    await page.mouse.up();
    await sleep(1200);
    check("拖到「未分组」：移出", (await groupOf("甲")) === null);
    await head("甲").dragTo(head("乙"));
    await sleep(1200);
    const order = await orderOf();
    check(
      "拖到另一个工作区头：插到它前面（并随它入组）",
      order.indexOf("甲") < order.indexOf("乙") &&
        (await groupOf("甲")) === group.id,
      order.join(" , "),
    );
    // 拖到组尾的落点（最后一个工作区之后）：排到该组最后
    const fromHead = await head("甲").boundingBox();
    await page.mouse.move(fromHead.x + 60, fromHead.y + 12);
    await page.mouse.down();
    await page.mouse.move(fromHead.x + 80, fromHead.y + 40, { steps: 5 });
    const end = page.locator(".rl-dropend").first();
    await end.waitFor({ timeout: 5000 });
    const eb = await end.boundingBox();
    await page.mouse.move(eb.x + 20, eb.y + eb.height / 2, { steps: 8 });
    await page.mouse.up();
    await sleep(1200);
    const afterEnd = await orderOf();
    check(
      "拖到组尾的落点：排到该组最后",
      afterEnd.indexOf("甲") > afterEnd.indexOf("乙") &&
        (await groupOf("甲")) === group.id,
      afterEnd.join(" , "),
    );
    await shot("3-groups");

    // 6) 分组头菜单：编辑、解散
    const groupMenu = async (item) => {
      const gh = page.locator(".rl-ghead").first();
      await gh.hover();
      await gh.getByRole("button", { name: "分组操作" }).click({ force: true });
      await page.getByRole("menuitem", { name: item }).click();
    };
    await groupMenu(/编辑分组/);
    await page.getByLabel("分组名称").fill("  干线 ");
    await page.getByRole("button", { name: "颜色 4" }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await sleep(1000);
    const g = (await api("GET", "/workspace-groups")).groups.find(
      (x) => x.id === group.id,
    );
    check(
      "编辑分组：名称去掉空白、颜色换成 4，服务端已存",
      g?.name === "干线" && g.tone === 4,
      JSON.stringify(g),
    );
    await shot("5-group-edit");
    await groupMenu(/解散分组/);
    await page.getByRole("button", { name: "解散", exact: true }).click();
    await sleep(1000);
    check(
      "解散分组：分组没了，工作区回到未分组且都还在",
      (await api("GET", "/workspace-groups")).groups.length === 0 &&
        (await groupOf("甲")) === null &&
        (await groupOf("乙")) === null,
    );

    // 置顶（工作区、会话）与会话行内的「归档」按钮
    const wsNames = () => page.locator(".rl-wh .rl-wname").allTextContents();
    const wh = head("乙");
    await wh.hover();
    await wh.getByRole("button", { name: "工作区菜单" }).click({ force: true });
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await sleep(1200);
    const pinnedWs = (await api("GET", "/workspaces")).workspaces.find(
      (w) => w.name === "乙",
    );
    check(
      "工作区置顶：服务端存了，左轨里排到最前，行上有图钉",
      pinnedWs?.pinned === true &&
        (await wsNames())[0] === "乙" &&
        (await head("乙").locator(".rl-pinned").count()) === 1,
      (await wsNames()).join(" , "),
    );
    const rows = page.locator(".rl-ws[data-current] .rl-row");
    const last = rows.last();
    await last.hover();
    await last.getByRole("button", { name: "更多" }).click({ force: true });
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await sleep(1200);
    const pinnedSessions = (await api("GET", "/sessions")).sessions.filter(
      (x) => x.pinned,
    );
    check(
      "会话置顶：服务端存了，最后一行排到所在工作区的最前，行上有图钉",
      pinnedSessions.length === 1 &&
        (await rows.first().locator(".rl-pinned").count()) === 1 &&
        (await rows.last().locator(".rl-pinned").count()) === 0,
      JSON.stringify(pinnedSessions.map((x) => x.id.slice(-4))),
    );
    const liveBefore = (await api("GET", "/sessions")).sessions.filter(
      (x) => x.status !== "archived",
    ).length;
    const target = rows.last();
    await target.hover();
    await target.getByRole("button", { name: "归档", exact: true }).click({
      force: true,
    });
    await sleep(1200);
    check(
      "行内「归档」按钮：点一下就归档这一个会话",
      (await api("GET", "/sessions")).sessions.filter(
        (x) => x.status !== "archived",
      ).length ===
        liveBefore - 1,
    );
    await shot("3-pinned");

    // 7) 带配置新建 / 会话设置
    const newInA = async () => {
      const row = page.locator(".rl-ws[data-current] .rl-new");
      await row.hover();
      await row.getByRole("button", { name: /带配置/ }).click({ force: true });
    };
    await head("甲").click();
    await sleep(800);
    await newInA();
    await page.getByLabel("名称").fill("cfg-chat");
    await page.getByRole("button", { name: /^权限/ }).click();
    await page.getByLabel("权限档位").click();
    await page.getByRole("option", { name: /通过/ }).click();
    await page.getByRole("button", { name: "完成" }).click();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    let cfg;
    for (let i = 0; i < 40 && !cfg; i++) {
      await sleep(250);
      cfg = (await api("GET", "/sessions")).sessions.find(
        (x) => x.title === "cfg-chat",
      );
    }
    const cfgConf = cfg ? await api("GET", `/sessions/${cfg.id}/config`) : null;
    check(
      "带配置新建：会话在当前工作区，权限覆盖是「通过」",
      cfg?.workspaceId === wsA.id && cfgConf?.permissionTier === "full",
      JSON.stringify([cfg?.workspaceId === wsA.id, cfgConf?.permissionTier]),
    );
    await sleep(1500);
    await page
      .locator(".rl-ws[data-current] .rl-row", { hasText: "cfg-chat" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: /会话设置/ }).click();
    check(
      "会话设置：名称框里是当前名称，Agent 不能换",
      (await page.getByLabel("名称").inputValue()) === "cfg-chat" &&
        (await page.getByRole("combobox", { name: "Agent" }).isDisabled()),
    );
    await page.getByLabel("名称").fill("cfg-renamed");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await sleep(1200);
    check(
      "会话设置：改名写回服务端",
      (await api("GET", "/sessions")).sessions.some(
        (x) => x.id === cfg?.id && x.title === "cfg-renamed",
      ),
    );
    await shot("6-session-dialog");

    // 8) 会话行悬停卡片
    // 取第二行：第一行是刚置顶的那个，点过它的菜单，悬停卡片在指针离开它之前一直被静音
    const peekRow = page.locator(".rl-ws[data-current] .rl-row").nth(1);
    const tip = page.getByRole("tooltip");
    await peekRow.hover();
    await tip.waitFor({ timeout: 3000 });
    const tipText = (await tip.textContent()) ?? "";
    const rb = await peekRow.boundingBox();
    const tb = await tip.boundingBox();
    check(
      "悬停会话行：卡片写着状态、目录、创建与最近活动、编号",
      ["待命", dirs.a, "创建于", "最近活动", "#"].every((t) =>
        tipText.includes(t),
      ),
      tipText,
    );
    check(
      "卡片在行的右侧、与行顶大致对齐、完整落在视口内",
      tb.x >= rb.x + rb.width &&
        Math.abs(tb.y - rb.y) <= 16 &&
        tb.x + tb.width <= 1440 &&
        tb.y + tb.height <= 900,
      JSON.stringify([rb, tb]),
    );
    check(
      "行上没有原生 title（不与卡片叠在一起）",
      (await peekRow.locator(".u-lrow-main").getAttribute("title")) === null,
    );
    await sleep(300);
    await shot("5-session-peek");
    await page.mouse.move(900, 400);
    check("指针离开：卡片收起", (await tip.count()) === 0);
    await peekRow.locator(".u-lrow-main").focus();
    await tip.waitFor({ timeout: 3000 });
    await page.keyboard.press("Escape");
    check("键盘聚焦出现，Esc 收起", (await tip.count()) === 0);
    await peekRow.hover();
    await tip.waitFor({ timeout: 3000 });
    await peekRow.locator(".u-lrow-main").click();
    check("点行：卡片收起，不盖着刚打开的内容", (await tip.count()) === 0);
    await page.mouse.move(900, 400);

    // 8b) 工作区头悬停卡片；头的版式不被外层 .u-hc 破坏（名字能撑满、状态计数靠右）
    const wsHead = page.locator(".rl-ws[data-current] .rl-wh").first();
    const wrow = wsHead.locator(".u-lrow");
    await wrow.hover();
    await tip.waitFor({ timeout: 3000 });
    const wText = (await tip.textContent()) ?? "";
    const hb = await wsHead.boundingBox();
    const wb = await wrow.boundingBox();
    const ib = await wsHead.locator(".rl-chev").boundingBox();
    const wtb = await tip.boundingBox();
    check(
      "悬停工作区头：卡片写着描述、对话统计、目录、创建与最近活动",
      [
        "甲",
        "接口与前端的主战场",
        "4 个 · 1 个已归档",
        dirs.a,
        "创建于",
        "最近活动",
      ].every((t) => wText.includes(t)),
      wText,
    );
    check(
      "卡片在头的右侧、完整落在视口内",
      wtb.x >= hb.x + hb.width &&
        wtb.x + wtb.width <= 1440 &&
        wtb.y + wtb.height <= 900,
      JSON.stringify([hb, wtb]),
    );
    check(
      "头的版式：行占满箭头右边的全部宽度，没有被卡片外层挤窄",
      Math.abs(wb.x + wb.width - (hb.x + hb.width)) <= 1 &&
        wb.x >= ib.x + ib.width - 1,
      JSON.stringify([hb, wb, ib]),
    );
    check(
      "工作区头上没有原生 title",
      (await wrow.locator(".u-lrow-main").getAttribute("title")) === null,
    );
    await sleep(300);
    await shot("5-workspace-peek");
    await page.mouse.move(900, 400);
    check("指针离开工作区头：卡片收起", (await tip.count()) === 0);

    // 9) 窄屏
    for (const [w, want] of [
      [1024, "mini"],
      [780, "strip"],
    ]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.reload();
      await page.waitForSelector(".sh-app");
      await sleep(1200);
      const m = await page.evaluate(() => {
        const r = document.querySelector(".rl")?.getBoundingClientRect();
        return {
          w: Math.round(r?.width ?? 0),
          h: Math.round(r?.height ?? 0),
          x: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        };
      });
      check(
        `${w}px：左轨${want === "mini" ? "收为 62px" : "横成顶部条"}，没有横向滚动`,
        m.x <= m.cw && (want === "mini" ? m.w === 62 : m.h <= 80 && m.w > 400),
        JSON.stringify(m),
      );
      await shot(`4-${w}`);
      if (want === "mini") {
        await page.locator(".rl-mi[data-current]").hover();
        const flyRow = page
          .locator(".rl-mi[data-current] .rl-fly .rl-row")
          .first();
        await flyRow.hover();
        await tip.waitFor({ timeout: 3000 });
        const fb = await tip.boundingBox();
        check(
          "收起态：浮层里的会话行也有卡片，完整落在视口内",
          fb.x + fb.width <= w && fb.y >= 0 && fb.y + fb.height <= 800,
          JSON.stringify(fb),
        );
        await shot("4-1024-peek");
        await page.mouse.move(w - 20, 700);
      }
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
    : `\nPASS  新外壳：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
