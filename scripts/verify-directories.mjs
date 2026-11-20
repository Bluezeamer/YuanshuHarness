// 工作区弹窗与多目录的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，不需要真实模型。
//  1) 新建工作区：主目录 + 一个附加目录，服务端清单是 [local, remote]，顺序与路径对；
//  2) 同一目录加两次：「创建」被禁用，提示点名「重复」，没有多出工作区；
//  3) 主目录已是某工作区的主目录：按钮变成「打开」，不新建；
//  4) 编辑工作区：改名；移除附加目录前先列出连带影响，确认后清单只剩主目录；
//  5) 「默认值设置」里的目录起点真的是选目录的起点（改成 work 目录后，选目录弹层里列出它的子目录）；
//  6) 全程没有控制台报错、没有失败的接口请求。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-directories.mjs [--shots 目录]
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
const base = mkdtempSync(join(root, "tmp", "ws-multi-"));
const work = realpathSync(base) + "/work";
const dirs = { a: `${work}/a`, b: `${work}/b`, c: `${work}/c` };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const port = 17900 + Math.floor(Math.random() * 90);
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
    const workspaces = async () => (await api("GET", "/workspaces")).workspaces;
    const byName = async (name) =>
      (await workspaces()).find((w) => w.name === name);
    const pathBox = () => page.getByLabel("目录路径");
    const openRow = (label) =>
      page.getByRole("button", { name: new RegExp(`^${label}`) }).click();

    // 1) 新建：主目录 + 附加目录
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await pathBox().fill(dirs.a);
    await page.getByLabel("名称").fill("multi-ws");
    await openRow("附加目录");
    await page.getByRole("button", { name: "添加目录" }).click();
    await pathBox().fill(dirs.b);
    await shot("1-create");
    await page.getByRole("button", { name: "完成" }).click();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    let made;
    for (let i = 0; i < 50 && !made; i++) {
      await sleep(200);
      made = await byName("multi-ws");
    }
    check("界面创建工作区成功", Boolean(made));
    check(
      "服务端清单是 [local, remote]，顺序与路径对",
      made?.directories.length === 2 &&
        made.directories[0].role === "local" &&
        made.directories[0].path === dirs.a &&
        made.directories[1].role === "remote" &&
        made.directories[1].path === dirs.b,
      JSON.stringify(
        made?.directories.map((w) => [w.role, w.path.split("/").pop()]),
      ),
    );
    await sleep(1500);

    // 2) 同一目录加两次：被拦下
    const before = (await workspaces()).length;
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await pathBox().fill(dirs.c);
    await openRow("附加目录");
    await page.getByRole("button", { name: "添加目录" }).click();
    await pathBox().fill(dirs.c);
    await page.getByRole("button", { name: "完成" }).click();
    await sleep(600);
    check(
      "同一目录加两次：「创建」被禁用",
      await page
        .getByRole("button", { name: "创建", exact: true })
        .isDisabled(),
    );
    check(
      "同一目录加两次：提示点名「重复」",
      (await page.getByText(/重复了/).count()) > 0,
    );
    check(
      "同一目录加两次：没有多出工作区",
      (await workspaces()).length === before,
    );
    await shot("2-dup");

    // 3) 主目录已有工作区：「打开」，不新建
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await pathBox().fill(dirs.a);
    await sleep(300);
    check(
      "主目录已是别的工作区的主目录：按钮是「打开」，并点名那个工作区",
      (await page
        .getByRole("button", { name: "打开", exact: true })
        .count()) === 1 &&
        (await page.getByText(/「multi-ws」的主目录/).count()) > 0,
    );
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await sleep(800);
    check("点「打开」没有新建工作区", (await workspaces()).length === before);

    // 4) 编辑：改名 + 移除附加目录（先确认影响）
    await page
      .locator(".rl-wh", { hasText: "multi-ws" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: /编辑工作区/ }).click();
    await page.getByLabel("名称").fill("multi-renamed");
    await openRow("附加目录");
    await page.getByRole("button", { name: "移除这个目录" }).click();
    await page.getByRole("button", { name: "完成" }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByRole("button", { name: "移除并保存" })
      .waitFor({ timeout: 8000 });
    check(
      "移除附加目录前先列出连带影响，没有立刻改",
      (await (await byName("multi-renamed"))?.directories.length) === 2,
    );
    await shot("3-remove");
    await page.getByRole("button", { name: "移除并保存" }).click();
    let edited;
    for (let i = 0; i < 40 && edited?.directories.length !== 1; i++) {
      await sleep(200);
      edited = await byName("multi-renamed");
    }
    check(
      "确认后：已改名，清单只剩主目录",
      edited?.directories.length === 1 && edited.directories[0].path === dirs.a,
      JSON.stringify(edited?.directories.map((w) => w.path.split("/").pop())),
    );

    // 5) 目录起点：改成 work 目录，选目录弹层里应当列出 a b c
    await api("PUT", "/defaults", { directoryStart: work });
    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await pathBox().fill("");
    await page
      .getByRole("button", { name: "选择目录", exact: true })
      .first()
      .click();
    await sleep(800);
    const names = await page
      .getByRole("listbox", { name: "子目录" })
      .getByRole("option")
      .allInnerTexts();
    const listed = names.map((t) => t.trim());
    check(
      "目录起点生效：选目录弹层从默认起点开始，列出它的子目录 a / b / c",
      ["a", "b", "c"].every((n) => listed.includes(n)),
      JSON.stringify(listed),
    );
    await shot("4-start");
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
    : `\nPASS  多目录：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
