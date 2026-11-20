// 桌面「手机设备」页的真机检查：起真实 Server（临时数据目录，配了全局令牌）+ 无头 Chromium（桌面一个、手机一个），不需要模型。
//  1) 令牌门：桌面没有令牌时，令牌界面里有「手机版」入口，指向 /m/，点了真的进手机版
//  2) 设置页「手机设备」：还没有设备时有说明与「添加手机」
//  3) 添加手机弹窗：出二维码（220 见方、画在白底上）、倒计时、配对链接；地址默认是当前地址，是本机时提示手机打不开，
//     改成局域网地址提示消失、链接跟着变；改成空的提示地址不对、二维码收起；「重新生成」换一个新码
//  4) 手机按链接配对：另一个手机视口的浏览器打开 /m/?pair=码 → 设备出现；桌面弹窗自己关掉并弹「手机已添加」，列表里是新设备
//  5) 撤销：点两下才执行（第一下不动），之后设备没了、它的令牌 401
//  6) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-devices.mjs [--shots 目录]
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
const base = mkdtempSync(join(root, "tmp", "devices-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });

const TOKEN = "d".repeat(40);
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
  {
    stdio: "ignore",
    cwd: work,
    env: { ...process.env, YUANSHU_TOKEN: TOKEN, HOME: base },
  },
);

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

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const watch = (page) => {
      page.on("pageerror", (e) =>
        problems.push(`pageerror ${e.message.split("\n")[0]}`),
      );
      page.on("console", (m) => {
        if (m.type() === "error")
          problems.push(`console.error ${m.text().slice(0, 140)}`);
      });
      page.on("response", (r) => {
        // 令牌门里故意不带令牌的那次探测会 401，只收带令牌之后的
        if (r.url().includes("/api/v1/") && r.status() >= 400)
          problems.push(`${r.status()} ${r.url().split("/api/v1")[1]}`);
      });
    };

    // 1) 令牌门里的「手机版」入口（这一页故意没有令牌，401 不算问题）
    const bare = await (
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();
    await bare.goto(origin);
    const entry = bare.getByRole("link", { name: "手机版" });
    await entry.waitFor({ timeout: 8000 });
    const href = await entry.getAttribute("href");
    await bare.screenshot({
      path: SHOTS ? join(SHOTS, "0-gate.png") : undefined,
    });
    await entry.click();
    await bare.waitForURL("**/m/");
    check(
      "令牌门有「手机版」入口：指向 /m/，点了进手机版",
      href === "/m/" && new URL(bare.url()).pathname === "/m/",
      `${href} → ${bare.url()}`,
    );
    await bare.context().close();

    // 桌面：用全局令牌登录
    const desk = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await desk.addInitScript((token) => {
      sessionStorage.setItem("yuanshu.token", token);
    }, TOKEN);
    const page = await desk.newPage();
    watch(page);
    const shot = (n) =>
      SHOTS ? page.screenshot({ path: join(SHOTS, `${n}.png`) }) : null;
    const devices = async () =>
      (
        await (
          await fetch(`${origin}/api/v1/devices`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).json()
      ).devices;

    // 2) 设置页：空状态
    await page.goto(`${origin}/settings/devices`);
    await page.getByRole("heading", { name: "手机设备" }).first().waitFor();
    await page.getByText("还没有添加手机").waitFor();
    check(
      "设置页「手机设备」：没有设备时有说明与「添加手机」",
      (await page.getByRole("button", { name: "添加手机" }).count()) === 1,
    );
    await shot("1-empty");

    // 3) 添加手机弹窗
    await page.getByRole("button", { name: "添加手机" }).click();
    const qr = page.getByRole("img", { name: "配对二维码" });
    await qr.waitFor({ timeout: 10000 });
    await sleep(400);
    const box = await qr.boundingBox();
    const fill = await qr.evaluate((svg) => ({
      bg: getComputedStyle(svg.querySelector("rect")).fill,
      fg: getComputedStyle(svg.querySelector("path")).fill,
    }));
    const url1 = await page.locator(".st-dv-url").textContent();
    const code1 = new URL(url1).searchParams.get("pair");
    check(
      "弹窗：二维码 220 见方、深色画在浅底上；配对链接是「当前地址 + /m/?pair=码」",
      Math.abs(box.width - 220) < 1 &&
        Math.abs(box.height - 220) < 1 &&
        fill.bg !== fill.fg &&
        url1 === `${origin}/m/?pair=${code1}` &&
        /^[A-Z0-9]{8}$/.test(code1 ?? ""),
      JSON.stringify({ box: [box.width, box.height], fill, url1 }),
    );
    check(
      "弹窗：有倒计时；当前是本机地址，提示手机打不开",
      (await page.getByText(/分 \d\d 秒后失效/).count()) === 1 &&
        (await page.getByText(/本机地址，手机打不开/).count()) === 1,
    );
    await shot("2-dialog-local");

    const addr = page.getByLabel("手机访问的地址");
    await addr.fill("192.168.1.20:7431");
    const url2 = await page.locator(".st-dv-url").textContent();
    check(
      "改成局域网地址：提示消失，链接跟着变",
      (await page.getByText(/本机地址，手机打不开/).count()) === 0 &&
        url2 === `http://192.168.1.20:7431/m/?pair=${code1}`,
      url2,
    );
    await shot("3-dialog-lan");
    await addr.fill("");
    check(
      "地址清空：提示地址不对，二维码收起",
      (await page.getByText(/地址不对/).count()) === 1 &&
        (await qr.count()) === 0,
    );
    await addr.fill(origin);
    await qr.waitFor();

    await page.getByRole("button", { name: "重新生成" }).click();
    await page.waitForFunction(
      (old) =>
        !document.querySelector(".st-dv-url")?.textContent?.includes(old),
      code1,
    );
    const url3 = await page.locator(".st-dv-url").textContent();
    const code2 = new URL(url3).searchParams.get("pair");
    check(
      "重新生成：换一个新码",
      code2 !== code1 && /^[A-Z0-9]{8}$/.test(code2 ?? ""),
      `${code1} → ${code2}`,
    );
    // 留一张只含二维码的图，用来离线解码核对（见 docs 里的真机清单）
    if (SHOTS) await qr.screenshot({ path: join(SHOTS, "qr.png") });

    // 4) 手机按链接配对
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    });
    const mp = await phone.newPage();
    watch(mp);
    await mp.goto(url3);
    await mp.waitForSelector(".sh-gate input");
    await mp.locator(".sh-gate input").fill("扫码的手机");
    await mp.getByRole("button", { name: "添加" }).click();
    await mp.waitForSelector(".m-top");
    const phoneToken = await mp.evaluate(() =>
      localStorage.getItem("yuanshu.token"),
    );
    // 桌面弹窗自己关掉，并提示
    await page
      .getByRole("dialog")
      .waitFor({ state: "detached", timeout: 10000 });
    const toast = await page
      .locator(".u-toast", { hasText: "手机已添加" })
      .count();
    await page.getByText("扫码的手机").waitFor({ timeout: 5000 });
    const list = await devices();
    check(
      "手机配对后：桌面弹窗自己关掉并提示「手机已添加」，列表里出现这台设备",
      toast === 1 && list.length === 1 && list[0].name === "扫码的手机",
      JSON.stringify(list.map((d) => d.name)),
    );
    await shot("4-added");
    await mp.screenshot({
      path: SHOTS ? join(SHOTS, "5-phone.png") : undefined,
    });

    // 5) 撤销
    const revoke = page.getByRole("button", { name: "撤销 扫码的手机" });
    await revoke.click();
    const afterFirst = (await devices()).length;
    await shot("6-revoke-confirm");
    await page.getByRole("button", { name: "撤销 扫码的手机" }).click();
    await page.getByText("还没有添加手机").waitFor({ timeout: 8000 });
    const status = (
      await fetch(`${origin}/api/v1/sessions`, {
        headers: { authorization: `Bearer ${phoneToken}` },
      })
    ).status;
    check(
      "撤销：第一下不执行，第二下之后设备没了、它的令牌 401",
      afterFirst === 1 && (await devices()).length === 0 && status === 401,
      `after first ${afterFirst}, token ${status}`,
    );
    await phone.close();
    await desk.close();
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
  rmSync(base, { recursive: true, force: true });
}

// 令牌门那一页探测时没带令牌会有一次 401，已经单独排除（它没挂 watch）
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
    : `\nPASS  手机设备页：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
