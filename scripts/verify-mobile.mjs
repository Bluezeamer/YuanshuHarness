// 手机端（/m/）的真机检查：起真实 Server（临时数据目录）+ 假模型 + 无头 Chromium（手机设备描述：390×844、2 倍屏、触控），不需要真实模型。
//  0) 配对：桌面（全局令牌）建码 → 手机打开 /m/?pair=码 → 换到独立的设备令牌，地址栏里没有码；码不能用第二次
//  1) 列表：顶栏、工作区与会话、行高 ≥ 48、没有横向滚动，整页不滚（滚动的是列表自己）
//  2) 点会话进对话页（URL /m/s/<id>），系统返回回到列表；列表的滚动位置还在
//  3) 输入栏：回车是换行不发送，点发送按钮才发；提示文字没有「Enter 发送」
//  4) 待处理：对话里出审批卡，返回列表后顶上出现「需要你」区，点它回到那个对话
//  5) 状态抽屉：点「状态」升起抽屉（占一条历史），系统返回关掉抽屉而不是离开对话页
//  6) 深链接：直接打开 /m/s/<id>，返回落在列表而不是退出
//  7) 设置页：进去能看到访问方式，返回回到列表
//  8) 全程没有控制台报错、没有失败的接口请求（配对之后的步骤都在设备令牌下跑，等于把全部接口与三条推送流过了一遍）
//  W2) 工具抽屉与标签页：列表上工作区头的「工具」（文件 / 终端 / 浏览器 / 画布，行高 ≥ 48），选中后目标页取代抽屉那一层，
//     返回一次就回到发起页；对话页的「工具」多一个「审计」；文件页点文件进预览；终端与画布能打开；长按会话行出「置顶 / 归档」
//  9) 退出此设备：服务端删掉设备、令牌失效，回到令牌门
// 10) 桌面撤销：另一台设备在页面开着时被撤销，之后打开 /m/ 回到令牌门，旧令牌 401
// Server 配了全局令牌（不然就是回环模式，测不到凭据）。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-mobile.mjs [--shots 目录]
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
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "mobile-"));
const work = `${realpathSync(base)}/work`;
// 甲 7 个会话（列表只先露 5 个）、乙 1 个，另有四个工作区把列表撑到要滚动
const NAMES = ["甲", "乙", "丙", "丁", "戊", "己"];
const SESSIONS = { 甲: 7, 乙: 1, 丙: 3, 丁: 3, 戊: 3, 己: 3 };
const dirOf = (name) => `${work}/${name}`;
for (const n of NAMES) mkdirSync(dirOf(n), { recursive: true });
writeFileSync(
  join(dirOf("甲"), "readme.md"),
  "# 你好，手机\n\n这是一份说明。\n",
);

// 剧本：第一轮要一条需要审批的命令，批准之后收尾
const fake = await startFakeModel(
  [
    {
      text: "我来建个目录。",
      tools: [
        {
          name: "bash",
          args: { command: "mkdir -p out && echo hi > out/a.txt" },
        },
      ],
    },
    { text: "完成。" },
  ],
  { delay: 30 },
);

const TOKEN = "m".repeat(40);
const port = 18200 + Math.floor(Math.random() * 90);
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
    // HOME 指到临时目录，免得悄悄用上真实的 ~/.pi
    env: { ...process.env, YUANSHU_TOKEN: TOKEN, HOME: base },
  },
);
const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

const problems = [];
let collecting = true;

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
  for (const name of NAMES) {
    const ws = await api("POST", "/workspaces", {
      name,
      directories: [{ path: dirOf(name) }],
    });
    for (let i = 0; i < SESSIONS[name]; i++) {
      const { id } = await api("POST", "/sessions", { workspaceId: ws.id });
      await api("PATCH", `/sessions/${id}`, {
        title: `${name}的会话 ${i + 1}`,
      });
    }
  }

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => {
      if (collecting) problems.push(`pageerror ${e.message.split("\n")[0]}`);
    });
    page.on("console", (m) => {
      if (collecting && m.type() === "error")
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (collecting && r.url().includes("/api/v1/") && r.status() >= 400)
        problems.push(`${r.status()} ${r.url().split("/api/v1")[1]}`);
    });
    const shot = (n) =>
      SHOTS ? page.screenshot({ path: join(SHOTS, `${n}.png`) }) : null;
    const path = () =>
      new URL(page.url()).pathname + new URL(page.url()).search;

    // 0) 配对
    const pairing = await api("POST", "/devices/pairing", {});
    await page.goto(`${origin}/m/?pair=${pairing.code}`);
    await page.waitForSelector(".sh-gate input");
    await shot("0-pair");
    await page.locator(".sh-gate input").fill("测试手机");
    await page.getByRole("button", { name: "添加" }).click();
    await page.waitForSelector(".m-row");
    const paired = await page.evaluate(() => ({
      search: location.search,
      token: localStorage.getItem("yuanshu.token"),
    }));
    const devices = (await api("GET", "/devices")).devices;
    const reuse = await fetch(`${origin}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code, name: "再来一台" }),
    });
    check(
      "配对：换到独立的设备令牌存在本机，地址栏里没有码，设备出现在列表里，码不能用第二次",
      paired.search === "" &&
        paired.token !== null &&
        paired.token !== TOKEN &&
        paired.token.length >= 32 &&
        devices.length === 1 &&
        devices[0].name === "测试手机" &&
        reuse.status === 401,
      JSON.stringify({
        search: paired.search,
        devices: devices.length,
        reuse: reuse.status,
      }),
    );

    // 1) 列表（重新打开：设备令牌从 localStorage 里读回来，冷启动不丢）
    await page.goto(`${origin}/m/`);
    await page.waitForSelector(".m-row");
    await sleep(600);
    const list = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".m-row")];
      return {
        rows: rows.length,
        minH: Math.min(...rows.map((r) => r.getBoundingClientRect().height)),
        overflowX:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        pageScroll: document.scrollingElement.scrollHeight > innerHeight,
        top: !!document.querySelector(".m-top"),
        title: document.querySelector(".m-top-title")?.textContent,
      };
    });
    check(
      "列表：顶栏、会话行高 ≥ 48、没有横向滚动、整页不滚",
      list.top &&
        list.rows >= 6 &&
        list.minH >= 47.5 &&
        !list.overflowX &&
        !list.pageScroll,
      JSON.stringify(list),
    );
    await shot("1-list");

    // 2) 进对话、返回
    const last = page.getByText("己的会话 1");
    await last.scrollIntoViewIfNeeded();
    const before = await page
      .locator(".m-scroll")
      .evaluate((el) => el.scrollTop);
    await last.click();
    await page.waitForSelector(".ch-shell");
    check(
      "点会话进对话页：URL 是 /m/s/<id>",
      /^\/m\/s\/[^/]+$/.test(path()),
      path(),
    );
    await shot("2-chat");
    await page.goBack();
    await page.waitForSelector(".m-row");
    const after = await page
      .locator(".m-scroll")
      .evaluate((el) => el.scrollTop);
    check(
      "系统返回回到列表，滚动位置还在",
      path() === "/m/" && Math.abs(after - before) < 2 && before > 0,
      `${path()} scrollTop ${before} → ${after}`,
    );

    // 3) 输入栏：回车换行，按钮发送
    await page.getByText("甲的会话 7").click();
    await page.waitForSelector(".ch-ta");
    const ta = page.locator(".ch-ta");
    check(
      "提示文字没有「Enter 发送」",
      !(await ta.getAttribute("placeholder"))?.includes("Enter"),
      (await ta.getAttribute("placeholder")) ?? "",
    );
    await ta.click();
    await page.keyboard.type("建个目录");
    await page.keyboard.press("Enter");
    await page.keyboard.type("再检查一下");
    const value = await ta.inputValue();
    check(
      "回车是换行：消息没发出去，输入框里是两行",
      value === "建个目录\n再检查一下" &&
        (await page.locator(".ch-user, [data-role='user']").count()) === 0,
      JSON.stringify(value),
    );
    await page.getByRole("button", { name: "发送" }).click();

    // 4) 审批卡 → 返回列表 → 「需要你」
    await page
      .waitForSelector("[data-approval], .ch-approval, .ch-prompt", {
        timeout: 15000,
      })
      .catch(() => {});
    await sleep(1500);
    await shot("3-approval");
    const approve = await page.evaluate(() =>
      [...document.querySelectorAll(".ch-approve .u-btn")].map((b) => {
        const r = b.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      }),
    );
    check(
      "审批卡的按钮触控目标 ≥ 48×48",
      approve.length >= 2 && approve.every(([w, h]) => w >= 47.5 && h >= 47.5),
      JSON.stringify(approve),
    );
    await page.goBack();
    await page.waitForSelector(".m-row");
    await page
      .waitForSelector('.m-sec[aria-label="需要你"]', { timeout: 10000 })
      .catch(() => {});
    const needs = await page.evaluate(() => {
      const sec = document.querySelector('.m-sec[aria-label="需要你"]');
      return sec
        ? { rows: sec.querySelectorAll(".m-row").length, text: sec.textContent }
        : null;
    });
    check(
      "审批挂着：列表顶上出现「需要你」区，带工作区名",
      needs !== null && needs.rows === 1 && needs.text.includes("甲"),
      JSON.stringify(needs),
    );
    await shot("4-needs");
    await page.locator('.m-sec[aria-label="需要你"] .m-row').click();
    await page.waitForSelector(".ch-shell");
    check("点「需要你」里的行回到那个对话", /^\/m\/s\//.test(path()), path());

    // 5) 状态抽屉占一条历史
    await page.getByRole("button", { name: "状态" }).click();
    await page.waitForSelector(".u-sheet");
    check(
      "点状态：升起抽屉，URL 带 ?layer=status",
      path().endsWith("?layer=status"),
      path(),
    );
    await sleep(400);
    await shot("5-status");
    // 说明是伪元素生成的内容，不在 innerText 里
    const sheetNote = await page
      .locator(".u-sheet-body")
      .evaluate((el) => getComputedStyle(el, "::before").content);
    check(
      "状态抽屉没有内容时不是空白，有一句说明",
      sheetNote.includes("目前没有"),
      sheetNote,
    );
    await page.goBack();
    await sleep(400);
    check(
      "系统返回关掉抽屉而不是离开对话页",
      (await page.locator(".u-sheet").count()) === 0 &&
        /^\/m\/s\/[^/]+$/.test(path()),
      path(),
    );

    // 6) 深链接
    const sid = path().split("/").pop();
    await page.goto(`${origin}/m/s/${sid}`);
    await page.waitForSelector(".ch-shell");
    await page.goBack();
    await page.waitForSelector(".m-row");
    check("直接打开深链接：返回落在列表", path() === "/m/", path());

    // 7) 设置页
    await page.getByRole("button", { name: "设置" }).click();
    await page.waitForSelector('.m-line:has-text("测试手机")');
    const access = await page.locator(".m-line").allTextContents();
    check(
      "设置页：显示这台设备的名字与访问方式",
      access.some((t) => t.includes("测试手机")) &&
        access.some((t) => t.includes("明文") || t.includes("HTTPS")),
      access.join(" | "),
    );
    await shot("6-settings");
    await page.goBack();
    await page.waitForSelector(".m-row");
    check("设置页返回回到列表", path() === "/m/", path());

    // W2) 工具抽屉与标签页
    await page.goto(`${origin}/m/`);
    await page.waitForSelector(".m-row");
    await page.getByRole("button", { name: "甲 的工具" }).click();
    await page.waitForSelector(".u-sheet");
    const tools = await page.evaluate(() =>
      [...document.querySelectorAll(".u-sheet .m-row")].map((r) => ({
        t: r.textContent,
        h: Math.round(r.getBoundingClientRect().height),
      })),
    );
    check(
      "列表上工作区头的工具抽屉：文件 / 终端 / 浏览器 / 画布，行高 ≥ 48，没有审计",
      tools.map((r) => r.t).join(",") === "文件,终端,浏览器,画布" &&
        tools.every((r) => r.h >= 48) &&
        path().includes("layer=tools"),
      JSON.stringify(tools),
    );
    await sleep(400);
    await shot("7-tools-list");
    await page.locator(".u-sheet .m-row", { hasText: "文件" }).click();
    await page.waitForSelector(".ws-fm");
    check(
      "选「文件」：文件页取代抽屉这一层，列表里点出的文件在里面",
      path().startsWith("/m/t/files") && !path().includes("layer="),
      path(),
    );
    await page.getByText("readme.md").waitFor();
    await shot("8-files");
    await page.getByText("readme.md").click();
    await page.getByText("这是一份说明。").waitFor();
    check("文件页点文件进预览页", path().startsWith("/m/t/preview"), path());
    await shot("9-preview");
    await page.goBack();
    await page.waitForSelector(".ws-fm");
    await page.goBack();
    await page.waitForSelector(".m-row");
    check("预览 → 文件 → 返回两次回到列表", path() === "/m/", path());

    // 对话页的工具：终端、画布、审计
    await page.getByText("甲的会话 6").click();
    await page.waitForSelector(".ch-shell");
    const chatPath = path();
    await page.getByRole("button", { name: "工具" }).click();
    await page.waitForSelector(".u-sheet");
    const chatTools = await page.locator(".u-sheet .m-row").allTextContents();
    check(
      "对话页的工具抽屉多一个「审计」",
      chatTools.join(",") === "文件,终端,浏览器,画布,审计",
      chatTools.join(","),
    );
    await page.locator(".u-sheet .m-row", { hasText: "终端" }).click();
    await page.waitForSelector(".ws-term");
    await shot("10-term");
    const termOk = await until(
      () =>
        page
          .locator(".ws-term .xterm")
          .count()
          .then((n) => n > 0),
      15000,
    );
    check(
      "终端页：xterm 出来了",
      termOk && path().startsWith("/m/t/term"),
      path(),
    );
    await page.goBack();
    await page.waitForSelector(".ch-shell");
    check("终端 → 返回回到发起它的对话页（一次）", path() === chatPath, path());

    await page.getByRole("button", { name: "工具" }).click();
    await page.locator(".u-sheet .m-row", { hasText: "画布" }).click();
    await page.waitForSelector(".cv", { timeout: 15000 });
    await shot("11-canvas");
    check("画布页能打开", path().startsWith("/m/t/canvas"), path());
    await page.goBack();
    await page.waitForSelector(".ch-shell");

    await page.getByRole("button", { name: "工具" }).click();
    await page.locator(".u-sheet .m-row", { hasText: "审计" }).click();
    await page.waitForSelector(".ch-shell");
    check(
      "审计：同一个会话的审计视图，标题带「审计」，返回回到对话",
      path() === `${chatPath}?audit=1` &&
        (
          await page.locator(".m-layer:not([hidden]) .m-top-title").innerText()
        ).startsWith("审计"),
      path(),
    );
    await shot("12-audit");
    await page.goBack();
    check("审计 → 返回回到对话", path() === chatPath, path());
    await page.goBack();
    await page.waitForSelector(".m-row");

    // 审计里有调用记录的会话：调用序列在上、详情在下，没有横向滚动
    await page.locator('.m-sec[aria-label="需要你"] .m-row').click();
    await page.waitForSelector(".ch-shell");
    await page.getByRole("button", { name: "工具" }).click();
    await page.locator(".u-sheet .m-row", { hasText: "审计" }).click();
    await page.waitForSelector(".au-rail");
    await sleep(600);
    const audit = await page.evaluate(() => {
      const rail = document.querySelector(".au-rail")?.getBoundingClientRect();
      const au = document.querySelector(".au")?.getBoundingClientRect();
      return {
        narrow: document.querySelector(".au")?.hasAttribute("data-narrow"),
        railW: rail && au ? Math.round((rail.width / au.width) * 100) : 0,
        overflowX:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      };
    });
    check(
      "有调用记录的审计：窄容器里上下堆叠（调用序列占满宽度），没有横向滚动",
      audit.narrow === true && audit.railW >= 99 && !audit.overflowX,
      JSON.stringify(audit),
    );
    await shot("12b-audit-calls");
    await page.goBack();
    await page.goBack();
    await page.waitForSelector(".m-row");

    // 长按会话行：置顶 / 归档
    const target = page.locator(".m-row", { hasText: "乙的会话 1" });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const cdp = await context.newCDPSession(page);
    const pt = [{ x: box.x + 40, y: box.y + box.height / 2, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: pt,
    });
    await sleep(700);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForSelector(".u-sheet");
    check(
      "长按会话行：出「置顶 / 归档」，不进对话",
      path().includes("layer=row") &&
        (await page.locator(".u-sheet .m-row").allTextContents()).join(",") ===
          "置顶,归档",
      path(),
    );
    await sleep(400);
    await shot("13-row-menu");
    await page.locator(".u-sheet .m-row", { hasText: "置顶" }).click();
    await page.waitForSelector(".u-sheet", { state: "detached" });
    const pinned = (await api("GET", "/sessions")).sessions.find(
      (x) => x.title === "乙的会话 1",
    );
    check(
      "置顶：服务端那条会话 pinned 为真，抽屉关掉",
      pinned?.pinned === true && path() === "/m/",
    );

    const deviceToken = paired.token;
    const whoami = async (token) =>
      (
        await fetch(`${origin}/api/v1/auth/whoami`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;
    const gateShown = () =>
      page
        .waitForSelector('.sh-gate input[type="password"]', { timeout: 8000 })
        .then(() => true)
        .catch(() => false);

    // 9) 退出此设备（之后的 401 是预期的，不再收集）
    collecting = false;
    await page.getByRole("button", { name: "设置" }).click();
    await page.waitForSelector(".m-line");
    await page.getByRole("button", { name: "退出此设备" }).click();
    await page.getByRole("button", { name: "再点一次确认退出" }).click();
    const signedOut = await gateShown();
    check(
      "退出此设备：回到令牌门，服务端删掉设备，旧令牌 401，本机令牌清掉",
      signedOut &&
        (await api("GET", "/devices")).devices.length === 0 &&
        (await whoami(deviceToken)) === 401 &&
        (await page.evaluate(() => localStorage.getItem("yuanshu.token"))) ===
          null,
    );

    // 10) 桌面撤销：重新配对一台，页面开着时被撤销
    const again = await api("POST", "/devices/pairing", {});
    await page.goto(`${origin}/m/?pair=${again.code}`);
    await page.waitForSelector(".sh-gate input");
    await page.getByRole("button", { name: "添加" }).click();
    await page.waitForSelector(".m-row");
    const second = (await api("GET", "/devices")).devices[0];
    const secondToken = await page.evaluate(() =>
      localStorage.getItem("yuanshu.token"),
    );
    const del = await fetch(`${origin}/api/v1/devices/${second.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await sleep(500);
    await page.goto(`${origin}/m/`);
    check(
      "桌面撤销：接口 204，旧令牌 401，再打开 /m/ 回到令牌门",
      del.status === 204 &&
        (await whoami(secondToken)) === 401 &&
        (await gateShown()),
      `delete ${del.status}`,
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
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  await fake.close();
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
    : `\nPASS  手机端：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
