// 「提示词与能力」页的真机检查：起真实 Server（临时数据目录与临时 YS_HOME，不碰真实的 ~/.ys）+ 无头 Chromium，量 jsdom 测不出的事。
//  1) 服务端语义：全局 AGENTS.md 激活写文件、手改后拒绝覆盖（409）、覆盖、导入、保存生效版本重写文件、生效版本不能删；项目模板写进主目录（已有文件要选写法）；
//  2) 对齐：列表页与编辑页的页签文字、搜索框、第一张卡 / 第一行在 1440 / 1920 宽下都落在页面留白 24；
//  3) 滚动：提示词页三栏各自滚、整页不溢出、保存条浮在底部不跟着滚；卡片库右侧网格自己滚；
//  4) 卡片库：左分组右网格，点卡片是悬浮窗不是满屏；能新建分组、有卡片的分组不能删、空分组能删；
//  5) 离开保护：改了没保存点返回要先问。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-studio.mjs
import { spawn } from "node:child_process";
import {
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

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "studio-"));
const work = join(base, "work");
const ysHome = join(base, "ys");
const projectDir = join(base, "proj");
for (const d of [work, ysHome, projectDir]) mkdirSync(d, { recursive: true });
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
  { stdio: "ignore", cwd: work, env: { ...process.env, YS_HOME: ysHome } },
);

const problems = [];
let checks = 0;
const check = (where, ok, detail = "") => {
  checks++;
  if (!ok) problems.push(`${where}${detail ? `：${detail}` : ""}`);
};

const raw = async (method, path, body) => {
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
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const api = async (method, path, body) => {
  const r = await raw(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`);
  return r.body;
};

const fileOf = () => {
  try {
    return readFileSync(join(ysHome, "AGENTS.md"), "utf8");
  } catch {
    return null;
  }
};

const ids = {};
const oneNode = (presetId, cardIds) => [
  {
    id: `${presetId}-root`,
    tag: null,
    title: "正文",
    slotKind: "custom",
    channel: "system",
    builtin: false,
    items: cardIds.map((cardId) => ({ kind: "card", cardId })),
  },
];
const putNodes = (presetId, cardIds, query = "") =>
  raw("PUT", `/studio/presets/${presetId}/nodes${query}`, {
    nodes: oneNode(presetId, cardIds),
  });

async function seed() {
  ids.cards = [];
  for (let i = 0; i < 28; i++) {
    const c = await api("POST", "/studio/cards", {
      title: `约定 ${String(i).padStart(2, "0")}`,
      group: "项目约定",
      body: `第 ${i} 条约定\n${"这是一行比较长的说明文字，用来把预览撑高。".repeat(2)}\n- 要点一\n- 要点二`,
    });
    ids.cards.push(c.id);
  }
  const mk = async (kind, name) =>
    (
      await api("POST", "/studio/presets", {
        kind,
        name,
        description: `${name} 的描述`,
      })
    ).id;
  ids.v1 = await mk("global-agentsmd", "版本一");
  ids.v2 = await mk("global-agentsmd", "版本二");
  ids.tpl = await mk("project-agentsmd", "长模板");
  ids.tpl2 = await mk("project-agentsmd", "小模板");
  await putNodes(ids.v1, ids.cards.slice(0, 2));
  await putNodes(ids.v2, ids.cards.slice(2, 3));
  await putNodes(ids.tpl, ids.cards);
  await putNodes(ids.tpl2, ids.cards.slice(0, 1));
  const w = await api("POST", "/workspaces", {
    directories: [{ path: projectDir }],
    name: "演示",
  });
  ids.ws = w.id;
}

const bodyOf = (...idx) =>
  `${idx
    .map(
      (i) =>
        `第 ${i} 条约定\n${"这是一行比较长的说明文字，用来把预览撑高。".repeat(2)}\n- 要点一\n- 要点二`,
    )
    .join("\n\n")}\n`;

async function serverSemantics() {
  const where = "服务端";
  writeFileSync(join(ysHome, "AGENTS.md"), "手写的约定\n");
  let s = (await raw("GET", "/agents-md/global")).body;
  check(
    where,
    s.exists && s.modified,
    `手写文件应是 modified：${JSON.stringify(s)}`,
  );

  let r = await raw("POST", `/studio/presets/${ids.v1}/activate`, {});
  check(
    where,
    r.status === 409 && r.body?.error === "disk_modified",
    `手改过没拦：${r.status}`,
  );
  check(where, fileOf() === "手写的约定\n", "被拦的激活还是改了文件");
  check(
    where,
    !(await api("GET", `/studio/presets/${ids.v1}`)).preset.active,
    "被拦的激活还是把版本设成了生效",
  );

  r = await raw("POST", `/studio/presets/${ids.v1}/activate`, {
    overwrite: true,
  });
  check(where, r.status === 200, `覆盖激活失败：${r.status}`);
  check(
    where,
    fileOf() === bodyOf(0, 1),
    `文件内容不对：${JSON.stringify(fileOf())}`,
  );
  s = (await raw("GET", "/agents-md/global")).body;
  check(where, !s.modified, "激活后仍显示被手改过");

  // 再手改：保存生效版本要被拦，库里内容不变
  writeFileSync(join(ysHome, "AGENTS.md"), "又手改了\n");
  r = await putNodes(ids.v1, ids.cards.slice(0, 3));
  check(
    where,
    r.status === 409 && r.body?.error === "disk_modified",
    `保存生效版本没拦：${r.status}`,
  );
  const kept = (await api("GET", `/studio/presets/${ids.v1}`)).preset.nodes[0]
    .items.length;
  check(where, kept === 2, `被拦的保存还是改了库：${kept} 张`);
  check(where, fileOf() === "又手改了\n", "被拦的保存还是写了文件");
  r = await putNodes(ids.v1, ids.cards.slice(0, 3), "?overwrite=1");
  check(
    where,
    r.status === 200 && fileOf() === bodyOf(0, 1, 2),
    `覆盖保存后文件不对：${r.status}`,
  );
  // 非生效版本保存不写文件
  r = await putNodes(ids.v2, ids.cards.slice(3, 5));
  check(
    where,
    r.status === 200 && fileOf() === bodyOf(0, 1, 2),
    "保存非生效版本动了文件",
  );

  // 导入：磁盘内容存成新版本并设为生效
  writeFileSync(join(ysHome, "AGENTS.md"), "导入我\n");
  r = await raw("POST", "/agents-md/global/import", {});
  check(where, r.status === 201, `导入失败：${r.status}`);
  const imported = r.body?.preset;
  check(where, imported?.active === true, "导入的版本没成为生效版本");
  s = (await raw("GET", "/agents-md/global")).body;
  check(where, !s.modified, "导入后仍显示被手改过");
  check(where, fileOf() === "导入我\n", "导入动了文件");
  const list = (await api("GET", "/studio/presets?kind=global-agentsmd"))
    .presets;
  check(
    where,
    list.filter((p) => p.active).length === 1 &&
      list.find((p) => p.id === ids.v1)?.active === false,
    "同时生效的版本不止一个，或旧版本还标着生效",
  );
  // 生效版本不能删
  r = await raw("DELETE", `/studio/presets/${imported.id}`);
  check(where, r.status === 409, `生效版本能删：${r.status}`);
  // 项目模板不能激活
  r = await raw("POST", `/studio/presets/${ids.tpl}/activate`, {});
  check(where, r.status === 400, `项目模板能激活：${r.status}`);
  // 固定文本不许分组
  r = await raw("PUT", `/studio/presets/${ids.tpl2}/nodes`, {
    nodes: [
      {
        ...oneNode(ids.tpl2, [])[0],
        items: [{ kind: "group", id: "g", name: "组", cards: [] }],
      },
    ],
  });
  check(where, r.status === 400, `AGENTS.md 预设能存分组：${r.status}`);

  // 卡片库分组：能建空分组，重名 409；有卡片的不能删，空的能删
  r = await raw("POST", "/studio/card-groups", { name: "团队约定" });
  check(where, r.status === 201, `新建分组失败：${r.status}`);
  r = await raw("POST", "/studio/card-groups", { name: "团队约定" });
  check(where, r.status === 409, `分组重名没拦：${r.status}`);
  r = await raw(
    "DELETE",
    `/studio/card-groups/${encodeURIComponent("项目约定")}`,
  );
  check(where, r.status === 409, `有卡片的分组能删：${r.status}`);
  r = await raw(
    "DELETE",
    `/studio/card-groups/${encodeURIComponent("团队约定")}`,
  );
  check(where, r.status === 204, `空分组删不掉：${r.status}`);

  // 项目模板写进主目录
  const target = join(projectDir, "AGENTS.md");
  r = await raw("POST", `/workspaces/${ids.ws}/agents-md`, {
    presetId: ids.tpl2,
  });
  check(where, r.status === 200, `写项目文件失败：${r.status}`);
  check(where, readFileSync(target, "utf8") === bodyOf(0), "项目文件内容不对");
  r = await raw("POST", `/workspaces/${ids.ws}/agents-md`, {
    presetId: ids.tpl2,
  });
  check(
    where,
    r.status === 409 && r.body?.error === "file_exists",
    `已有文件没问：${r.status}`,
  );
  r = await raw("POST", `/workspaces/${ids.ws}/agents-md`, {
    presetId: ids.v2,
    mode: "append",
  });
  check(where, r.status === 400, `用全局版本当项目模板：${r.status}`);
  r = await raw("POST", `/workspaces/${ids.ws}/agents-md`, {
    presetId: ids.tpl2,
    mode: "append",
  });
  check(
    where,
    readFileSync(target, "utf8") === `${bodyOf(0).trimEnd()}\n\n${bodyOf(0)}`,
    "追加的结果不对",
  );
  r = await raw("POST", `/workspaces/${ids.ws}/agents-md`, {
    presetId: ids.tpl2,
    mode: "overwrite",
  });
  check(where, readFileSync(target, "utf8") === bodyOf(0), "覆盖的结果不对");
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

const atBottom = (m) => !!m && m.top > 0 && m.top + m.client >= m.scroll - 1;

async function alignment(browser) {
  for (const [w, h] of [
    [1440, 900],
    [1920, 1000],
  ]) {
    const where = `${w}px 对齐`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(`${origin}/settings/studio`);
    await page.getByRole("tab", { name: /^Agent/ }).waitFor();
    await sleep(400);
    const main = await left(page, ".st-main");
    const tab = await left(page, ".st-main [role=tab]");
    const search = await left(page, ".st-cg-search");
    const card = await left(page, ".st-cg .u-card");
    check(where, tab - main === 24, `页签文字离主区 ${tab - main}（应为 24）`);
    check(
      where,
      search - main === 24,
      `搜索框离主区 ${search - main}（应为 24）`,
    );
    check(
      where,
      card - main === 24,
      `第一张卡片离主区 ${card - main}（应为 24）`,
    );
    check(
      where,
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )),
      "出现横向滚动",
    );

    // 编辑页：固定文本（单段）与 Agent（带段列表）
    await page.getByRole("tab", { name: /^项目 AGENTS.md/ }).click();
    await page.getByRole("button", { name: "长模板", exact: true }).click();
    await page.getByRole("button", { name: "添加卡片" }).waitFor();
    await sleep(300);
    const m2 = await left(page, ".st-main");
    const row = await left(page, ".sd-col-cards .u-lrow");
    check(
      where,
      row - m2 === 24,
      `单段编辑页第一行离主区 ${row - m2}（应为 24）`,
    );
    await page.getByRole("button", { name: "返回模板列表" }).click();
    await page.getByRole("tab", { name: /^Agent/ }).click();
    await page.getByRole("button", { name: "coder-full", exact: true }).click();
    await page.getByRole("tab", { name: "能力" }).waitFor();
    await sleep(300);
    const tab3 = await left(page, ".st-main [role=tab]");
    const seg = await left(page, ".sd-col-segs .u-lrow");
    check(
      where,
      tab3 - m2 === 24,
      `编辑页页签文字离主区 ${tab3 - m2}（应为 24）`,
    );
    check(where, seg - m2 === 24, `段列表第一行离主区 ${seg - m2}（应为 24）`);
    await ctx.close();
  }
}

async function scrolling(browser) {
  const where = "提示词页滚动";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings/studio`);
  await page.getByRole("tab", { name: /^项目 AGENTS.md/ }).click();
  await page.getByRole("button", { name: "长模板", exact: true }).click();
  await page.getByRole("button", { name: "添加卡片" }).waitFor();
  await sleep(400);
  const main = await metrics(page, ".st-main");
  check(
    where,
    !!main && main.scroll <= main.client + 1,
    `.st-main 自己不该滚：${JSON.stringify(main)}`,
  );
  const cards = await metrics(page, ".sd-col-cards");
  check(
    where,
    !!cards && cards.scroll > cards.client,
    `卡片栏没有溢出，样本不够长：${JSON.stringify(cards)}`,
  );
  const prev = await metrics(page, ".sd-prev-body");
  check(
    where,
    !!prev && prev.scroll > prev.client,
    `预览栏没有溢出：${JSON.stringify(prev)}`,
  );
  await page.mouse.move(300, 400);
  await page.mouse.wheel(0, 9000);
  await sleep(300);
  check(
    where,
    atBottom(await metrics(page, ".sd-col-cards")),
    "卡片栏没滚到底",
  );
  await page.mouse.move(1000, 400);
  await page.mouse.wheel(0, 9000);
  await sleep(300);
  check(
    where,
    atBottom(await metrics(page, ".sd-prev-body")),
    "预览栏没滚到底",
  );

  // 改一下名字让页面变脏：保存条浮在底部，不随任何一栏滚走，也不挤占编辑区（出现时页面不跳）
  const hBefore = (await metrics(page, ".sd-pw"))?.client;
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名…" }).click();
  await page.getByLabel("名称").fill("长模板改");
  await page.getByRole("dialog").getByRole("button", { name: "确定" }).click();
  const bar = page.getByRole("region", { name: "保存" });
  await bar.waitFor();
  await sleep(500); // 等保存条的入场动画停下来再量
  const hAfter = (await metrics(page, ".sd-pw"))?.client;
  check(
    where,
    hBefore === hAfter,
    `保存条出现时编辑区高度变了：${hBefore} → ${hAfter}`,
  );
  const box = await bar.boundingBox();
  check(
    where,
    !!box && box.y + box.height <= 720 && box.y > 400,
    `保存条不在视口底部：${JSON.stringify(box)}`,
  );
  await page.mouse.move(300, 400);
  await page.mouse.wheel(0, -9000);
  await sleep(300);
  const box2 = await bar.boundingBox();
  check(where, !!box2 && Math.abs(box2.y - box.y) < 2, "保存条跟着滚走了");

  // 离开保护：点返回先问；放弃修改后回到列表
  await page.getByRole("button", { name: "返回模板列表" }).click();
  await page.getByText("有未保存的修改").first().waitFor();
  await page.getByRole("button", { name: "放弃修改" }).click();
  await page.getByRole("button", { name: "长模板", exact: true }).waitFor();
  check(where, true);
  await ctx.close();
}

async function cardLibrary(browser) {
  const where = "卡片库";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings/studio`);
  await page.getByRole("tab", { name: /^卡片/ }).click();
  const rail = page.getByRole("complementary", { name: "卡片库" });
  await rail.waitFor();
  check(
    where,
    (await rail.getByText("项目约定").count()) === 1,
    "左边没有「项目约定」分组",
  );
  check(
    where,
    (await rail.getByText("全部").count()) === 1,
    "左边没有「全部」",
  );
  // 新建分组：出现在左边并被选中，右边是空的；再删掉
  await rail.getByRole("button", { name: "新建分组" }).click();
  await page.getByLabel("分组名").fill("临时分组");
  await page.getByRole("dialog").getByRole("button", { name: "新建" }).click();
  const fresh = rail.getByRole("button", { name: /^临时分组(?! 的操作)/ });
  await fresh.waitFor();
  check(
    where,
    (await fresh.getAttribute("aria-current")) === "true",
    "新建的分组没被选中",
  );
  check(
    where,
    (await page.getByText("这个分组里没有卡片").count()) === 1,
    "新分组右边不是空的",
  );
  await rail
    .getByRole("button", { name: "临时分组 的操作" })
    .click({ force: true });
  await page.getByRole("menuitem", { name: /删除分组/ }).click();
  await fresh.waitFor({ state: "detached" });
  check(where, true);

  await rail.getByRole("button", { name: /^项目约定(?! 的操作)/ }).click();
  await sleep(300);
  const detail = await metrics(page, ".st-detail");
  check(
    where,
    !!detail && detail.scroll > detail.client,
    `右侧网格没有溢出：${JSON.stringify(detail)}`,
  );
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, 9000);
  await sleep(300);
  check(where, atBottom(await metrics(page, ".st-detail")), "右侧网格没滚到底");
  const main = await metrics(page, ".st-main");
  check(where, !!main && main.scroll <= main.client + 1, ".st-main 自己滚了");

  await page.getByRole("button", { name: "约定 27", exact: true }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  const size = await dlg.evaluate((e) => ({
    size: e.getAttribute("data-size"),
    w: Math.round(e.getBoundingClientRect().width),
    h: Math.round(e.getBoundingClientRect().height),
  }));
  check(
    where,
    size.size !== "full" && size.w < 1000 && size.h < 700,
    `点卡片不是悬浮窗：${JSON.stringify(size)}`,
  );
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "detached" });
  check(where, true);
  await ctx.close();
}

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${origin}/api/v1/health`)).ok) break;
    } catch {}
    await sleep(250);
  }
  await seed();
  await serverSemantics();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    await alignment(browser);
    await scrolling(browser);
    await cardLibrary(browser);
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
  console.log(`verify-studio PASS（${checks} 项检查）`);
} else {
  console.log(`verify-studio FAIL（${problems.length}/${checks}）`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
