// 对话流的手感真机检查：起真实 Server（临时数据目录）+ 假模型 + 无头 Chromium，量 jsdom 测不出的滚动与布局。
//  1) 贴底时输入框被撑高：对话流仍贴在底部（跟随）；在历史中段时输入框被撑高：位置原样不动
//  2) 在历史中段发送消息：立即回到底部，并继续跟随这一轮的回复
//  3) 用户消息里单个换行 \n 就是换行
//  4) 贴底时点开工具组 / 工具行：被点的那一行留在原来的屏幕位置，不被跟随顶走；收起的组头跟着第一行的路径预览
//  5) 工具参数还在流式生成时点开运行态那一行：能看到目前的全部内容，框里跟到底，这一行不被顶出视口
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-chat-scroll.mjs [--shots 目录]
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
const base = mkdtempSync(join(root, "tmp", "chat-scroll-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });
// 临时 HOME：Server 读 <HOME>/.pi/agent，不碰真实的 ~/.pi（否则注册失败时会悄悄用上你的真实默认模型）
const home = join(base, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

// 每轮回复 20 段，段与段之间空一行：几轮下来对话流远高于视口，才有「中段」可言
const turn = (n) => ({
  text: `${Array.from({ length: 20 }, (_, k) => `第 ${n} 轮第 ${k + 1} 段，用来把对话流撑高。`).join("\n\n")}\n\n结束标记 END${n}`,
});
writeFileSync(
  join(work, "long.txt"),
  Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行内容`).join("\n"),
);
// 前 6 轮是纯文字；第 7 轮读一个长文件，第 8 轮收尾
const fake = await startFakeModel(
  [
    ...[1, 2, 3, 4, 5, 6].map(turn),
    { tools: [{ name: "read", args: { path: "long.txt" } }] },
    { text: "读完了。\n\n结束标记 ENDA" },
    {
      delay: 70,
      tools: [
        {
          name: "write",
          args: {
            path: "out.txt",
            content: Array.from(
              { length: 150 },
              (_, i) => `行${i + 1} 内容`,
            ).join("\n"),
          },
        },
      ],
    },
  ],
  { delay: 0 },
);

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
  { stdio: "ignore", cwd: work, env: { ...process.env, HOME: home } },
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
  const registered = await api("POST", "/providers", {
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

  if (registered?.error)
    throw new Error(`注册假模型失败：${JSON.stringify(registered)}`);

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
    const shot = (n) =>
      SHOTS ? page.screenshot({ path: join(SHOTS, `${n}.png`) }) : null;

    // 距底还有多少像素；scrollTop 取整数值
    const gap = () =>
      page.evaluate(() => {
        const el = document.querySelector("[data-chat-stream]");
        return el ? el.scrollHeight - el.scrollTop - el.clientHeight : NaN;
      });
    const top = () =>
      page.evaluate(
        () => document.querySelector("[data-chat-stream]")?.scrollTop ?? NaN,
      );
    const scrollTo = (y) =>
      page.evaluate((v) => {
        const el = document.querySelector("[data-chat-stream]");
        if (el) el.scrollTop = v;
      }, y);

    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(work);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);

    const box = page.locator("textarea").first();
    const ask = async (text, mark) => {
      await box.fill(text);
      await box.press("Enter");
      try {
        await page.getByText(mark).waitFor({ timeout: 30000 });
      } catch (e) {
        await shot(`fail-${mark}`);
        throw e;
      }
      await sleep(400);
    };
    // 三轮下来对话流明显高于视口
    await ask("问一", "END1");
    await ask("问二", "END2");
    await ask("问三", "END3");
    const tall = await page.evaluate(() => {
      const el = document.querySelector("[data-chat-stream]");
      return el ? el.scrollHeight / el.clientHeight : 0;
    });
    check(
      "前置：对话流高度是视口的 2 倍以上",
      tall >= 2,
      `${tall.toFixed(1)}x`,
    );

    const MANY = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`).join(
      "\n",
    );
    const taHeight = () =>
      box.evaluate((el) => el.getBoundingClientRect().height);

    // 1a) 贴底时输入框被撑高：仍在底部
    const g0 = await gap();
    check("贴底：回复完成后距底不超过 2px", g0 <= 2, `${g0}px`);
    const h0 = await taHeight();
    await box.fill(MANY);
    await sleep(400);
    const h1 = await taHeight();
    const g1 = await gap();
    await shot("1-grow-at-bottom");
    check("输入框确实被撑高了（前置）", h1 > h0 + 20, `${h0} → ${h1}`);
    check("贴底时输入框被撑高：对话流仍贴在底部", g1 <= 2, `距底 ${g1}px`);
    await box.fill("");
    await sleep(300);

    // 1a') 逐行敲入：每多一行都量一次，全程贴底（第一次多一行正好越过贴底阈值，是最容易漏的一步）
    await box.click();
    const gaps = [];
    for (let n = 1; n <= 5; n++) {
      await box.type(`第${n}行`);
      await box.press("Shift+Enter");
      await sleep(150);
      gaps.push(await gap());
    }
    check(
      "贴底时逐行敲入：每一行之后都仍贴底",
      gaps.every((g) => g <= 2),
      `距底 ${gaps.join(" / ")}`,
    );
    await box.fill("");
    await sleep(300);

    // 1b) 在历史中段时输入框被撑高：位置不动
    await scrollTo(Math.round((await top()) / 2));
    await sleep(300);
    const t0 = await top();
    await box.fill(MANY);
    await sleep(400);
    const t1 = await top();
    await shot("2-grow-in-middle");
    check(
      "在历史中段输入框被撑高：对话流位置不动",
      Math.abs(t1 - t0) <= 2,
      `${t0} → ${t1}`,
    );
    await box.fill("");
    await sleep(300);

    // 2) 在历史中段发送：立即回到底部，并继续跟随这一轮
    await scrollTo(Math.round((await top()) / 2));
    await sleep(300);
    const away0 = await gap();
    await box.fill("问四");
    await box.press("Enter");
    await page
      .locator(".ch-you .ch-bubble", { hasText: "问四" })
      .waitFor({ timeout: 10000 });
    await sleep(150);
    const g2 = await gap();
    check(
      "在历史中段发送：用户消息出现时已在底部",
      away0 > 200 && g2 <= 2,
      `发送前距底 ${away0}px，发送后 ${g2}px`,
    );
    await page.getByText("END4").waitFor({ timeout: 30000 });
    await sleep(400);
    const g3 = await gap();
    check("发送之后继续跟随回复到底", g3 <= 2, `${g3}px`);

    // 3a) 很长的一行（含没有空格的长串）：自动在气泡里折行，不撑出气泡
    const LONG = `很长的一行${"字".repeat(160)} ${"x".repeat(120)}`;
    await box.fill(LONG);
    await box.press("Enter");
    await page.getByText("END5").waitFor({ timeout: 30000 });
    await sleep(400);
    const wrap = await page.evaluate(() => {
      const all = [...document.querySelectorAll(".ch-you .ch-bubble")];
      const el = all.find((b) => (b.textContent ?? "").includes("很长的一行"));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const col = el.closest(".ch-you")?.getBoundingClientRect();
      return {
        overflow: el.scrollWidth - el.clientWidth,
        inColumn: !!col && r.right <= col.right + 1,
        lines: Math.round(r.height / 24),
      };
    });
    check(
      "用户消息：长行自动折行，不撑出气泡",
      !!wrap && wrap.overflow <= 1 && wrap.inColumn && wrap.lines >= 3,
      JSON.stringify(wrap),
    );

    // 3) 用户消息里单个 \n 就是换行
    await box.fill("甲行\n乙行\n丙行");
    await box.press("Enter");
    await page.getByText("END6").waitFor({ timeout: 30000 });
    await sleep(400);
    const bubble = await page.evaluate(() => {
      const all = [...document.querySelectorAll(".ch-you .ch-bubble")];
      const el = all.find((b) => (b.textContent ?? "").includes("甲行"));
      return el
        ? { text: el.innerText, h: el.getBoundingClientRect().height }
        : null;
    });
    await shot("3-user-newlines");
    check(
      "用户消息：单个换行显示成换行",
      !!bubble && bubble.text.split("\n").filter(Boolean).length === 3,
      JSON.stringify(bubble?.text),
    );

    // 4) 贴底时点开工具组、再点开里面那一行：被点的行不能被顶出视口
    await box.fill("读一下 long.txt");
    await box.press("Enter");
    await page.getByText("ENDA").waitFor({ timeout: 30000 });
    await sleep(500);
    const rowTop = (text) =>
      page.evaluate((t) => {
        const el = [
          ...document.querySelectorAll(".ch-stream .u-lrow-main"),
        ].find((b) => (b.textContent ?? "").includes(t));
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      }, text);
    const g4 = await gap();
    const groupBefore = await rowTop("读取了");
    check("前置：点开之前是贴底的", g4 <= 2 && groupBefore !== null, `${g4}px`);
    const groupHead = await page
      .locator(".ch-stream .u-lrow-main", { hasText: "读取了" })
      .textContent();
    check(
      "收起的工具组头跟着第一行的路径预览",
      (groupHead ?? "").includes("long.txt"),
      JSON.stringify(groupHead),
    );
    await page
      .locator(".ch-stream .u-lrow-main", { hasText: "读取了" })
      .click();
    await sleep(300);
    const groupAfter = await rowTop("读取了");
    check(
      "贴底点开工具组：组头留在原位",
      groupAfter !== null && Math.abs(groupAfter - groupBefore) <= 2,
      `${groupBefore} → ${groupAfter}`,
    );
    const lineBefore = await rowTop("long.txt");
    await page
      .locator(".ch-stream .u-lrow-main", { hasText: "long.txt" })
      .click();
    await sleep(300);
    const lineAfter = await rowTop("long.txt");
    await shot("4-expanded-line");
    check(
      "贴底点开工具行（输出很长）：这一行留在原位，不被顶出视口",
      lineAfter !== null && Math.abs(lineAfter - lineBefore) <= 2,
      `${lineBefore} → ${lineAfter}`,
    );
    const away = await page.getByRole("button", { name: "回到底部" }).count();
    check("点开后内容在下方，出现「回到底部」", away === 1, `${away}`);
    await page.getByRole("button", { name: "回到底部" }).click();
    await sleep(300);
    check("点「回到底部」回到底部", (await gap()) <= 2);

    // 5) 参数还在流式生成时点开运行态那一行
    await box.fill("写一个 out.txt");
    await box.press("Enter");
    const liveRow = page.locator(".ch-live .u-lrow-main");
    await liveRow.waitFor({ timeout: 30000 });
    await liveRow.click();
    const bodyBox = page.locator(".ch-live-body");
    await bodyBox.waitFor({ timeout: 5000 });
    const sample = () =>
      page.evaluate(() => {
        const b = document.querySelector(".ch-live-body");
        const row = document.querySelector(".ch-live .u-lrow-main");
        const st = document.querySelector("[data-chat-stream]");
        if (!b || !row || !st) return null;
        const sr = st.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        return {
          text: b.textContent ?? "",
          h: b.scrollHeight,
          tailGap: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
          rowVisible: rr.top >= sr.top - 1 && rr.bottom <= sr.bottom + 1,
          streamGap: Math.round(
            st.scrollHeight - st.scrollTop - st.clientHeight,
          ),
        };
      });
    await sleep(500);
    const s1 = await sample();
    await sleep(1500);
    const s2 = await sample();
    await shot("5-live-expanded");
    check(
      "流式中点开：框里是目前生成的全部内容（不只是最后一行）",
      !!s1 && s1.text.includes("行1 内容") && s1.text.split("\n").length > 2,
      JSON.stringify(s1?.text.slice(0, 40)),
    );
    check(
      "流式中点开：框里内容在变长，并始终跟到底",
      !!s1 && !!s2 && s2.h > s1.h && s1.tailGap <= 2 && s2.tailGap <= 2,
      `高 ${s1?.h} → ${s2?.h}，距底 ${s1?.tailGap} / ${s2?.tailGap}`,
    );
    check(
      "流式中点开：运行态那一行没被顶出视口，对话流仍贴底",
      !!s2 && s2.rowVisible && s2.streamGap <= 2,
      JSON.stringify({ rowVisible: s2?.rowVisible, streamGap: s2?.streamGap }),
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
  await fake.close();
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

const uniq = [...new Set(problems)];
check("全程没有控制台报错", uniq.length === 0, uniq.slice(0, 5).join(" | "));
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = results.filter((r) => !r).length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 项`
    : `\nPASS  对话流手感：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
