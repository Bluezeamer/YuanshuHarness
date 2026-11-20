// 手机端（/m/）的版面扫描：起真实 Server（临时数据目录）+ 假模型 + 无头 Chromium，不需要真实模型。
// 手机的屏宽各不相同，组件在窄屏上「挤出」边框、被截断、把弹窗撑出屏幕，只在某些宽度才出现。
// 这里把各页面与弹窗在 320 / 360 / 375 / 390 / 412 / 430 六种宽度下各开一遍，逐个元素量，找出：
//   page   整页出现横向滚动
//   out    元素伸出了屏幕左右边（且没有一个自己在屏内的滚动容器兜着它）
//   spill  元素伸出了它父容器的内容区（没有滚动容器兜着）：按钮挤出输入卡、标题盖到图标上之类
//   clip   overflow: hidden 的容器里文字被截断而没有省略号（有 text-overflow: ellipsis 的是有意的）
// 数据里故意放了很长的模型名、会话标题、工作区名与不能折行的长串，因为真实使用里它们就是这样。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-mobile-layout.mjs [--shots 目录] [--widths 320,390]
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
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SHOTS = argOf("--shots") ? resolve(argOf("--shots")) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WIDTHS = (argOf("--widths") ?? "320,360,375,390,412,430")
  .split(",")
  .map(Number);
const HEIGHT = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "mlayout-"));
const work = `${realpathSync(base)}/work`;
const DIR = `${work}/甲`;
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, "readme.md"), "# 你好，手机\n\n这是一份说明。\n");
writeFileSync(
  join(
    DIR,
    "a-very-long-file-name-that-keeps-going-and-going-without-any-break-1234567890.txt",
  ),
  "x\n",
);

const LONG_TITLE =
  "一个很长很长的会话标题，用来看顶栏与列表行遇到长标题时会不会把别的东西挤出去";
const LONG_URL =
  "https://example.com/a/very/long/path/that/cannot/wrap/because/it/has/no/spaces/at/all/index.html?query=1234567890abcdef&another=value";
// 第一轮：长正文（长串、宽表格、宽代码行）+ 一条要审批的命令，让对话里同时有内容与审批卡
const fake = await startFakeModel(
  [
    {
      text: [
        "下面是各种不好折行的内容。",
        "",
        LONG_URL,
        "",
        "| 列一 | 列二 | 列三 | 列四 | 列五 |",
        "| --- | --- | --- | --- | --- |",
        "| 很长的单元格内容很长的单元格内容 | b | c | d | e |",
        "",
        "```",
        "const aVeryLongLineOfCode = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree);",
        "```",
        "",
        "路径 /home/user/projects/some-long-project-name/packages/server/src/some/deep/dir/file.ts 与 `inline-code-that-is-also-quite-long-and-has-no-break-points-at-all`。",
      ].join("\n"),
      tools: [
        {
          name: "bash",
          args: {
            command:
              "mkdir -p out && echo hi > out/a-long-file-name-that-keeps-going-and-going.txt && ls -la out",
          },
        },
      ],
    },
    { text: "完成。" },
  ],
  { delay: 5 },
);

const TOKEN = "m".repeat(40);
const port = 18300 + Math.floor(Math.random() * 90);
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
    env: { ...process.env, YUANSHU_TOKEN: TOKEN, HOME: base },
  },
);
const api = async (method, path, body, token = TOKEN) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

/** 在页面里跑的扫描：返回各类问题的元素描述。 */
function scanInPage(vw) {
  const found = [];
  const desc = (el) => {
    const cls = [...el.classList].slice(0, 2).join(".");
    const text = (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 14);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${text ? ` "${text}"` : ""}`;
  };
  const px = (v) => Number.parseFloat(v) || 0;
  const scrolls = (cs) => cs.overflowX === "auto" || cs.overflowX === "scroll";
  const clips = (cs) =>
    scrolls(cs) || cs.overflowX === "hidden" || cs.overflowX === "clip";

  // 兜住 el 的容器：滚动容器、或比屏幕窄的 overflow:hidden 容器（整屏外壳的 hidden 不算，它正是把东西悄悄剪掉的那个）
  const catcher = (el) => {
    for (
      let a = el.parentElement;
      a && a !== document.documentElement;
      a = a.parentElement
    ) {
      const cs = getComputedStyle(a);
      if (!clips(cs)) continue;
      if (scrolls(cs)) return a;
      const r = a.getBoundingClientRect();
      if (r.width < vw - 1) return a;
    }
    return null;
  };

  if (document.documentElement.scrollWidth > vw + 1)
    found.push({
      kind: "page",
      what: `scrollWidth ${document.documentElement.scrollWidth} > ${vw}`,
    });

  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.display === "contents") continue;
    if (cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (el.closest("[hidden],[aria-hidden='true'],svg")) continue;
    if (el.closest(".xterm,.react-flow__viewport,canvas")) continue;

    if ((r.right > vw + 1 || r.left < -1) && !catcher(el))
      found.push({
        kind: "out",
        el: desc(el),
        what: `x ${Math.round(r.left)}..${Math.round(r.right)} 屏宽 ${vw}`,
      });

    const p = el.parentElement;
    if (p && cs.position !== "absolute" && cs.position !== "fixed") {
      const pcs = getComputedStyle(p);
      if (!scrolls(pcs) && pcs.display !== "contents") {
        const pr = p.getBoundingClientRect();
        const right =
          pr.right - px(pcs.paddingRight) - px(pcs.borderRightWidth);
        const left = pr.left + px(pcs.paddingLeft) + px(pcs.borderLeftWidth);
        if (
          (r.right > right + 1 || r.left < left - 1) &&
          r.right <= vw + 1 &&
          r.left >= -1
        )
          found.push({
            kind: "spill",
            el: desc(el),
            what: `in ${desc(p)}: x ${Math.round(r.left)}..${Math.round(r.right)} 容器内容区 ${Math.round(left)}..${Math.round(right)}`,
          });
      }
    }

    if (
      (cs.overflowX === "hidden" || cs.overflowX === "clip") &&
      cs.textOverflow !== "ellipsis" &&
      el.scrollWidth > el.clientWidth + 1 &&
      r.width < vw - 1 &&
      el.clientWidth > 0
    )
      found.push({
        kind: "clip",
        el: desc(el),
        what: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`,
      });
  }
  return found;
}

// 场景：每个都从列表页重新开始，走到要扫的状态
const toList = async (page) => {
  await page.goto(`${origin}/m/`);
  await page.waitForSelector(".m-row");
  await sleep(300);
};
const openRich = async (page) => {
  await toList(page);
  await page.getByText(LONG_TITLE).first().click();
  await page.waitForSelector(".ch-ta");
  await page.waitForSelector(".ch-approve", { timeout: 15000 });
  await sleep(500);
};
const openTool = async (page, label) => {
  await toList(page);
  await page.getByRole("button", { name: "甲 的工具" }).click();
  await page.waitForSelector(".u-sheet");
  await page.locator(".u-sheet .m-row", { hasText: label }).click();
};
const SCENES = [
  ["list", toList],
  [
    "list-tools-sheet",
    async (page) => {
      await toList(page);
      await page.getByRole("button", { name: "甲 的工具" }).click();
      await page.waitForSelector(".u-sheet");
      await sleep(400);
    },
  ],
  [
    "chat-empty",
    async (page) => {
      await toList(page);
      await page.getByText("乙的会话 1").click();
      await page.waitForSelector(".ch-ta");
      await sleep(400);
    },
  ],
  ["chat-rich", openRich],
  [
    "chat-status-sheet",
    async (page) => {
      await openRich(page);
      await page.getByRole("button", { name: "状态" }).click();
      await page.waitForSelector(".u-sheet");
      await sleep(400);
    },
  ],
  [
    "chat-tools-sheet",
    async (page) => {
      await openRich(page);
      await page.getByRole("button", { name: "工具" }).click();
      await page.waitForSelector(".u-sheet");
      await sleep(400);
    },
  ],
  [
    "chat-model-picker",
    async (page) => {
      await openRich(page);
      await page.locator("[data-modelpick]").click();
      await sleep(500);
    },
  ],
  [
    "settings",
    async (page) => {
      await toList(page);
      await page.getByRole("button", { name: "设置" }).click();
      await page.waitForSelector(".m-line");
      await sleep(500);
    },
  ],
  [
    "files",
    async (page) => {
      await openTool(page, "文件");
      await page.waitForSelector(".ws-fm");
      await page.getByText("readme.md").waitFor();
      await sleep(400);
    },
  ],
  [
    "preview",
    async (page) => {
      await openTool(page, "文件");
      await page.getByText("readme.md").click();
      await page.getByText("这是一份说明。").waitFor();
      await sleep(400);
    },
  ],
  [
    "terminal",
    async (page) => {
      await openTool(page, "终端");
      await page.waitForSelector(".ws-term .xterm", { timeout: 15000 });
      await sleep(600);
    },
  ],
  [
    "canvas",
    async (page) => {
      await openTool(page, "画布");
      await page.waitForSelector(".cv", { timeout: 15000 });
      await sleep(600);
    },
  ],
  [
    "canvas-new-dialog",
    async (page) => {
      await openTool(page, "画布");
      await page.waitForSelector(".cv", { timeout: 15000 });
      await sleep(400);
      await page
        .getByRole("button", { name: /新建画布/ })
        .first()
        .click();
      await page.waitForSelector(".u-mcard");
      await sleep(500);
    },
  ],
  [
    "browser-pages",
    async (page) => {
      await openTool(page, "浏览器");
      await sleep(800);
    },
  ],
  [
    "audit",
    async (page) => {
      await openRich(page);
      await page.getByRole("button", { name: "工具" }).click();
      await page.locator(".u-sheet .m-row", { hasText: "审计" }).click();
      await sleep(800);
    },
  ],
];

const problems = new Map(); // `${kind} ${scene} ${el}` -> { widths, what }

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
        name: "Qwen3.8-27B-Instruct-2507-Long-Context",
        reasoning: true,
        levels: ["off", "low", "high"],
        input: ["text"],
        ctx: 262144,
        out: 4096,
        source: "manual",
      },
    ],
  });
  const ws = await api("POST", "/workspaces", {
    name: "甲",
    directories: [{ path: DIR }],
  });
  const long = await api("POST", "/workspaces", {
    name: "一个名字很长很长的工作区用来看列表头会不会挤",
    directories: [{ path: DIR }],
  });
  const rich = await api("POST", "/sessions", { workspaceId: ws.id });
  await api("PATCH", `/sessions/${rich.id}`, { title: LONG_TITLE });
  const plain = await api("POST", "/sessions", { workspaceId: ws.id });
  await api("PATCH", `/sessions/${plain.id}`, { title: "乙的会话 1" });
  await api("POST", "/sessions", { workspaceId: long.id });

  const pairing = await api("POST", "/devices/pairing", {});
  const paired = await api(
    "POST",
    "/devices/pair",
    { code: pairing.code, name: "版面扫描" },
    "",
  );
  const deviceToken = paired.token;

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const newContext = (width) =>
      browser.newContext({
        viewport: { width, height: HEIGHT },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      });

    // 先在一个手机上把富内容会话跑出来（发消息 → 长正文 + 待批准的命令），之后各宽度只读
    {
      const ctx = await newContext(390);
      await ctx.addInitScript(
        (t) => localStorage.setItem("yuanshu.token", t),
        deviceToken,
      );
      const page = await ctx.newPage();
      await page.goto(`${origin}/m/`);
      await page.waitForSelector(".m-row");
      await page.getByText(LONG_TITLE).first().click();
      await page.waitForSelector(".ch-ta");
      await page.locator(".ch-ta").fill("给我看各种长内容");
      await page.getByRole("button", { name: "发送" }).click();
      await page.waitForSelector(".ch-approve", { timeout: 20000 });
      await ctx.close();
    }

    for (const width of WIDTHS) {
      const ctx = await newContext(width);
      await ctx.addInitScript(
        (t) => localStorage.setItem("yuanshu.token", t),
        deviceToken,
      );
      const page = await ctx.newPage();
      for (const [name, go] of SCENES) {
        try {
          await go(page);
        } catch (e) {
          const key = `broke ${name} -`;
          const rec = problems.get(key) ?? {
            widths: [],
            what: String(e.message).split("\n")[0],
          };
          rec.widths.push(width);
          problems.set(key, rec);
          continue;
        }
        if (SHOTS)
          await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`) });
        for (const f of await page.evaluate(scanInPage, width)) {
          const key = `${f.kind} ${name} ${f.el ?? ""}`;
          const rec = problems.get(key) ?? { widths: [], what: f.what };
          rec.widths.push(width);
          problems.set(key, rec);
        }
      }
      await ctx.close();
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
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  await fake.close();
  rmSync(base, { recursive: true, force: true });
}

for (const [key, rec] of problems)
  console.log(`FAIL  ${key}  宽 ${rec.widths.join("/")}  — ${rec.what}`);
check(
  `版面：${SCENES.length} 个场景 × ${WIDTHS.length} 种宽度没有伸出、挤出、截断`,
  problems.size === 0,
  `${problems.size} 处`,
);
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = results.filter((r) => !r).length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 项`
    : `\nPASS  手机版面：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
