// 标签缩放（Ctrl+滚轮）在预览里的图片 / SVG 与终端上的真机检查：起真实 Server（临时数据目录，真 PTY）+ 无头 Chromium，不需要真实模型。
// 对话 / 代码这类靠字号变量的缩放见 verify-chat.mjs；这里量的是 jsdom 看不出的真实尺寸：
//  1) 图片：比窗格宽的图，基准是窗格宽度；放大后比窗格宽、能横向滚动，且左边没有被裁掉；角标出现，点角标回到基准
//  2) 图片：比窗格窄的小图，基准是原尺寸（不放大）；放大按比例变大
//  3) SVG（渲染态）：只有 viewBox 与带固定宽高的两种，都按比例放大，溢出的部分左边没有被裁掉
//  4) 终端：Ctrl+滚轮后字号变大（行高随之变大）、屏幕尺寸重新算（列数变少）；点角标回到原样
//  5) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-tab-zoom.mjs [--shots 目录]
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
import { crc32, deflateSync } from "node:zlib";
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

// 最小的纯色 PNG：不依赖任何图片库
function png(w, h) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const body = Buffer.concat([head.subarray(4), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([head.subarray(0, 4), body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x66)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "tabzoom-"));
const real = realpathSync(base);
const work = join(real, "work");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "wide.png"), png(1600, 1000));
writeFileSync(join(work, "small.png"), png(200, 100));
writeFileSync(
  join(work, "viewbox.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#6688cc"/></svg>',
);
writeFileSync(
  join(work, "sized.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="#cc8866"/></svg>',
);

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
    join(real, "data"),
  ],
  { stdio: "ignore", cwd: work, env: { ...process.env, HOME: real } },
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
    name: "缩放",
    directories: [{ path: work }],
  });
  await api("POST", "/sessions", { workspaceId: ws.id });

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
    // 截图前等动画落定
    const shot = async (name) => {
      if (!SHOTS) return;
      await sleep(400);
      await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "缩放" }).click();
    await page.waitForSelector(".ws-fm-row");
    await sleep(800);

    // 在 (x, y) 上按住 Ctrl 滚 n 格：负 = 放大
    const zoomAt = async (x, y, ticks) => {
      await page.mouse.move(x, y);
      await page.keyboard.down("Control");
      for (let i = 0; i < Math.abs(ticks); i++) {
        await page.mouse.wheel(0, ticks < 0 ? -100 : 100);
        await sleep(80);
      }
      await page.keyboard.up("Control");
      await sleep(250);
    };
    const badge = () => page.getByRole("button", { name: /^\d+%$/ });
    // 预览里图片的实际尺寸与滚动情况
    const img = () =>
      page.evaluate(() => {
        const el = document.querySelector(".ws-pv-imgbox img, .ws-pv-svgb img");
        // SVG 的滚动容器是渲染区自己，图片预览是 .ws-pv-body
        const body = el?.closest(".ws-pv-svgb") ?? el?.closest(".ws-pv-body");
        if (!el || !body) return null;
        const r = el.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          left: Math.round(r.left - b.left),
          bodyW: Math.round(b.width),
          scrollW: body.scrollWidth,
          clientW: body.clientWidth,
          cx: Math.round(b.left + b.width / 2),
          cy: Math.round(b.top + b.height / 2),
        };
      });
    const openFile = async (name) => {
      await page
        .locator(`.ws-fm-row[data-name="${name}"] .u-lrow-main`)
        .dblclick();
      if (name.endsWith(".svg")) {
        // SVG 默认是源码编辑态，点「预览」才是渲染图
        await page.getByRole("radio", { name: "预览" }).click();
        await page.waitForSelector(".ws-pv-svgb img", { timeout: 8000 });
      } else await page.waitForSelector(".ws-pv-imgbox img", { timeout: 8000 });
      await sleep(600);
    };

    // 1) 比窗格宽的图
    await openFile("wide.png");
    let a = await img();
    check(
      "宽图：基准是窗格宽度（不超出）",
      a !== null && a.w <= a.bodyW && a.w > a.bodyW * 0.8,
      JSON.stringify(a),
    );
    await shot("1-wide-base");
    await zoomAt(a.cx, a.cy, -5);
    let b = await img();
    check(
      "宽图 Ctrl+滚轮放大 5 格：比基准大约 1.5 倍，比窗格宽、能横向滚动",
      b.w > a.w * 1.4 && b.w < a.w * 1.6 && b.scrollW > b.clientW,
      JSON.stringify([a.w, b]),
    );
    check(
      "放大后左边没有被裁掉（图的左缘不在窗格左缘之外）",
      b.left >= 0,
      `left=${b.left}`,
    );
    check(
      "窗格里出现比例角标 150%",
      (await badge().first().textContent())?.trim() === "150%",
    );
    await shot("2-wide-zoomed");
    await badge().first().click();
    await sleep(300);
    b = await img();
    check("点角标：回到基准宽度", Math.abs(b.w - a.w) <= 1, JSON.stringify(b));

    // 2) 比窗格窄的小图
    await openFile("small.png");
    a = await img();
    check(
      "小图：基准是原尺寸 200（不被放大去填窗格）",
      a !== null && a.w === 200,
      JSON.stringify(a),
    );
    await zoomAt(a.cx, a.cy, -5);
    b = await img();
    check(
      "小图放大 5 格：300（原尺寸的 1.5 倍）",
      b.w === 300,
      JSON.stringify(b),
    );
    await badge().first().click();

    // 3) SVG（渲染态）
    for (const name of ["viewbox.svg", "sized.svg"]) {
      await openFile(name);
      a = await img();
      await zoomAt(a.cx, a.cy, -5);
      b = await img();
      check(
        `${name}：放大 5 格后比基准大约 1.5 倍，图片盒贴着图形（宽高比 4:3，不被拉成整个窗格那么高）`,
        b.w > a.w * 1.4 &&
          b.w < a.w * 1.6 &&
          b.left >= 0 &&
          Math.abs(b.w / b.h - 4 / 3) < 0.02,
        JSON.stringify([a, b]),
      );
      await shot(`3-${name}`);
      await badge().first().click();
      await sleep(200);
    }

    // 4) 终端：「+」菜单新建本机终端
    await page.getByRole("button", { name: "新建标签页" }).first().click();
    await page.getByRole("menuitem", { name: "终端" }).click();
    // 菜单可能还要选主机（只有一台时直接建）
    const hostPick = page.getByRole("menuitem", { name: /本机|Server/ });
    if (await hostPick.count()) await hostPick.first().click();
    await page.waitForSelector(".xterm-rows", { timeout: 15000 });
    await sleep(1200);
    const term = () =>
      page.evaluate(() => {
        const rows = document.querySelector(".xterm-rows");
        const first = rows?.firstElementChild;
        const screen = document.querySelector(".ws-term-screen");
        const r = screen?.getBoundingClientRect();
        return {
          rowH: Math.round(first?.getBoundingClientRect().height ?? 0),
          rowCount: rows?.childElementCount ?? 0,
          cx: Math.round((r?.left ?? 0) + (r?.width ?? 0) / 2),
          cy: Math.round((r?.top ?? 0) + (r?.height ?? 0) / 2),
        };
      });
    const t0 = await term();
    await shot("4-term-base");
    await zoomAt(t0.cx, t0.cy, -5);
    const t1 = await term();
    check(
      "终端 Ctrl+滚轮放大 5 格：行高变大、行数变少（字号变了、屏幕尺寸重新算过）",
      t1.rowH > t0.rowH * 1.3 && t1.rowCount < t0.rowCount,
      JSON.stringify([t0, t1]),
    );
    check(
      "终端窗格里出现比例角标 150%",
      (await badge().first().textContent())?.trim() === "150%",
    );
    await shot("5-term-zoomed");
    await badge().first().click();
    await sleep(500);
    const t2 = await term();
    check(
      "点角标：终端回到原来的行高与行数",
      t2.rowH === t0.rowH && t2.rowCount === t0.rowCount,
      JSON.stringify([t0, t2]),
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
  rmSync(base, { recursive: true, force: true });
}

const uniq = [...new Set(problems)];
check(
  "全程没有控制台报错、没有失败的接口请求",
  uniq.length === 0,
  uniq.slice(0, 5).join(" | "),
);
if (crashed) {
  console.error(`脚本异常：${crashed.stack ?? crashed}`);
  process.exit(1);
}
const failed = results.filter((x) => !x).length;
console.log(
  failed
    ? `未通过：${failed} 项`
    : `PASS  标签缩放（图片 / SVG / 终端）：${results.length}/${results.length} 项通过`,
);
process.exit(failed ? 1 : 0);
