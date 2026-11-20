// 画布与笔记的版本历史界面的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，不需要真实模型。
//  1) 笔记：工具条「历史」打开右侧面板，列出每一次提交（新的在前、最新一条标「当前」、写明来源）；
//     点开一条看按行的差别；恢复成旧版本后文件、主区、列表都跟着变（恢复是一条新记录），点「当前」那条不给恢复
//  2) 画布：面板跟着主区换到画布；点开旧版本列出「恢复后会消失的」节点；有没保存的改动时对话框写明会丢掉；恢复后没保存的改动没了
//  3) 撤销 agent：最新一条是 agent 的提交时才出现「撤销 agent 的上一次修改」，确认后文件回到之前
//  4) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-versions.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
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
const base = mkdtempSync(join(root, "tmp", "versions-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(dir, { recursive: true });
const port = 18400 + Math.floor(Math.random() * 90);
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

const api = async (method, path, body, text = false) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": text ? "text/plain" : "application/json" },
          body: text ? body : JSON.stringify(body),
        }),
  });
  const raw = await r.text();
  let data = raw;
  try {
    data = JSON.parse(raw);
  } catch {}
  return { status: r.status, body: data };
};
const q = (extra = {}) => new URLSearchParams({ dir, ...extra }).toString();
const C = "/canvas/local";
const canvasDir = join(dir, ".canvas");
const noteOnDisk = () => readFileSync(join(canvasDir, "说明.md"), "utf8");
const boardOnDisk = () =>
  JSON.parse(readFileSync(join(canvasDir, "想法.canvas"), "utf8"));

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
  const ws = await api("POST", "/workspaces", {
    name: "历史验",
    directories: [{ path: dir }],
  });
  await api("POST", "/sessions", { workspaceId: ws.body.id });

  // 造历史：服务端把用户的改动等停顿（5 秒）后合成一次提交；读历史会先把攒着的提交落下，所以每步之后读一次
  const step = async () => api("GET", `${C}/history?${q()}`);
  await api("POST", `${C}/boards?${q()}`, { name: "想法" });
  await step();
  await api("POST", `${C}/notes?${q()}`, { path: "说明", text: "第一版\n" });
  await step();
  for (const text of ["第二版\n", "第三版\n"]) {
    await api("PUT", `${C}/card?${q({ path: "说明.md" })}`, text, true);
    await step();
  }
  for (const name of ["甲", "乙"]) {
    await api("POST", `${C}/cards?${q()}`, { board: "想法", name, text: name });
    await step();
  }

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1600, height: 950 } })
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
    const panel = () => page.locator(".cv-vers-panel");
    const rows = () => panel().locator(".u-lrow");
    const dialog = () => page.getByRole("dialog");
    const toasts = () =>
      page
        .locator(".u-toast")
        .evaluateAll((els) => els.map((e) => e.textContent));
    // 窄窗格里树栏是盖在主区上的、选了东西就收起：每次点树之前先确保它是展开的
    const openTreeRow = async (id) => {
      if ((await page.locator(".cv-tree").count()) === 0)
        await page.getByRole("button", { name: "展开树栏" }).click();
      await page.locator(".cv-tree").waitFor();
      await page
        .locator(`.cv-tree [data-tree-id="${id}"] .u-lrow-main`)
        .click();
    };
    const waitToastsGone = () =>
      page.waitForFunction(() => !document.querySelector(".u-toast"), null, {
        timeout: 8000,
      });

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "历史验" }).click();
    await page.waitForSelector(".ws-pane");
    await sleep(800);
    await page
      .locator(".ws-pane", {
        has: page.locator(".ws-pn-tab[data-type='files']"),
      })
      .getByRole("button", { name: "新建标签页" })
      .click();
    await page.getByRole("menuitem", { name: "画布" }).click();
    await page.waitForSelector(".cv");
    await sleep(800);

    // 1) 笔记的历史
    await openTreeRow("说明.md");
    await page.locator(".cv-note").waitFor();
    check("没打开历史时没有面板", (await panel().count()) === 0);
    await page
      .locator(".cv-bar")
      .getByRole("button", { name: "历史", exact: true })
      .click();
    await panel().waitFor();
    await rows().first().waitFor();
    await sleep(400);
    const n1 = await rows().count();
    const first = await rows().first().innerText();
    check(
      "笔记的历史面板：每一次提交一行（新建 + 两次保存 = 3 条），最新一条标「当前」，写明来源「你」",
      n1 === 3 && first.includes("当前") && first.includes("你"),
      JSON.stringify([n1, first]),
    );
    await shot("versions-1-panel");

    await rows().nth(1).click();
    await dialog().waitFor();
    const diffText = await dialog().locator(".ws-pv-diff").innerText();
    check(
      "点开第二条：按行的差别里，恢复后「第三版」会去掉、「第二版」会回来，有「恢复到这一版」",
      diffText.includes("−第三版") &&
        diffText.includes("+第二版") &&
        (await dialog()
          .getByRole("button", { name: "恢复到这一版" })
          .count()) === 1,
      JSON.stringify(diffText),
    );
    await shot("versions-2-dialog");
    await dialog().getByRole("button", { name: "恢复到这一版" }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".u-toast")].some((t) =>
          t.textContent?.includes("已恢复到"),
        ),
      null,
      { timeout: 8000 },
    );
    await page.locator(".cv-note-read").waitFor();
    await sleep(800);
    const readText = await page.locator(".cv-note-read").innerText();
    check(
      "恢复：文件回到「第二版」，主区跟着重读，对话框关了",
      noteOnDisk() === "第二版\n" &&
        readText.includes("第二版") &&
        (await dialog().count()) === 0,
      JSON.stringify([noteOnDisk(), readText.slice(0, 40)]),
    );
    const n2 = await rows().count();
    const top = await rows().first().innerText();
    check(
      "列表多了一条「恢复」记录（历史没有被改写）、它成了「当前」",
      n2 === 4 && top.includes("恢复") && top.includes("当前"),
      JSON.stringify([n2, top]),
    );
    await rows().first().click();
    await dialog().waitFor();
    await sleep(600);
    const curText = await dialog().innerText();
    check(
      "点「当前」那条：写明这就是现在的版本，没有恢复按钮",
      curText.includes("这就是现在的版本") &&
        (await dialog()
          .getByRole("button", { name: "恢复到这一版" })
          .count()) === 0,
      JSON.stringify(curText),
    );
    await dialog().locator(".u-btn", { hasText: "关闭" }).click();
    await waitToastsGone();

    // 2) 画布的历史：面板跟着主区
    await openTreeRow("想法.canvas");
    await page.locator(".cv .react-flow__node").first().waitFor();
    await sleep(900);
    check(
      "切到画布：面板跟着换成画布的历史（标题是画布名）",
      (await panel().locator(".cv-vers-sub").innerText()) === "想法" &&
        (await rows().count()) >= 3,
      await panel().locator(".cv-vers-sub").innerText(),
    );
    const nodesBefore = await page.locator(".cv .react-flow__node").count();
    await rows().nth(1).click();
    await dialog().waitFor();
    await dialog().locator(".cv-verdlg-board").waitFor();
    const boardText = await dialog().innerText();
    check(
      "点开画布的旧版本：不列 JSON，写「恢复后会消失的（1）」与卡片名「乙」；说明只恢复画布本身",
      boardText.includes("恢复后会消失的（1）") &&
        boardText.includes("乙") &&
        boardText.includes("卡片里的文字各有自己的版本"),
      JSON.stringify(boardText.slice(0, 200)),
    );
    await dialog().locator(".u-btn", { hasText: "关闭" }).click();

    // 有没保存的改动：新建一张没保存的卡片
    await page
      .locator(".cv-bar")
      .getByRole("button", { name: "新建卡片" })
      .click();
    // 窄窗格里「未保存」的字会藏起来，只留点：等它出现在 DOM 里就行
    await page
      .locator('.cv-bar .cv-save[title="未保存"]')
      .waitFor({ state: "attached" });
    await rows().nth(1).click();
    await dialog().waitFor();
    await dialog().locator(".cv-verdlg-board").waitFor();
    check(
      "有没保存的改动时：对话框写明「恢复后会丢掉它们」",
      (await dialog().innerText()).includes(
        "你有没保存的改动，恢复后会丢掉它们",
      ),
    );
    await dialog().getByRole("button", { name: "恢复到这一版" }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".u-toast")].some((t) =>
          t.textContent?.includes("已恢复到"),
        ),
      null,
      { timeout: 8000 },
    );
    await sleep(1000);
    const restored = boardOnDisk().nodes.length;
    const nodesAfter = await page.locator(".cv .react-flow__node").count();
    check(
      "恢复画布：文件里少了「乙」（只剩 1 个节点），界面上也是，没保存的改动清掉了（没有「未保存」）",
      restored === 1 &&
        nodesAfter === 1 &&
        nodesBefore >= 2 &&
        (await page.locator('.cv-bar .cv-save[title="未保存"]').count()) === 0,
      JSON.stringify({ restored, nodesBefore, nodesAfter }),
    );
    await shot("versions-3-board");
    await waitToastsGone();

    // 3) 撤销 agent：造一条 agent 的提交（直接在仓库里提交，格式和服务端一致）
    await openTreeRow("说明.md");
    await page.locator(".cv-note").waitFor();
    await sleep(600);
    check(
      "最新一条不是 agent 的：没有「撤销 agent」",
      (await page
        .getByRole("button", { name: "撤销 agent 的上一次修改" })
        .count()) === 0,
    );
    const before = noteOnDisk();
    // 用服务端自己的仓库类走 canvas_edit 的收尾（写文件、重生成 index、按 agent 来源提交），和真 agent 一样
    const { CanvasRepo } = await import(
      join(root, "packages/server/dist/canvas/repo.js")
    );
    const { LocalEnv } = await import(
      join(root, "packages/server/dist/env/local.js")
    );
    const agentRepo = new CanvasRepo(new LocalEnv(), dir);
    agentRepo.beginBatch();
    await agentRepo.saveNote("说明.md", "agent 改的\n");
    agentRepo.endBatch();
    await agentRepo.commitAs({ kind: "agent", session: "s1" }, "edit 说明");
    await panel().getByRole("button", { name: "刷新" }).click();
    await page
      .getByRole("button", { name: "撤销 agent 的上一次修改" })
      .waitFor();
    check(
      "最新一条是 agent 的：出现「撤销 agent 的上一次修改」，列表第一行来源是 agent",
      (await rows().first().innerText()).includes("agent"),
    );
    await page.getByRole("button", { name: "撤销 agent 的上一次修改" }).click();
    await dialog().waitFor();
    await dialog().getByRole("button", { name: "撤销" }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".u-toast")].some((t) =>
          t.textContent?.includes("已撤销 agent"),
        ),
      null,
      { timeout: 8000 },
    );
    await sleep(900);
    check(
      "确认撤销：文件回到 agent 改之前，主区重读，按钮消失，列表里多一条「撤销」",
      noteOnDisk() === before &&
        (await page.locator(".cv-note-read").innerText()).includes("第二版") &&
        (await page
          .getByRole("button", { name: "撤销 agent 的上一次修改" })
          .count()) === 0 &&
        (await rows().first().innerText()).includes("撤销"),
      JSON.stringify([noteOnDisk(), before]),
    );

    // 关掉面板
    await panel().getByRole("button", { name: "关闭历史" }).click();
    check("关闭历史：面板收起", (await panel().count()) === 0);

    check(
      "全程没有控制台报错与失败的接口请求",
      problems.length === 0,
      problems.slice(0, 5).join(" | "),
    );
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  check("脚本异常", false, String(e?.stack ?? e).slice(0, 500));
} finally {
  proc.kill();
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n版本历史：${results.length - failed}/${results.length} 项通过`);
process.exit(failed === 0 ? 0 : 1);
