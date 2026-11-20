// brand-spec 视觉规则里需要真实布局的部分（packages/web/src/visual-rules.test.ts 的 VR19–VR24），在真浏览器里检查：
//  VR19 同屏只有一个实心按钮（蓝 / 墨）  VR22 左轨与工作区平铺（外缝内缝 0）
//  VR20 四档视口无横向滚动           VR23 控件高度 22–36px（旧 24–32 与新刻度 28/32/36 都放行）
//  VR21 rail 宽 252 / ≤1120 收为 62 / ≤900 转顶部 strip   VR24 无全局顶栏、无底部状态条
// 起一个真实 Server（临时数据目录）+ 无头 Chromium，不需要真实模型。
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-visual.mjs [--shots <目录>]    （--shots 额外保存每屏截图）
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  [1280, 800],
  [1024, 768],
  [780, 800],
  [560, 800],
];
const SETTINGS = [
  "providers",
  "remote",
  "variables",
  "tools",
  "studio",
  "defaults",
];

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "visual-"));
const work = join(base, "work");
mkdirSync(work, { recursive: true });
const port = 17800 + Math.floor(Math.random() * 90);
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
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await r.text();
  if (!r.ok)
    throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 120)}`);
  return t ? JSON.parse(t) : undefined;
};

// 结果按规则聚合：{ 规则: [违例描述] }
const violations = {};
const seen = {};
const bad = (rule, msg) => {
  violations[rule] = [...(violations[rule] ?? []), msg];
};
const hit = (rule) => {
  seen[rule] = (seen[rule] ?? 0) + 1;
};

// 页面内取证：一次 evaluate 里把所有规则要的事实收齐
const probe = () => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      cs.visibility !== "hidden" &&
      cs.display !== "none" &&
      cs.opacity !== "0"
    );
  };
  // 解析出 --accent（旧主按钮）与 --ink（新主按钮）的实际渲染色，拿来和按钮底色比
  const solid = ["--accent", "--ink"].map((v) => {
    const e = document.createElement("i");
    e.style.color = `var(${v})`;
    document.body.append(e);
    const c = getComputedStyle(e).color;
    e.remove();
    return c;
  });
  const blue = [...document.querySelectorAll("button, [role=button]")]
    .filter(
      (b) =>
        visible(b) &&
        !b.disabled &&
        solid.includes(getComputedStyle(b).backgroundColor),
    )
    .filter((b) => b.getBoundingClientRect().width >= 44) // 开关、进度点这类小件不是「按钮」
    .map((b) =>
      (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 16),
    );
  const ctl = [
    ...document.querySelectorAll("button.u-btn, input.u-inp, select.u-inp"),
  ]
    .filter(visible)
    .map((e) => ({
      h: Math.round(e.getBoundingClientRect().height * 10) / 10,
      sm: e.dataset.size === "sm",
      name: (
        e.innerText ||
        e.getAttribute("aria-label") ||
        e.placeholder ||
        e.className
      )
        .toString()
        .slice(0, 20),
    }));
  const bars = [...document.querySelectorAll("*")]
    .filter((e) => {
      const cs = getComputedStyle(e);
      if (cs.position !== "fixed" && cs.position !== "sticky") return false;
      const r = e.getBoundingClientRect();
      return (
        r.width >= innerWidth * 0.9 &&
        r.height <= 64 &&
        r.height > 8 &&
        (r.top <= 1 || r.bottom >= innerHeight - 1) &&
        !e.closest("[role=dialog]")
      );
    })
    .map((e) => e.className.toString().slice(0, 30));
  const rail = document.querySelector(".rl");
  const app = document.querySelector(".sh-app");
  const cs = app && getComputedStyle(app);
  return {
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: innerWidth,
    blue,
    ctl,
    bars,
    rail: rail && {
      w: Math.round(rail.getBoundingClientRect().width),
      strip: app && getComputedStyle(app).flexDirection === "column",
    },
    app: cs && { pad: cs.paddingLeft, gap: cs.columnGap, rowGap: cs.rowGap },
  };
};

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
  // 假模型：只为让会话能创建，从不发请求
  const m = await api("POST", "/models", {
    name: "visual",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    modelId: "x",
    reasoning: false,
    input: ["text"],
  });
  await api("PATCH", `/models/${m.id}`, { isDefault: true });
  const ws = await api("POST", "/directories", {
    path: work,
    environmentId: "local",
  });
  const s = await api("POST", "/sessions", {
    directoryId: ws.id,
    name: "visual-check",
  });
  console.log(
    `会话 ${s.id.slice(0, 8)} 已建，开始逐屏检查（${VIEWPORTS.length} 档视口）`,
  );

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    for (const [w, h] of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const check = async (screen) => {
        await sleep(350);
        const f = await page.evaluate(probe);
        const where = `${w}px ${screen}`;
        hit("VR20");
        if (f.scrollW > f.innerW || f.bodyScrollW > f.innerW)
          bad(
            "VR20",
            `${where}: scrollWidth ${f.scrollW}/${f.bodyScrollW} > ${f.innerW}`,
          );
        hit("VR19");
        if (f.blue.length > 1)
          bad(
            "VR19",
            `${where}: ${f.blue.length} 个实心按钮 [${f.blue.join(" | ")}]`,
          );
        hit("VR23");
        for (const c of f.ctl)
          if (c.h > 36 || c.h < 22)
            bad("VR23", `${where}: 「${c.name}」高 ${c.h}px`);
        hit("VR24");
        if (f.bars.length)
          bad("VR24", `${where}: 贴边的全宽条 ${f.bars.join(", ")}`);
        if (screen === "workspace") {
          hit("VR21");
          const want = w > 1120 ? 252 : w > 900 ? 62 : null;
          if (want !== null && f.rail?.w !== want)
            bad("VR21", `${where}: rail 宽 ${f.rail?.w}，应为 ${want}`);
          if (want === null && !f.rail?.strip)
            bad("VR21", `${where}: ≤900 时应转为顶部 strip`);
          hit("VR22");
          if (f.app?.pad !== "0px" || !["normal", "0px"].includes(f.app?.gap))
            bad("VR22", `${where}: 外缝 ${f.app?.pad} / 内缝 ${f.app?.gap}`);
        }
        if (SHOTS)
          await page.screenshot({ path: join(SHOTS, `${w}-${screen}.png`) });
      };

      await page.goto(origin);
      await page.waitForSelector(".sh-app");
      await page.waitForSelector(".rl .rl-row, .rl .rl-mi");
      await page.waitForSelector(".ch-shell, .ws-pn");
      await check("workspace");
      await page.getByRole("button", { name: /^审计/ }).click();
      await check("audit");
      await page.getByRole("button", { name: "对话", exact: true }).click();
      // ≤900px 时左轨变成顶部条，新建入口只剩命令面板，所以两个弹窗都走 ⌘K
      const viaPalette = async (label, title) => {
        await page.keyboard.press("Control+k");
        await page.waitForSelector("[role=dialog]");
        // 面板每次打开才清空上一次的查询（effect），等它清完再打字，免得新字接在旧查询后面
        await page.waitForFunction(
          () => document.querySelector("[role=dialog] input")?.value === "",
        );
        await page.keyboard.type(label);
        await page.keyboard.press("Enter");
        await page.locator(".u-mtitle", { hasText: title }).waitFor();
      };
      // 关掉弹窗要等它真的从 DOM 里离开，再开命令面板：否则 Ctrl+K 与上一个弹窗的收起抢同一帧
      const closeDialog = async () => {
        // 弹窗的 Esc 监听在渲染后的 effect 里才登记，刚出现就按 Esc 会落空：先等一小会
        await page.waitForTimeout(300);
        await page.keyboard.press("Escape");
        await page.locator(".u-mtitle").waitFor({ state: "detached" });
      };
      await viaPalette("新建会话（带配置）", "新对话");
      await check("session-dialog");
      await closeDialog();
      await viaPalette("新建工作区", "新建工作区");
      await check("workspace-dialog");
      await closeDialog();
      await page.keyboard.press("Control+k");
      await page.waitForSelector("[role=dialog]");
      await check("palette");
      await page.keyboard.press("Escape");
      for (const p of SETTINGS) {
        await page.evaluate((path) => {
          history.pushState(null, "", `/settings/${path}`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, p);
        await check(`settings-${p}`);
      }
      await page.close();
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

const rules = ["VR19", "VR20", "VR21", "VR22", "VR23", "VR24"];
const names = {
  VR19: "同屏只有一个实心按钮（蓝 / 墨）",
  VR20: "四档视口无横向滚动",
  VR21: "rail 宽 252 / 62 / 顶部 strip",
  VR22: "左轨与工作区平铺（外缝内缝 0）",
  VR23: "控件高度 22–36px",
  VR24: "无全局顶栏与底部状态条",
};
let failed = 0;
for (const r of rules) {
  const v = violations[r] ?? [];
  if (!seen[r]) v.push("没有检查到任何屏次（选择器失效？）");
  failed += v.length ? 1 : 0;
  console.log(
    `${v.length ? "FAIL" : "PASS"}  ${r} ${names[r]}  （检查 ${seen[r] ?? 0} 屏次）`,
  );
  for (const line of v.slice(0, 8)) console.log(`      ${line}`);
  if (v.length > 8) console.log(`      …另有 ${v.length - 8} 处`);
}
if (crashed) {
  console.log(`脚本异常：${crashed.message}`);
  failed++;
}
console.log(`\n${rules.length - failed}/${rules.length} 条通过`);
process.exit(failed ? 1 : 0);
