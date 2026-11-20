// 工作区外层框架（平铺窗格 / 窗格头 / 窗口条 / 拖放落点 / 窄窗格堆叠）的真机检查：
// 起真实 Server（临时数据目录）+ 无头 Chromium，不需要真实模型。
//  1) 版式：窗格平铺（无外框、无圆角）、窗格头 36 高、标签字号 13、标题无类型前缀、窗口条平时没有提示
//  2) 主机标识：绑了主机的窗格头有底边色线，右端有色点与主机名
//  3) 拖标签到别的窗格：中部 / 标签条 / 右缘各亮且只亮一个落点，放下后标签移过去
//  4) 拖窗格头：窗口条出现提示；拖到另一个窗口标签上 = 移过去并切到该窗口；落下后提示消失
//  5) 窄容器（780px）：窗格上下堆叠、各自不低于 260，没有横向滚动
//  6) 文件管理器的预览：单击 = 临时预览（斜体、再单击别的文件就地替换），双击 / Enter / 双击标签 = 固定；刷新后临时标记还在
//  7) 文件管理器版式：工具条永远一行（36 高）、没有列头；ctrl 点击多选时同一行换成选择条；
//     仓库里有分支胶囊，点它进 / 出版本视图；刷新是图标
//  8) 文件管理器的新动作：刷新旁的眼睛切换隐藏文件（工具条仍一行）；右键「下载」文件原样、文件夹得到 zip；
//     多选后拖到目录行，整批一起移动
//  9) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-workspace.mjs [--shots 目录]
import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
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
const base = mkdtempSync(join(root, "tmp", "wsframe-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
const dir2 = `${work}/pv`;
mkdirSync(dir, { recursive: true });
mkdirSync(dir2, { recursive: true });
for (const f of ["a.txt", "b.txt", "c.txt", "d.txt"])
  writeFileSync(join(dir2, f), `${f}\n`);
// 「框架」工作区的目录是个 git 仓库：一个已提交的文件 + 一个未提交的改动，文件管理器才有分支胶囊
writeFileSync(join(dir, "tracked.txt"), "v1\n");
execSync(
  "git init -q && git add -A && git -c user.name=test -c user.email=t@t commit -qm init",
  { cwd: dir },
);
writeFileSync(join(dir, "tracked.txt"), "v2\n");
writeFileSync(join(dir, "new.txt"), "n\n");
writeFileSync(join(dir, ".hidden.txt"), "h\n");
mkdirSync(join(dir, "box"));
writeFileSync(join(dir, "box", "in.txt"), "in-box\n");
const port = 18100 + Math.floor(Math.random() * 90);
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
    name: "框架",
    directories: [{ path: dir }],
  });
  for (let i = 0; i < 2; i++)
    await api("POST", "/sessions", { workspaceId: ws.id });
  const ws2 = await api("POST", "/workspaces", {
    name: "预览",
    directories: [{ path: dir2 }],
  });
  await api("POST", "/sessions", { workspaceId: ws2.id });

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
        problems.push(
          `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
    });
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };
    const panes = () => page.locator(".ws-pane");
    const paneOf = (type) =>
      page.locator(".ws-pane", {
        has: page.locator(`.ws-pn-tab[data-type="${type}"]`),
      });
    const tabsOf = (pane) =>
      pane
        .locator(".ws-pn-tab")
        .evaluateAll((els) =>
          els.map((e) => `${e.dataset.type}${e.dataset.temp ? "*" : ""}`),
        );
    // 拖拽中移动：落到新元素上后再微动一下，Chromium 才会对新位置派发 dragover
    const moveTo = async (x, y) => {
      await page.mouse.move(x, y, { steps: 6 });
      await page.mouse.move(x + 2, y + 1);
      await sleep(250);
    };
    const dragTo = async (from, to, at, hold = 300) => {
      const f = await from.boundingBox();
      const t = await to.boundingBox();
      await page.mouse.move(f.x + 24, f.y + f.height / 2);
      await page.mouse.down();
      await page.mouse.move(f.x + 40, f.y + f.height / 2 + 6, { steps: 3 });
      await page.mouse.move(t.x + at.x, t.y + at.y, { steps: 10 });
      await sleep(hold);
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "框架" }).click();
    await page.waitForSelector(".ws-pane");
    await sleep(1200);

    // 1) 版式
    const frame = await page.evaluate(() => {
      const pane = document.querySelector(".ws-pane");
      const head = document.querySelector(".ws-pn-head");
      const name = document.querySelector(".ws-pn-tab-name");
      const body = document.querySelector(".ws-wnbody");
      const cs = (e) => getComputedStyle(e);
      return {
        paneBorder: cs(pane).borderTopWidth,
        paneRadius: cs(pane).borderTopLeftRadius,
        bodyBorder: cs(body).borderTopWidth,
        headH: Math.round(head.getBoundingClientRect().height),
        nameSize: cs(name).fontSize,
        titles: [...document.querySelectorAll(".ws-pn-tab-name")].map(
          (e) => e.textContent,
        ),
        hint: document.querySelectorAll(".u-wbar-hint").length,
      };
    });
    check(
      "窗格平铺：无外框、无圆角；窗口条下的区域也没有外框",
      frame.paneBorder === "0px" &&
        frame.paneRadius === "0px" &&
        frame.bodyBorder === "0px",
      JSON.stringify(frame),
    );
    check(
      "窗格头 36 高、标签标题 13px",
      frame.headH === 36 && frame.nameSize === "13px",
      JSON.stringify([frame.headH, frame.nameSize]),
    );
    check(
      "标签标题没有类型前缀（图标已表示类型）",
      frame.titles.every((t) => !/[·]/.test(t)) &&
        frame.titles.includes("proj"),
      frame.titles.join(" | "),
    );
    check("窗口条平时没有常驻提示", frame.hint === 0);
    await shot("1-frame");

    // 2) 主机标识
    const host = await page.evaluate(() => {
      const head = document.querySelector(
        '.ws-pane[data-host]:not([data-host=""]) .ws-pn-head',
      );
      const dot = head?.querySelector(".ws-hdot");
      return {
        line: head ? getComputedStyle(head).boxShadow : "",
        dot: dot ? getComputedStyle(dot).backgroundColor : "",
        name: head?.querySelector(".ws-hname")?.textContent ?? "",
      };
    });
    check(
      "绑了主机的窗格：头底边有主机色线，右端有色点与主机名",
      host.line.includes("inset") &&
        host.dot !== "" &&
        host.dot !== "rgba(0, 0, 0, 0)" &&
        host.name.length > 0,
      JSON.stringify(host),
    );

    // 3) 拖标签：中部 / 标签条 / 右缘
    const chatTab = paneOf("chat").locator(".ws-pn-tab").first();
    const filesPane = paneOf("files");
    const fb = await filesPane.boundingBox();
    const lit = () =>
      page.evaluate(() => {
        const p = document.querySelector(".ws-pane[data-dz]");
        const on = [...(p?.querySelectorAll(".u-dz") ?? [])].filter(
          (e) => getComputedStyle(e).opacity === "1",
        );
        return { dz: p?.dataset.dz ?? null, lit: on.map((e) => e.dataset.z) };
      });
    await dragTo(chatTab, filesPane, { x: fb.width / 2, y: fb.height / 2 });
    let z = await lit();
    check(
      "拖到窗格中部：只亮「并入」",
      z.dz === "center" && z.lit.length === 1 && z.lit[0] === "center",
      JSON.stringify(z),
    );
    await shot("2-drag-center");
    await moveTo(fb.x + 60, fb.y + 12);
    z = await lit();

    check(
      "拖到标签条：只亮「作为标签页」",
      z.dz === "strip" && z.lit.length === 1,
      JSON.stringify(z),
    );
    await moveTo(fb.x + fb.width - 24, fb.y + fb.height / 2);
    z = await lit();
    check(
      "拖到右缘：只亮「右侧拆分」",
      z.dz === "right" && z.lit.length === 1,
      JSON.stringify(z),
    );
    await moveTo(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.up();
    await sleep(500);
    check(
      "放下：对话标签并进了文件窗格",
      (await tabsOf(filesPane)).some((t) => t.startsWith("chat")),
      JSON.stringify(await tabsOf(filesPane)),
    );

    // 把对话标签拖到本窗格右缘拆出去：窗口里重新有两个窗格
    const chatIn = filesPane.locator('.ws-pn-tab[data-type="chat"]');
    const fb2 = await filesPane.boundingBox();
    await dragTo(chatIn, filesPane, { x: fb2.width - 24, y: fb2.height / 2 });
    await moveTo(fb2.x + fb2.width - 22, fb2.y + fb2.height / 2);
    await page.mouse.up();
    await sleep(500);
    check("同窗格内拖到右缘：拆出新窗格", (await panes().count()) === 2);

    // 4) 拖窗格头 → 窗口条提示 → 放到另一个窗口标签上
    await page.getByRole("button", { name: "新建窗口" }).click();
    await sleep(400);
    await page.getByRole("tab", { name: "窗口 1" }).click();
    await sleep(400);
    check(
      "新建窗口后窗口条有两个标签",
      (await page.locator(".u-wbar-tab").count()) === 2,
    );
    const head = filesPane.locator(".ws-pn-head");
    const hb = await head.boundingBox();
    await page.mouse.move(hb.x + hb.width - 160, hb.y + 18);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width - 140, hb.y + 40, { steps: 3 });
    await sleep(250);
    check(
      "拖窗格头时窗口条出现提示",
      (await page.locator(".u-wbar-hint").count()) === 1,
    );
    const chip2 = page.locator(".u-wbar-tab").nth(1);
    const cb = await chip2.boundingBox();
    await moveTo(cb.x + cb.width / 2, cb.y + cb.height / 2);
    check(
      "拖到窗口标签上：该标签亮起",
      (await chip2.getAttribute("data-drop")) !== null,
    );
    await shot("3-drag-to-window");
    await page.mouse.up();
    await sleep(600);
    await shot("3-after-drop");
    check(
      "放下：切到窗口 2（新窗口自带 2 个窗格 + 移来的 1 个），提示消失",
      (await page
        .getByRole("tab", { name: "窗口 2" })
        .getAttribute("aria-selected")) === "true" &&
        (await panes().count()) === 3 &&
        (await page.locator(".u-wbar-hint").count()) === 0,
      String(await panes().count()),
    );

    // 5) 窄容器：780px 视口下左轨横成顶部条，工作区宽 780 → 窗格上下堆叠
    await page.setViewportSize({ width: 780, height: 900 });
    await sleep(600);
    const stack = await page.evaluate(() => {
      const ps = [...document.querySelectorAll(".ws-pane")].map((p) => {
        const r = p.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          h: Math.round(r.height),
        };
      });
      return {
        n: ps.length,
        sameLeft: new Set(ps.map((p) => p.x)).size === 1,
        ascending: ps.every(
          (p, i) => i === 0 || p.y >= (ps[i - 1].y ?? 0) + 200,
        ),
        minH: Math.min(...ps.map((p) => p.h)),
        overflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      };
    });
    check(
      "780px：窗格上下堆叠、各自不低于 260、没有横向滚动",
      stack.n >= 2 &&
        stack.sameLeft &&
        stack.ascending &&
        stack.minH >= 260 &&
        !stack.overflow,
      JSON.stringify(stack),
    );
    await shot("4-narrow");

    // 6) 文件管理器的预览：临时 / 固定
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".rl-wh", { hasText: "预览" }).click();
    await page.waitForSelector(".ws-fm-row");
    await sleep(800);
    const row = (name) =>
      page.locator(`.ws-fm-row[data-name="${name}"] .u-lrow-main`);
    const pv = () =>
      page.locator(".ws-pn-tab[data-type='preview']").evaluateAll((els) =>
        els.map((e) => {
          const name = e.querySelector(".ws-pn-tab-name");
          return [
            name?.textContent,
            e.hasAttribute("data-temp"),
            getComputedStyle(name).fontStyle,
          ];
        }),
      );
    await row("a.txt").click();
    await sleep(500);
    let t = await pv();
    check(
      "单击文件：开一个临时预览，标题斜体",
      t.length === 1 && t[0][0] === "a.txt" && t[0][1] && t[0][2] === "italic",
      JSON.stringify(t),
    );
    await shot("5-temp-preview");
    await row("b.txt").click();
    await sleep(400);
    t = await pv();
    check(
      "再单击别的文件：就地替换，仍只有一个临时预览",
      t.length === 1 && t[0][0] === "b.txt" && t[0][1],
      JSON.stringify(t),
    );
    await row("b.txt").dblclick();
    await sleep(400);
    t = await pv();
    check(
      "双击：固定（不再斜体、没有临时标记），不新增标签",
      t.length === 1 && t[0][0] === "b.txt" && !t[0][1] && t[0][2] === "normal",
      JSON.stringify(t),
    );
    await row("c.txt").click();
    await sleep(400);
    t = await pv();
    check(
      "固定的留着，新单击的另开临时预览",
      t.length === 2 && !t[0][1] && t[1][0] === "c.txt" && t[1][1],
      JSON.stringify(t),
    );
    await row("a.txt").focus();
    await page.keyboard.press("Enter");
    await sleep(400);
    t = await pv();
    check(
      "Enter：直接固定；临时的 c.txt 不受影响",
      t.length === 3 &&
        t.find((x) => x[0] === "a.txt")?.[1] === false &&
        t.find((x) => x[0] === "c.txt")?.[1] === true,
      JSON.stringify(t),
    );
    await page
      .locator(".ws-pn-tab[data-temp] .ws-pn-tab-btn", { hasText: "c.txt" })
      .dblclick();
    await sleep(400);
    t = await pv();
    check(
      "双击临时标签：固定",
      t.length === 3 && t.every((x) => !x[1]),
      JSON.stringify(t),
    );
    await row("d.txt").click();
    await sleep(1500);
    await page.reload();
    await page.waitForSelector(".ws-pn-tab[data-type='preview']");
    await sleep(800);
    t = await pv();
    check(
      "刷新后：临时标记还在，固定的也还在",
      t.length === 4 &&
        t.find((x) => x[0] === "d.txt")?.[1] === true &&
        t.filter((x) => !x[1]).length === 3,
      JSON.stringify(t),
    );

    // 7) 文件管理器版式（进「框架」工作区：目录是个 git 仓库，带两处未提交改动）
    await page.locator(".rl-wh", { hasText: "框架" }).click();
    await page.waitForSelector(".ws-fm-bar");
    await sleep(1200);
    const fm = page.locator(".ws-fm").first();
    const bar = await page.evaluate(() => {
      const f = document.querySelector(".ws-fm");
      const bars = f.querySelectorAll(".ws-fm-bar");
      return {
        bars: bars.length,
        h: Math.round(bars[0].getBoundingClientRect().height),
        cols: f.querySelectorAll(".ws-fm-cols").length,
        refresh: !!f.querySelector('.u-icon-btn[aria-label="刷新"]'),
      };
    });
    check(
      "文件工具条：一行 36 高，没有列头，刷新是图标",
      bar.bars === 1 && bar.h === 36 && bar.cols === 0 && bar.refresh,
      JSON.stringify(bar),
    );
    await shot("6-files-bar");
    const chip = fm.locator(".ws-fm-branch");
    check(
      "仓库里有分支胶囊，带未提交条数",
      (await chip.count()) === 1 && /\d/.test(await chip.innerText()),
      await chip.innerText().catch(() => ""),
    );
    await chip.click();
    await page.waitForSelector(".ws-fm-gitview");
    await sleep(300);
    check(
      "点分支胶囊：进版本视图，胶囊按下；再点回到文件列表",
      (await chip.getAttribute("aria-pressed")) === "true" &&
        (await fm.locator(".ws-fm-grow").count()) >= 1,
    );
    await shot("7-files-git");
    await chip.click();
    await page.waitForSelector(".ws-fm-list");
    const names = await fm.locator(".ws-fm-row").count();
    await fm
      .locator(".ws-fm-row .u-lrow-main")
      .nth(0)
      .click({ modifiers: ["Control"] });
    await fm
      .locator(".ws-fm-row .u-lrow-main")
      .nth(1)
      .click({ modifiers: ["Control"] });
    await sleep(300);
    const sel = await page.evaluate(() => {
      const f = document.querySelector(".ws-fm");
      return {
        bars: f.querySelectorAll(".ws-fm-bar").length,
        sel: f.querySelectorAll(".ws-fm-selbar").length,
        text: f.querySelector(".ws-fm-selbar")?.textContent ?? "",
        rows: f.querySelectorAll(".ws-fm-row").length,
        top: Math.round(
          f.querySelector(".ws-fm-row").getBoundingClientRect().top,
        ),
      };
    });
    check(
      "ctrl 多选：同一行换成选择条，列表不跳",
      sel.bars === 1 &&
        sel.sel === 1 &&
        /已选 2 项/.test(sel.text) &&
        sel.rows === names,
      JSON.stringify(sel),
    );
    await shot("8-files-selected");
    await fm
      .locator(".ws-fm-selbar")
      .getByRole("button", { name: "取消选择" })
      .click();
    await sleep(200);
    check(
      "取消选择：回到工具条",
      (await fm.locator(".ws-fm-selbar").count()) === 0 &&
        (await fm.locator(".ws-fm-crumb").count()) === 1,
    );

    // 8) 隐藏文件开关、右键下载、批量拖拽
    const eye = fm.getByRole("button", { name: "显示隐藏文件" });
    const rowOf = (name) => fm.locator(`.ws-fm-row[data-name="${name}"]`);
    const hiddenBefore = await rowOf(".hidden.txt").count();
    await eye.click();
    await rowOf(".hidden.txt").waitFor({ timeout: 5000 });
    const barH = await fm
      .locator(".ws-fm-bar")
      .evaluateAll((els) => [
        els.length,
        Math.round(els[0].getBoundingClientRect().height),
      ]);
    check(
      "眼睛按钮：点一下列出隐藏文件、按下态；工具条仍是一行 36 高；再点收回",
      hiddenBefore === 0 &&
        (await eye.getAttribute("aria-pressed")) === "true" &&
        barH[0] === 1 &&
        barH[1] === 36,
      JSON.stringify({ hiddenBefore, barH }),
    );
    await shot("9-files-hidden");
    await eye.click();
    await sleep(500);
    check("再点眼睛：隐藏文件收回", (await rowOf(".hidden.txt").count()) === 0);

    const downloadVia = async (name) => {
      const wait = page.waitForEvent("download", { timeout: 15000 });
      await rowOf(name).click({ button: "right" });
      await page.getByRole("menuitem", { name: "下载" }).click();
      const dl = await wait;
      const path = await dl.path();
      return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
    };
    const file = await downloadVia("new.txt");
    check(
      "右键下载文件：文件名与内容原样",
      file.name === "new.txt" && file.bytes.toString() === "n\n",
      `${file.name} ${file.bytes.length}B`,
    );
    const zip = await downloadVia("box");
    check(
      "右键下载文件夹：服务端打成 box.zip（zip 魔数，目录名在包内）",
      zip.name === "box.zip" &&
        zip.bytes.subarray(0, 2).toString() === "PK" &&
        zip.bytes.includes(Buffer.from("box/in.txt")),
      `${zip.name} ${zip.bytes.length}B`,
    );
    await shot("10-files-download");

    await rowOf("new.txt")
      .locator(".u-lrow-main")
      .click({ modifiers: ["Control"] });
    await rowOf("tracked.txt")
      .locator(".u-lrow-main")
      .click({ modifiers: ["Control"] });
    await rowOf("new.txt").dragTo(rowOf("box"));
    await sleep(1200);
    check(
      "多选两个文件拖到目录行：整批移进去（磁盘上两个都在 box 里、原处没有了）",
      existsSync(join(dir, "box", "new.txt")) &&
        existsSync(join(dir, "box", "tracked.txt")) &&
        !existsSync(join(dir, "new.txt")) &&
        !existsSync(join(dir, "tracked.txt")),
    );
    await shot("11-files-batch-moved");
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
    : `\nPASS  工作区框架：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
