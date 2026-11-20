// 「工具与能力」页的真机检查：起真实 Server（临时数据目录与临时 HOME）+ 无头 Chromium，量 jsdom 测不出的事。
//  1) 对齐：页签文字、列表页内容、技能 / MCP 左列表的搜索框，在 1440 / 1920 宽下都落在页面留白 24；
//  2) 工具页签：Server 注册的全部工具按组列出；改了进草稿、不发请求，保存条浮在底部不挤动内容；
//     组头批量、恢复出厂、框架工具的 switch_mode 都真的落库；改了没保存时切页签要先问；
//  3) 技能页签：左列表自己滚；悬停卡片；分发真的写到（临时）环境上、卸载真的清掉；禁用；查看文件；搜索；
//  4) MCP 页签：检测失败点名原因；审批进草稿、保存才落库；切换服务前先问；检测全部。
//  5) 扩展页签：用本地目录当包（不联网）走 预览 → 安装 → 停用 → 启用 → 卸载，并核对临时 HOME 里的 settings.json 真的跟着变。
// 技能的分发写进临时 HOME，不碰真实的 ~/.agents；MCP 都指向必然失败的命令与端口，不会真去连外面的服务。
// pi 的登记写在 <HOME>/.pi/agent/settings.json，临时 HOME 保证不碰真实的 ~/.pi。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-tools.mjs   （SHOTS=目录 顺带存截图）
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (shots) mkdirSync(shots, { recursive: true });

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "tools-"));
const work = join(base, "work");
const home = join(base, "home");
mkdirSync(work, { recursive: true });
mkdirSync(home, { recursive: true });
const port = 17750 + Math.floor(Math.random() * 90);
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
  { stdio: "ignore", cwd: work, env: { ...process.env, HOME: home } },
);

const problems = [];
let checks = 0;
const check = (where, ok, detail = "") => {
  checks++;
  if (!ok) problems.push(`${where}${detail ? `：${detail}` : ""}`);
};

const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await r.text();
  if (r.status >= 300)
    throw new Error(`${method} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const toolOf = async (name) =>
  (await api("GET", "/tools")).tools.find((t) => t.name === name);
const mcpOf = async (name) =>
  (await api("GET", "/mcp")).servers.find((s) => s.name === name);

const SKILLS = Array.from(
  { length: 26 },
  (_, i) => `skill-${String(i + 1).padStart(2, "0")}`,
);

async function seed() {
  for (const name of SKILLS) {
    const dir = join(base, "skills-src", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n# ${name}\n`,
    );
    await api("POST", "/skills/install", {
      source: { kind: "dir", spec: dir },
    });
    // 新装的技能默认是项目级（不按环境分发）；分发检查用的 skill-03 要先设成全局
    if (name === "skill-03")
      await api("PATCH", `/skills/${name}`, { scope: "global" });
  }
  const mcp = (name, conf) =>
    api("POST", "/mcp", {
      json: JSON.stringify({ mcpServers: { [name]: conf } }),
    });
  // 都必然失败：命令一启动就退出；端口没有人监听
  await mcp("bad-stdio", {
    command: "node",
    args: ["-e", "process.exit(1)"],
  });
  await mcp("bad-http", {
    url: "http://127.0.0.1:1/mcp",
  });
  // 本地目录当 pi 包：一个纯扩展，一个带安装脚本（本地来源不会跑脚本，只验弹窗的提示与勾选）
  for (const [dir, scripts] of [
    ["pi-ext-a", undefined],
    ["pi-ext-b", { postinstall: "echo hi" }],
  ]) {
    const root = join(base, "pi-src", dir);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: dir,
        version: "1.2.3",
        pi: { extensions: ["./index.ts"] },
        ...(scripts ? { scripts } : {}),
      }),
    );
    writeFileSync(join(root, "index.ts"), "export default () => {};\n");
  }
}

const left = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? Math.round(el.getBoundingClientRect().left) : null;
  }, sel);
const metrics = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el
      ? { client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop }
      : null;
  }, sel);
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

const open = async (page, tab = "工具") => {
  page.on("pageerror", (e) => problems.push(`页面报错：${e.message}`));
  await page.goto(`${origin}/settings/tools`);
  await page
    .getByRole("tab", { name: /^工具\s*\d/ })
    .waitFor({ timeout: 8000 });
  await page.getByRole("region", { name: "文件与命令" }).waitFor();
  if (tab !== "工具")
    await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
  await sleep(400);
};
const region = (page, name) => page.getByRole("region", { name });
const radio = (page, group, label) =>
  page
    .getByRole("radiogroup", { name: group })
    .getByRole("radio", { name: label });
const bar = (page) => page.getByRole("region", { name: "保存" });
const saveNow = async (page) => {
  await bar(page).getByRole("button", { name: "保存" }).click();
  await bar(page).waitFor({ state: "detached", timeout: 4000 });
};
const rail = (page) => page.locator(".st-rail");
const rowOf = (page, label) =>
  page.locator(".u-lrow-label", { hasText: new RegExp(`^${label}$`) });

async function alignment(browser) {
  for (const [w, h] of [
    [1440, 900],
    [1920, 1000],
  ]) {
    const where = `${w}px 对齐`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await open(page);
    const main = await left(page, ".st-main");
    const tab = await left(page, ".st-main [role=tab]");
    const bar0 = await left(page, ".tp-bar");
    check(where, tab - main === 24, `页签文字离主区 ${tab - main}（应为 24）`);
    check(
      where,
      bar0 - main === 24,
      `工具页内容离主区 ${bar0 - main}（应为 24）`,
    );
    check(
      where,
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )),
      "出现横向滚动",
    );
    for (const t of ["技能", "MCP"]) {
      await page.getByRole("tab", { name: new RegExp(`^${t}`) }).click();
      await page.locator(".st-rail .u-search").waitFor();
      const s = await left(page, ".st-rail .u-search");
      check(where, s - main === 24, `${t} 搜索框离主区 ${s - main}（应为 24）`);
    }
    await ctx.close();
  }
}

async function toolsTab(browser) {
  const where = "工具页签";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page);
  await shot(page, "tools");

  // 数量取自接口，不写死：增删工具时这里不用跟着改
  const all = (await api("GET", "/tools")).tools;
  check(
    where,
    (await page
      .getByRole("tab", { name: new RegExp(`^工具\\s*${all.length}`) })
      .count()) === 1,
    `工具总数不是 ${all.length}`,
  );
  const names = await page
    .getByRole("region")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  check(
    where,
    JSON.stringify(names) ===
      JSON.stringify([
        "文件与命令",
        "目录与传输",
        "编排与委派",
        "浏览器",
        "开发调试",
        "框架工具",
      ]),
    `分组不对：${names}`,
  );
  const fw = region(page, "框架工具");
  check(
    where,
    (await fw.locator("tbody tr").count()) === 0,
    "框架工具默认没有折起",
  );
  await fw.getByRole("button", { name: "展开" }).click();
  const frameworkCount = all.filter((t) => t.framework).length;
  check(
    where,
    (await fw.locator("tbody tr").count()) === frameworkCount,
    `展开后不是 ${frameworkCount} 行`,
  );
  check(
    where,
    (await page
      .getByRole("radiogroup", { name: "switch_mode 审批" })
      .count()) === 1,
    "switch_mode 没有开关",
  );
  await shot(page, "tools-framework");

  // 改一格：进草稿、不发请求；保存条浮出且不挤动内容
  const scroll0 = await metrics(page, ".st-scroll");
  check(
    where,
    !!scroll0 && scroll0.scroll > scroll0.client,
    `工具页没有可滚内容：${JSON.stringify(scroll0)}`,
  );
  await radio(page, "read cwd 外", "放行").click();
  await bar(page).waitFor();
  await sleep(400);
  check(
    where,
    (await toolOf("read")).rule.outside === "ask",
    "没点保存就改了服务端",
  );
  const scroll1 = await metrics(page, ".st-scroll");
  check(
    where,
    scroll1?.client === scroll0?.client,
    `保存条出现时滚动区高度变了：${scroll0?.client} → ${scroll1?.client}`,
  );
  const box = await bar(page).boundingBox();
  check(
    where,
    !!box && box.y + box.height <= 800 && box.y > 500,
    `保存条不在视口底部：${JSON.stringify(box)}`,
  );
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 9000);
  await sleep(300);
  const box2 = await bar(page).boundingBox();
  check(where, !!box2 && Math.abs(box2.y - box.y) < 2, "保存条跟着滚走了");
  await shot(page, "tools-dirty");
  await saveNow(page);
  const r1 = await toolOf("read");
  check(
    where,
    r1.rule.outside === "allow" && r1.modified,
    `保存后服务端没变：${JSON.stringify(r1.rule)}`,
  );

  // 组头批量：浏览器全部放行
  await page.mouse.wheel(0, -9000);
  await page.getByRole("button", { name: "浏览器 的批量设置" }).click();
  await page.getByRole("menuitem", { name: /^全部放行/ }).click();
  await saveNow(page);
  const browserAll = await Promise.all(
    [
      "browser_open",
      "browser_pages",
      "browser_close",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_dialog",
      "browser_move",
      "browser_scroll",
      "browser_drag",
      "browser_nav",
      "browser_upload",
      "browser_screenshot",
      "browser_console",
      "browser_assets",
      "browser_dom",
      "browser_handoff",
      "browser_show",
    ].map(toolOf),
  );
  check(
    where,
    browserAll.every(
      (t) => t.rule.inside === "allow" && t.rule.outside === "allow",
    ),
    "批量放行没有落库",
  );

  // 文件与命令：全部恢复出厂，read 回到出厂值
  await page.getByRole("button", { name: "文件与命令 的批量设置" }).click();
  await page.getByRole("menuitem", { name: /^全部恢复出厂/ }).click();
  await saveNow(page);
  const r2 = await toolOf("read");
  check(
    where,
    r2.rule.outside === "ask" && !r2.modified,
    `恢复出厂没有落库：${JSON.stringify(r2)}`,
  );

  // 框架工具里的 switch_mode：默认审批，可以放行
  check(
    where,
    (await toolOf("switch_mode")).rule.inside === "ask",
    "switch_mode 默认不是审批",
  );
  await radio(page, "switch_mode 审批", "放行").click();
  await saveNow(page);
  const sm = await toolOf("switch_mode");
  check(
    where,
    sm.rule.inside === "allow" && sm.rule.outside === "allow",
    "switch_mode 放行没有落库（两格应一起变）",
  );

  // 改了没保存：切页签先问；放弃后服务端没变
  await radio(page, "write cwd 外", "放行").click();
  await bar(page).waitFor();
  await page.getByRole("tab", { name: /^技能/ }).click();
  const leave = page.getByRole("dialog", { name: "有未保存的修改" });
  await leave.waitFor({ timeout: 3000 });
  await shot(page, "tools-leave");
  await leave.getByRole("button", { name: "放弃修改" }).click();
  await page.locator(".st-rail .u-search").waitFor();
  check(
    where,
    (await toolOf("write")).rule.outside === "ask",
    "放弃后服务端还是变了",
  );
  await ctx.close();
}

async function skillsTab(browser) {
  const where = "技能页签";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const page = await ctx.newPage();
  await open(page, "技能");
  await shot(page, "skills");

  check(
    where,
    (await page.locator(".st-rail .u-lrow").count()) === SKILLS.length,
    "左列表条数不对",
  );
  const railM = await metrics(page, ".st-rail-list");
  check(
    where,
    !!railM && railM.scroll > railM.client,
    `左列表没有溢出：${JSON.stringify(railM)}`,
  );
  const main = await metrics(page, ".st-main");
  check(
    where,
    !!main && main.scroll <= main.client + 1,
    `.st-main 自己不该滚：${JSON.stringify(main)}`,
  );

  // 悬停卡片
  await rowOf(page, "skill-05").scrollIntoViewIfNeeded();
  await rowOf(page, "skill-05").hover();
  const tip = page.getByRole("tooltip");
  await tip.waitFor({ timeout: 3000 });
  check(
    where,
    ((await tip.textContent()) ?? "").includes("来源"),
    "悬停卡片里没有来源",
  );
  await shot(page, "skills-peek");
  await page.mouse.move(900, 300);

  // 搜索
  await page.getByLabel("筛选名称、描述或来源").fill("skill-07");
  await sleep(300);
  check(
    where,
    (await page.locator(".st-rail .u-lrow").count()) === 1,
    "搜索后不是 1 条",
  );
  await page.getByLabel("筛选名称、描述或来源").fill("");
  await sleep(300);

  // 分发：写进临时 HOME，卸载再清掉
  const name = "skill-03";
  await rowOf(page, name).scrollIntoViewIfNeeded();
  await rowOf(page, name).click();
  const art = page.getByRole("article", { name: `${name} 详情` });
  await art.waitFor();
  check(
    where,
    (await art.locator(".tp-env").count()) === 1,
    "分发行数不对（只有本机一个环境）",
  );
  const target = join(home, ".agents", "skills", "yuanshu", name, "SKILL.md");
  check(where, !existsSync(target), "分发前环境里已经有副本");
  await art.getByRole("button", { name: /^补齐 1 个环境/ }).click();
  await art.getByText("一致").first().waitFor({ timeout: 6000 });
  check(where, existsSync(target), "分发后环境里没有副本");
  await shot(page, "skills-detail");

  // 禁用
  await art.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "禁用" }).click();
  await rowOf(page, name)
    .locator("xpath=ancestor::*[contains(@class,'u-lrow')]")
    .getByRole("img", { name: "已禁用" })
    .waitFor({ timeout: 4000 });

  // 查看文件
  await page.getByRole("button", { name: "查看文件" }).click();
  const dlg = page.getByRole("dialog", { name });
  await dlg.waitFor();
  // 文件清单是弹窗打开后才取的
  check(
    where,
    await dlg
      .getByText("SKILL.md")
      .first()
      .waitFor({ timeout: 4000 })
      .then(
        () => true,
        () => false,
      ),
    "文件弹窗里没有 SKILL.md",
  );
  await shot(page, "skills-files");
  await page.keyboard.press("Escape");

  // 卸载
  await art.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "卸载" }).click();
  const rm = page.getByRole("dialog", { name: `卸载 ${name}` });
  await rm.waitFor();
  await rm.getByRole("button", { name: "卸载" }).click();
  await rm.waitFor({ state: "detached", timeout: 6000 });
  check(where, (await rowOf(page, name).count()) === 0, "卸载后左列表还有它");
  check(where, !existsSync(target), "卸载后环境里的副本没清掉");
  await ctx.close();
}

async function mcpTab(browser) {
  const where = "MCP 页签";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page, "MCP");
  check(
    where,
    (await page.locator(".st-rail .u-lrow").count()) === 2,
    "左列表条数不对",
  );
  await rowOf(page, "bad-stdio").click();
  const art = page.getByRole("article", { name: "bad-stdio 详情" });
  await art.waitFor();
  await shot(page, "mcp");

  // 检测失败：三步里点名原因
  await art.getByRole("button", { name: "检测" }).click();
  const steps = art.getByRole("list", { name: "检测三步" });
  await steps.waitFor({ timeout: 15000 });
  const startState = await steps
    .locator('[data-step="start"]')
    .getAttribute("data-state");
  const hsState = await steps
    .locator('[data-step="handshake"]')
    .getAttribute("data-state");
  check(
    where,
    startState === "error" || hsState === "error",
    `没有失败的一步：${startState}/${hsState}`,
  );
  check(
    where,
    (await art.getByText("本机（Server）").count()) > 0,
    "运行位置没写本机",
  );
  await shot(page, "mcp-failed");

  // 审批进草稿：改了没保存时切换服务先问，放弃后没变；保存才落库
  await radio(page, "bad-stdio 审批", "放行").click();
  await bar(page).waitFor();
  check(
    where,
    (await mcpOf("bad-stdio")).approval === "ask",
    "没点保存就改了服务端",
  );
  await rowOf(page, "bad-http").click();
  const leave = page.getByRole("dialog", { name: "有未保存的修改" });
  await leave.waitFor({ timeout: 3000 });
  await leave.getByRole("button", { name: "放弃修改" }).click();
  const http = page.getByRole("article", { name: "bad-http 详情" });
  await http.waitFor();
  check(
    where,
    (await mcpOf("bad-stdio")).approval === "ask",
    "放弃后服务端还是变了",
  );
  check(
    where,
    ((await http.textContent()) ?? "").includes("Server 直连"),
    "http 服务没写 Server 直连",
  );
  check(
    where,
    (await http.getByRole("region", { name: "版本" }).count()) === 0,
    "http 服务不该有版本一节",
  );
  await radio(page, "bad-http 审批", "放行").click();
  await saveNow(page);
  check(
    where,
    (await mcpOf("bad-http")).approval === "allow",
    "保存后服务端没变",
  );

  // 列表头：检测全部
  await page.getByRole("button", { name: "MCP 服务的操作" }).click();
  await page.getByRole("menuitem", { name: "检测全部" }).click();
  await page
    .getByText(/^检测完成：就绪 0 \/ 2/)
    .first()
    .waitFor({ timeout: 20000 });

  // 添加弹窗：能开能关
  await page.getByRole("button", { name: "添加服务" }).click();
  const add = page.getByRole("dialog", { name: "添加 MCP 服务" });
  await add.waitFor();
  await shot(page, "mcp-add");
  await page.keyboard.press("Escape");
  await add.waitFor({ state: "detached" });
  await ctx.close();
}

const pluginSettings = () => {
  const f = join(home, ".pi", "agent", "settings.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
};
const pluginSources = () =>
  (pluginSettings().packages ?? []).map((p) =>
    typeof p === "string" ? p : p.source,
  );

async function pluginsTab(browser) {
  const where = "扩展页签";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await open(page, "扩展");
  check(
    where,
    (await page.getByText("还没有安装 pi 扩展").count()) >= 1,
    "空状态没出现",
  );
  await shot(page, "plugins-empty");

  // 安装 pi-ext-b（带脚本）：先预览，勾选之前不允许脚本
  await rail(page)
    .getByRole("button", { name: /安装扩展/ })
    .click();
  const dlg = page.getByRole("dialog", { name: "安装 pi 扩展" });
  await dlg.waitFor();
  await dlg.getByRole("textbox").fill(join(base, "pi-src", "pi-ext-b"));
  await dlg.getByRole("button", { name: "预览" }).click();
  const box = dlg.getByRole("checkbox", { name: "允许运行安装脚本" });
  await box.waitFor({ timeout: 15000 });
  check(
    where,
    (await dlg.textContent())?.includes("v1.2.3"),
    "预览里没有包的版本",
  );
  check(where, pluginSources().length === 0, "预览阶段就写了登记");
  await shot(page, "plugins-preview");
  await dlg.getByRole("button", { name: "安装" }).click();
  await dlg.waitFor({ state: "detached", timeout: 20000 });
  check(where, pluginSources().length === 1, "安装后登记里没有这个包");

  // 再装 pi-ext-a，列表两条
  await rail(page)
    .getByRole("button", { name: /安装扩展/ })
    .click();
  const dlg2 = page.getByRole("dialog", { name: "安装 pi 扩展" });
  await dlg2.waitFor();
  await dlg2.getByRole("textbox").fill(join(base, "pi-src", "pi-ext-a"));
  await dlg2.getByRole("button", { name: "预览" }).click();
  await dlg2.getByRole("button", { name: "安装" }).waitFor({ timeout: 15000 });
  await dlg2.getByRole("button", { name: "安装" }).click();
  await dlg2.waitFor({ state: "detached", timeout: 20000 });
  check(
    where,
    (await page.locator(".st-rail .u-lrow").count()) === 2,
    "左列表条数不对",
  );
  await rowOf(page, "pi-ext-a").click();
  const art = page.getByRole("article", { name: "pi-ext-a 详情" });
  await art.waitFor();
  await shot(page, "plugins");

  // 停用 / 启用只改我们的开关：pi 的登记（settings.json）始终保持字符串写法，不被污染
  await art.getByRole("button", { name: "停用" }).click();
  await art.getByRole("button", { name: "启用" }).waitFor({ timeout: 8000 });
  check(
    where,
    (pluginSettings().packages ?? []).every((p) => typeof p === "string"),
    "停用后 pi 的登记被改了",
  );
  await art.getByRole("button", { name: "启用" }).click();
  await art.getByRole("button", { name: "停用" }).waitFor({ timeout: 8000 });
  check(
    where,
    (pluginSettings().packages ?? []).every((p) => typeof p === "string"),
    "启用后 pi 的登记被改了",
  );

  // 卸载：本地目录不删，登记里去掉
  await art.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "卸载" }).click();
  const rm = page.getByRole("dialog", { name: "卸载 pi-ext-a" });
  await rm.waitFor();
  check(
    where,
    ((await rm.textContent()) ?? "").includes("目录本身不会删"),
    "本地来源的卸载说明不对",
  );
  await rm.getByRole("button", { name: "卸载" }).click();
  await rm.waitFor({ state: "detached", timeout: 8000 });
  check(where, pluginSources().length === 1, "卸载后登记里还有它");
  check(
    where,
    existsSync(join(base, "pi-src", "pi-ext-a", "package.json")),
    "本地目录被删了",
  );
  await ctx.close();
}

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) break;
    } catch {}
    await sleep(250);
  }
  await seed();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    await alignment(browser);
    await toolsTab(browser);
    await skillsTab(browser);
    await mcpTab(browser);
    await pluginsTab(browser);
  } finally {
    await browser.close();
  }
} catch (err) {
  problems.push(`脚本异常：${err instanceof Error ? err.message : err}`);
} finally {
  proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

if (problems.length === 0) {
  console.log(`verify-tools PASS（${checks} 项检查）`);
} else {
  console.log(`verify-tools FAIL（${problems.length}/${checks}）`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
