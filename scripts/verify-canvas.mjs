// 灵感画布的真机检查：起真实 Server（临时数据目录与临时 HOME）+ 无头 Chromium，不需要真实模型。
//  1) 「+」里选画布：直接用工作区主目录，不问主机；空目录是空态，新建画布后建出 .canvas/、画布自己的 git 仓库，
//     并把 .canvas/ 写进项目仓库的 info/exclude
//  2) 新卡片不用写字也算卡片，可以同时有很多张：只在界面里（不请求服务端、不留文件），都标「未保存」；刷新页面后
//     从浏览器本地存储恢复；点「保存」只发一个请求，全部建出文件（空的也建）；双击空白新建的卡片中心在鼠标位置
//  3) 卡片在画布里原地编辑（不弹窗口）：编辑器在卡片里，Esc 收起；收起后渲染 markdown，没保存的卡片上标「未保存」
//  4) 卡片标题：随手记的时间名不显示，改过名才显示；引用卡上方标 主机:路径
//  5) 保存是画布级的：拖动 / 缩放 / 连线 / 卡片正文都先攒着（文件不动），切标签再回来还在，工具条「保存」一次写出去
//  6) 连接点盖在卡片之上、感应圈 32px 与实际一致；连线两端紧贴卡片的边；线可以拖到卡片中间松手
//  7) 刷新页面后一切还在；agent 一侧（接口）加了卡片，界面自己刷新出来
//  8) 删除灵感卡：先确认，节点与文件一起没有
//  9) 从文件管理器拖文件进画布成引用节点（markdown 渲染预览）；图片显示成图片，大图是缩略图；双击引用在预览里打开
//  9d) 粘贴 / 从系统拖入文件 → 画布自己的资源文件夹（带时间的名字、节点自动放上、超过设置上限的不进 git 或被拒绝）；删资源先确认
//  9c) GIF 原样会动（超过设置里的上限只给第一帧）；视频平时只有播放按钮、点了才请求（带 Range）；音频不预读
//  9b) 图片只能等比例缩放（以前被拉伸过的载入时校正回图片的比例）；普通卡片仍可任意比例；缩放感应区 32px
// 10) 保存的改动合成提交，来源是「用户」
// 11) 手势与菜单：连线松在卡片内任何位置都连上、左键框选（含只框住连线）、空格 / 中键 / 触控板平移、右键菜单、
//     复制粘贴（落在鼠标处）、粘贴网页链接（链接卡片）、播放中的视频能拖动、最大 500%、改图片设置后图片地址的版本变化
//     跨主机 / 目录之外的引用：从文件管理器拖进来的节点带 host，读取、渲染、双击打开预览、未连接态、索引都走同一套
// 23) 内容显示不下的卡片直接显示滚动条，按在滚动条上是拖滚动条
// 24) 树栏：全部展开 / 折叠一个按钮切换；展开状态在树栏收起再展开、刷新页面之后还在
// 27) 笔记里粘贴图片：存进 <笔记名>.assets/、插入相对笔记的链接；笔记改名 / 删除时资源夹跟着走
// 26) 笔记里的图片：相对笔记所在文件夹、走画布接口；读不到的是占位，外链不加载
// 25) 同窗格的两个画布标签各看各的，切走再切回、刷新页面之后还在原来的页面
// 22) 缩放时吸附对齐（边贴别的卡片的线、Alt 不吸）；编辑状态下也能缩放
// 21) Markdown 渲染：笔记预览里列表标记、标题层级、正文颜色、单个换行；对话、预览、卡片共用 md-prose + t-doc
// 20) 窄栏与快捷新建：左边永久驻留 40px 窄栏（白底），树栏悬浮时一移上去就展开悬浮树栏；窄栏上的新建笔记 / 画布按树选中 > 打开的东西 > 根定位置
// 19) 远端同步提示：服务端回报离线 / 没推完 / 有另存时工具条露出来，平时没有
// 18) 乐观更新：服务端慢（远程主机）时，改名 / 删除 / 挪动在树上立刻生效、不等服务端；服务端出错时回滚并提示
// 17) 拖拽自动生成引用：树里的笔记 / 画布拖进笔记编辑区 → [[路径]]；文件管理器里的项目文件拖进来 → 相对当前笔记的标准链接（图片带 !）
// 16) 吸附对齐：拖到别的卡片的边附近（6 屏幕像素内）出参考线、松手后对得严丝合缝；按住 Alt 不吸；没贴上卡片时落在 8 单位网格上
// 15) 缩放无关：缩放时卡片名、连线箭头、连接点的感应圈在屏幕上大小不变；连线看得见的那层在所有卡片之上（含选中的）
// 14) 树栏：固定（可拖宽、记在浏览器里）/ 悬浮（鼠标一移到窄栏上就展开、移开收回、忙着不收、手动点开的不因鼠标离开而收）；
//     窄到放不下就强制悬浮，工具条只留琥珀点；新建对话框是「位置 + 名字」，位置默认当前所在的文件夹
// 13) 笔记与树：左侧树里画布、笔记、文件夹混排；「新建」菜单建笔记（在本标签的主区里打开，不借预览标签）、写 [[链接]] 存盘；
//     把树里的笔记拖到画布上放置、节点标「笔记 · 路径」；index.md 里有 appears-in 与 [[链接]]；预览态里 [[画布]] 点了切到那块画布，
//     后退回到笔记；F2 改名与拖进文件夹都连带改写别的笔记里的 [[链接]] 与画布节点；删除先确认（写明被谁引用）；删节点只是从画布拿掉
// 28) 笔记「添加到对话」：预览里选中一段，按钮把它连同来源加进借用会话的输入草稿
// 12) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-canvas.mjs [--shots 目录]
import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
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

// 纯色 PNG，现造：不依赖仓库外的文件
function png(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x66)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 2 帧 2×1 的动图，再用注释块撑大（GIF 允许注释扩展，不影响显示）：用来测「超过 GIF 原样上限就只给第一帧」
function animatedGif(padBytes) {
  const frame = (delay) =>
    Buffer.concat([
      Buffer.from([0x21, 0xf9, 4, 0, delay, 0, 0, 0]),
      Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0]),
      Buffer.from([2, 2, 0x44, 0x0a, 0]),
    ]);
  const pad = Buffer.concat(
    Array.from({ length: Math.ceil(padBytes / 256) }, () =>
      Buffer.concat([Buffer.from([255]), Buffer.alloc(255, 0x20)]),
    ),
  );
  return Buffer.concat([
    Buffer.from("GIF89a"),
    Buffer.from([2, 0, 1, 0, 0x80, 0, 0, 255, 0, 0, 0, 0, 255]),
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from("NETSCAPE2.0"),
    Buffer.from([3, 1, 0, 0, 0]),
    Buffer.from([0x21, 0xfe]),
    pad,
    Buffer.from([0]),
    frame(20),
    frame(20),
    Buffer.from([0x3b]),
  ]);
}

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "canvas-"));
const work = `${realpathSync(base)}/work`;
const dir = join(work, "proj");
mkdirSync(join(dir, "docs"), { recursive: true });
writeFileSync(
  join(dir, "docs", "a.md"),
  `# 方案\n\n项目里的一份文档\n\n${Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段：这一段很长，很长，很长，用来把卡片撑得放不下，需要滚动条才能看全。`).join("\n\n")}\n`,
);
writeFileSync(join(dir, "docs", "small.png"), png(320, 200));
writeFileSync(join(dir, "docs", "big.png"), png(2400, 1600));
writeFileSync(join(dir, "docs", "loop.gif"), animatedGif(3 * 1024 * 1024));
// 视频 / 音频：内容不是真的媒体（这里不测解码，只测「点了才请求、带 Range」）
writeFileSync(join(dir, "docs", "clip.mp4"), Buffer.alloc(256 * 1024, 7));
writeFileSync(join(dir, "docs", "tone.mp3"), Buffer.alloc(64 * 1024, 9));
// 项目是个 git 仓库：创建画布时要把 .canvas/ 写进它的 info/exclude
execSync(
  "git init -q && git add -A && git -c user.name=tester -c user.email=t@t.t commit -qm init",
  { cwd: dir },
);
// 临时 HOME：Server 读 <HOME>/.pi/agent，不碰真实的 ~/.pi
const home = join(base, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

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
  { stdio: "ignore", cwd: work, env: { ...process.env, HOME: home } },
);
const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    // 没有请求体就不声明 JSON：Fastify 对「声明了 JSON 却是空体」直接回 400（DELETE 以前因此悄悄失败）
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
const q = (extra = {}) => new URLSearchParams({ dir, ...extra }).toString();
const board = async (name) =>
  (await api("GET", `/canvas/local/board?${q({ name })}`)).body;
const git = (args) =>
  execSync(`git -C ${join(dir, ".canvas")} ${args}`)
    .toString()
    .trim();
const cardsOf = (name) => {
  const d = join(dir, ".canvas", `${name}.cards`);
  return existsSync(d) ? readdirSync(d) : [];
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
    name: "画布验",
    directories: [{ path: dir }],
  });
  // 文件监听借工作区里的会话流：要有一个会话
  await api("POST", "/sessions", { workspaceId: ws.body.id });

  const browser = await chromium.launch({
    channel: "chromium",
    // 无头模式默认藏滚动条；画布卡片的滚动条要真画出来才能量
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1860, height: 1000 } })
    ).newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      // 浏览器会为故意触发的 413 在控制台记一条
      if (m.type() === "error" && !m.text().includes("status of 413"))
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      // 例外：故意传一个超过上限的文件，要的就是 413
      if (r.status() === 413 && r.url().includes("/canvas/local/asset?"))
        return;
      if (r.url().includes("/api/v1/") && r.status() >= 400)
        problems.push(
          `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
    });
    // 记下画布的写请求：没保存之前不该有任何一条
    const writes = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.includes("/canvas/") && r.method() !== "GET")
        writes.push(`${r.method()} ${u.pathname.split("/canvas/local")[1]}`);
    });
    const switchBoard = async (label) => {
      await page
        .locator(`.cv-tree [data-tree-id="${label}.canvas"] .u-lrow-main`)
        .click();
      await sleep(900);
    };
    // 树头部的「新建」菜单
    const newFromTree = async (item) => {
      await page
        .locator(".cv-tree-head")
        .getByRole("button", { name: "新建" })
        .click();
      await page.getByRole("menuitem", { name: item }).click();
    };
    // 记下音视频流的请求（带不带 Range）：没点播放之前不该有
    const mediaReqs = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/v1/canvas/") && r.url().includes("/media?"))
        mediaReqs.push(r.headers().range ?? "");
    });
    const shot = async (n, clip) => {
      if (SHOTS)
        await page.screenshot({
          path: join(SHOTS, `${n}.png`),
          ...(clip ? { clip } : {}),
        });
    };
    const nodes = () => page.locator(".cv .react-flow__node");
    const nodeWith = (text) => nodes().filter({ hasText: text });
    const editorIn = ".cv-node[data-editing] .cm-content";
    const paneOf = (type) =>
      page.locator(".ws-pane", {
        has: page.locator(`.ws-pn-tab[data-type="${type}"]`),
      });
    const dragTo = async (from, to, at, hold = 300) => {
      const f = await from.boundingBox();
      const t = await to.boundingBox();
      await page.mouse.move(f.x + 24, f.y + f.height / 2);
      await page.mouse.down();
      await page.mouse.move(f.x + 40, f.y + f.height / 2 + 6, { steps: 3 });
      await page.mouse.move(t.x + at.x, t.y + at.y, { steps: 10 });
      await sleep(hold);
    };
    const waitEditor = async () => {
      await page.waitForSelector(editorIn, { timeout: 15000 });
      await sleep(300);
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "画布验" }).click();
    await page.waitForSelector(".ws-pane");
    await sleep(1000);

    // 1) 「+」里选画布：直接开，不问主机
    const host = paneOf("files");
    await host.getByRole("button", { name: "新建标签页" }).click();
    await page.getByRole("menuitem", { name: "画布" }).click();
    await page.waitForSelector(".cv");
    await sleep(500);
    check(
      "「+」里选画布：直接开出画布标签（不问主机），目录里还没有画布时是空态",
      (await page.locator(".ws-pn-tab[data-type='canvas']").count()) === 1 &&
        (await page.getByText("这个目录还没有画布").count()) === 1,
    );
    await shot("1-empty");
    await page.getByRole("button", { name: "新建画布" }).last().click();
    await page.getByLabel("名字", { exact: true }).fill("想法");
    await page.locator('button[type="submit"]', { hasText: "新建" }).click();
    await page.waitForSelector(".cv .react-flow");
    await sleep(500);
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    check(
      "新建画布：建出 .canvas/ 与画布文件、画布自己的 git 仓库，项目的 info/exclude 里有 .canvas/",
      existsSync(join(dir, ".canvas", "想法.canvas")) &&
        existsSync(join(dir, ".canvas", ".git")) &&
        /^\.canvas\/?$/m.test(exclude),
    );
    check(
      "工具条一行：画布名在最左；空画布里有新建卡片的提示",
      (await page.locator(".cv-bar").count()) === 1 &&
        (await page.locator(".cv-viewname").textContent()) === "想法" &&
        (await page.locator(".cv-hint").count()) === 1,
    );

    // 2) 新卡片：在另一块画布「批量」上做，免得影响后面的流程
    await newFromTree("新建画布");
    await page.getByLabel("名字", { exact: true }).fill("批量");
    await page.locator('button[type="submit"]', { hasText: "新建" }).click();
    await page.waitForSelector(".cv-hint");
    await sleep(600);
    const w0 = writes.length;
    await page.getByRole("button", { name: "新建卡片" }).click();
    await waitEditor();
    check(
      "「新建卡片」：画布里出现新卡片，卡片里直接是编辑器，没有弹出专门的编辑窗口",
      (await nodes().count()) === 1 &&
        (await page.locator(editorIn).count()) === 1 &&
        (await page.locator(".cv-editor").count()) === 0,
    );
    await page.keyboard.press("Escape");
    await sleep(500);
    check(
      "没写字就 Esc：空卡片还在，标「未保存」，没有请求服务端、没有留下文件",
      (await nodes().count()) === 1 &&
        (await page.getByText("空卡片，双击编辑").count()) === 1 &&
        (await page.locator(".cv-labtail").textContent())?.includes(
          "未保存",
        ) === true &&
        writes.length === w0 &&
        cardsOf("批量").length === 0,
      JSON.stringify([writes.slice(w0), cardsOf("批量")]),
    );

    // 再加两张并写字（第一张一直是空的）：同时有三张没保存的卡片，彼此不重叠
    await page.getByRole("button", { name: "新建卡片" }).click();
    await waitEditor();
    await page.keyboard.type("# 批量的第二张\n\n正文二");
    await page.getByRole("button", { name: "新建卡片" }).click();
    await waitEditor();
    await page.keyboard.type("批量的第三张");
    const flow = await page.locator(".cv-flow").boundingBox();
    // 最新这张（正在编辑的）排到了视野外时，视野会平移过去，卡片整个看得见
    const latest = await page
      .locator(".react-flow__node:has(.cv-node[data-editing])")
      .boundingBox();
    const inView =
      latest.x >= flow.x - 1 &&
      latest.y >= flow.y - 1 &&
      latest.x + latest.width <= flow.x + flow.width + 1 &&
      latest.y + latest.height <= flow.y + flow.height + 1;
    await page.mouse.click(flow.x + 40, flow.y + flow.height - 40);
    await sleep(600);
    const boxes = await nodes().evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect().toJSON()),
    );
    const overlap = boxes.some((a, i) =>
      boxes.some(
        (b, j) =>
          j > i &&
          a.left < b.right - 8 &&
          b.left < a.right - 8 &&
          a.top < b.bottom - 8 &&
          b.top < a.bottom - 8,
      ),
    );
    const mirrors = () =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((k) =>
            k.startsWith("ys.canvas.unsaved:"),
          ).length,
      );
    check(
      "同时有三张没保存的卡片：新建的卡片都在视野里，点空白处不弹窗，三张都标「未保存」且互不重叠，工具条亮起，仍没有请求服务端，改动镜像进了本地存储",
      inView &&
        (await page.getByRole("dialog").count()) === 0 &&
        (await nodes().count()) === 3 &&
        (await page.locator(".cv-labtail").count()) === 3 &&
        !overlap &&
        (await page.locator(".cv-bar .cv-save").textContent())?.includes(
          "未保存",
        ) === true &&
        writes.length === w0 &&
        (await mirrors()) === 1,
      JSON.stringify({
        inView,
        overlap,
        writes: writes.slice(w0),
        m: await mirrors(),
      }),
    );
    await shot("2-drafts");

    // 刷新页面：没保存的卡片从本地存储恢复
    await page.reload();
    await page.waitForSelector(".cv .react-flow__node");
    await sleep(900);
    check(
      "刷新页面：三张没保存的卡片（含正文与空卡片）恢复，提示已恢复，仍标「未保存」，仍没有请求服务端",
      (await nodes().count()) === 3 &&
        (await nodeWith("正文二").count()) === 1 &&
        (await page.getByText("批量的第三张").count()) >= 1 &&
        (await page.getByText("已恢复上次没保存的改动").count()) >= 1 &&
        (await page.locator(".cv-labtail").count()) === 3 &&
        writes.length === w0,
      JSON.stringify(writes.slice(w0)),
    );

    // 点保存：一个请求把三张卡片全部建出来，空的也建
    await page
      .locator(".cv-bar")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await sleep(1800);
    const batch = await board("批量");
    const contents = cardsOf("批量").map((f) =>
      readFileSync(join(dir, ".canvas", "批量.cards", f), "utf8"),
    );
    check(
      "点「保存」：只发一个请求（POST /save），三张卡片全建出文件（其中一张是空的），标记与本地镜像都没了",
      JSON.stringify(writes.slice(w0)) === JSON.stringify(["POST /save"]) &&
        batch.canvas.nodes.length === 3 &&
        contents.length === 3 &&
        contents.filter((t) => t === "").length === 1 &&
        contents.some((t) => t.includes("正文二")) &&
        (await page.locator(".cv-labtail").count()) === 0 &&
        (await page.locator(".cv-bar .cv-save").count()) === 0 &&
        (await mirrors()) === 0,
      JSON.stringify([writes.slice(w0), contents]),
    );

    // 粘贴 / 从系统拖入文件：传到这块画布的资源文件夹（.canvas/批量.assets/），节点自动放上画布
    const assetsDir = join(dir, ".canvas", "批量.assets");
    // 只数文件（_large 是子文件夹）
    const filesIn = (d) =>
      existsSync(d)
        ? readdirSync(d, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => e.name)
        : [];
    const mediaSettings = (over) =>
      api("PUT", "/defaults", {
        canvasMedia: {
          thumbMaxSide: 2000,
          thumbQuality: 85,
          gifMaxMB: 8,
          sourceMaxMB: 20,
          assetGitMaxMB: 5,
          uploadMaxMB: 500,
          ...over,
        },
      });
    const paste = (specs) =>
      page.evaluate((specs) => {
        const dt = new DataTransfer();
        for (const f of specs)
          dt.items.add(
            new File(
              [Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))],
              f.name,
              {
                type: f.type,
              },
            ),
          );
        document.querySelector(".cv").dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, specs);
    const pngB64 = png(320, 200).toString("base64");
    await page
      .locator(".cv-flow .react-flow__pane")
      .click({ position: { x: 20, y: 20 } });
    // 鼠标不在画布里（在工具条上）：粘贴的东西放到视野里的空位；鼠标在画布里的情形在第 11 段测
    await page.locator(".cv-bar").hover();
    await paste([{ name: "image.png", type: "image/png", b64: pngB64 }]);
    await page.getByText("已放入 1 个文件").first().waitFor({ timeout: 15000 });
    await sleep(800);
    const pasted = filesIn(assetsDir);
    const pastedBoard = await board("批量");
    check(
      "粘贴剪贴板里的图片：存成资源文件夹里带时间的名字（不是 image.png），节点自动放上画布并显示成图片",
      pasted.length === 1 &&
        /^粘贴-\d{8}-\d{6}\.png$/.test(pasted[0] ?? "") &&
        pastedBoard.canvas.nodes.some(
          (n) => n.file === `批量.assets/${pasted[0]}`,
        ) &&
        (await page.locator(`img.cv-img[alt^='粘贴-']`).count()) === 1,
      JSON.stringify([pasted, writes.slice(-2)]),
    );

    // 设置里把「进历史的资源上限」调到 1MB：1.5MB 的视频放进 _large/，不进画布的 git；调回去、同样大小的进历史
    await mediaSettings({ assetGitMaxMB: 1 });
    const bigB64 = Buffer.alloc(1536 * 1024, 5).toString("base64");
    await paste([{ name: "demo.mp4", type: "video/mp4", b64: bigB64 }]);
    await sleep(2500);
    await mediaSettings({ assetGitMaxMB: 5 });
    await paste([{ name: "mid.mp3", type: "audio/mpeg", b64: bigB64 }]);
    await sleep(2500);
    await api("GET", `/canvas/local/history?${q()}`);
    const tracked = execSync(
      `git -c core.quotepath=off -C ${join(dir, ".canvas")} ls-files`,
    ).toString();
    check(
      "大文件（超过设置里的上限）放进 _large/ 不进画布的 git 历史，上限以内的进历史",
      existsSync(join(assetsDir, "_large", "demo.mp4")) &&
        !tracked.includes("demo.mp4") &&
        tracked.includes("批量.assets/mid.mp3") &&
        tracked.includes("批量.assets/粘贴-"),
      JSON.stringify(tracked.split("\n").filter((l) => l.includes("assets"))),
    );

    // 连着粘贴几次（鼠标不在画布里）：新节点排开，不压在已有的节点（包括彼此）上
    const nodeBoxes = await page
      .locator(".react-flow__node")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    const stacked = nodeBoxes.some((a, i) =>
      nodeBoxes.some(
        (b, j) =>
          j > i &&
          a.left < b.right - 8 &&
          b.left < a.right - 8 &&
          a.top < b.bottom - 8 &&
          b.top < a.bottom - 8,
      ),
    );
    check(
      "连着粘贴几次：新放进来的节点不叠在已有节点上",
      !stacked && nodeBoxes.length === 6,
      JSON.stringify({ stacked, n: nodeBoxes.length }),
    );

    // 超过单个文件上限：拒绝并说清上限（设置里可调），不留文件
    await mediaSettings({ uploadMaxMB: 1 });
    const before413 = filesIn(assetsDir).length;
    await paste([{ name: "huge.bin", type: "", b64: bigB64 }]);
    await page
      .getByText(/超过 1 MB 的上限/)
      .first()
      .waitFor({ timeout: 15000 });
    await mediaSettings({});
    check(
      "粘贴的文件超过设置里的单个文件上限：提示上限，没有留下文件，也没有多出节点",
      filesIn(assetsDir).length === before413 &&
        !filesIn(join(assetsDir, "_large")).includes("huge.bin") &&
        !(await board("批量")).canvas.nodes.some((n) =>
          String(n.file).includes("huge"),
        ),
    );

    // 从系统拖进来的文件：落点就是放下的位置
    const dropBox = await page.locator(".cv-flow").boundingBox();
    await page.evaluate(
      ({ b64, x, y }) => {
        const dt = new DataTransfer();
        dt.items.add(
          new File(
            [Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))],
            "拖入.png",
            {
              type: "image/png",
            },
          ),
        );
        const target = document.querySelector(".cv-flow");
        for (const type of ["dragenter", "dragover", "drop"])
          target.dispatchEvent(
            new DragEvent(type, {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
            }),
          );
      },
      { b64: pngB64, x: dropBox.x + 300, y: dropBox.y + 200 },
    );
    await page.getByText("已放入 1 个文件").first().waitFor({ timeout: 15000 });
    await sleep(800);
    check(
      "从系统拖进来的文件：传进资源文件夹并放上画布",
      filesIn(assetsDir).includes("拖入.png") &&
        (await page.locator("img.cv-img[alt='拖入.png']").count()) === 1,
    );
    await shot("7a-assets");

    // 删资源：先确认，说明文件会被删除（_large 里的特别说明找不回），确认后文件与节点都没有
    await page
      .locator(".react-flow__node", {
        has: page.locator("img.cv-img[alt='拖入.png']"),
      })
      .locator(".cv-box")
      .click();
    await page.keyboard.press("Backspace");
    await page.getByRole("dialog").waitFor({ timeout: 5000 });
    const delText = (await page.getByRole("dialog").textContent()) ?? "";
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await sleep(1500);
    check(
      "选中资源按 Backspace：先问「删除 1 个文件」，确认后文件和节点一起没有",
      delText.includes("删除 1 个文件") &&
        delText.includes("拖入.png") &&
        !filesIn(assetsDir).includes("拖入.png") &&
        (await page.locator("img.cv-img[alt='拖入.png']").count()) === 0,
      delText.slice(0, 80),
    );
    await switchBoard("想法");

    // 3) 新卡片写完 Ctrl+S：一个请求建出文件；之后原地接着编辑
    const w1 = writes.length;
    await page.getByRole("button", { name: "新建卡片" }).click();
    await waitEditor();
    await page.keyboard.type("# 第一张灵感\n\n把想法随手记下来");
    await shot("2-draft");
    await page.keyboard.press("Control+s");
    await sleep(1800);
    const b1 = await board("想法");
    const cardPath = b1.canvas.nodes[0]?.file;
    const onDisk = cardPath
      ? readFileSync(join(dir, ".canvas", cardPath), "utf8")
      : "";
    check(
      "Ctrl+S：一个请求（POST /save）把卡片文件连正文建出来，节点指向真文件，仍在编辑同一张卡片",
      JSON.stringify(writes.slice(w1)) === JSON.stringify(["POST /save"]) &&
        onDisk.includes("第一张灵感") &&
        !String(cardPath).startsWith("::new:") &&
        (await nodes().count()) === 1 &&
        (await page.locator(editorIn).count()) === 1,
      JSON.stringify([writes.slice(w1), cardPath]),
    );
    await page.keyboard.press("Escape");
    await sleep(600);
    check(
      "Esc 收起编辑：卡片显示渲染好的 markdown（标题是标题），随手记的时间名不显示在卡片上方",
      (await page.locator(".cv-md h1").count()) === 1 &&
        (await page.locator(".cv-node[data-editing]").count()) === 0 &&
        (await page.locator(".cv-card .cv-label").count()) === 0,
    );
    await shot("3-rendered");

    // 4) 右键重命名后标题才显示
    await nodes()
      .first()
      .click({ button: "right", position: { x: 120, y: 60 } });
    await page.getByRole("menuitem", { name: "重命名" }).click();
    await page.getByLabel("卡片名").fill("风险");
    await page.getByRole("button", { name: "改名" }).click();
    await sleep(1200);
    check(
      "右键菜单可以重命名；改过名之后卡片上方才显示标题，文件也跟着改名",
      (await page.locator(".cv-card .cv-labtext").textContent()) === "风险" &&
        cardsOf("想法").includes("风险.md"),
      JSON.stringify(cardsOf("想法")),
    );

    // 双击已有卡片原地编辑，改了再 Ctrl+S
    await nodes().first().dblclick();
    await waitEditor();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("，补一句");
    await page.keyboard.press("Control+s");
    await sleep(1200);
    check(
      "双击卡片：原地编辑；改后 Ctrl+S 才写回文件",
      readFileSync(
        join(dir, ".canvas", "想法.cards", "风险.md"),
        "utf8",
      ).includes("补一句"),
    );
    await page.keyboard.press("Escape");
    await sleep(500);

    // 5) 双击空白新建第二张：卡片中心落在鼠标位置
    // 窗格宽度会随树栏与窄栏变，别用固定偏移：从右下往里找一块放得下整张新卡片（260×160）的空白处
    const f2 = await page.locator(".cv-flow").boundingBox();
    const dbl = await page.evaluate(
      ({ box }) => {
        const free = (x, y) => {
          const el = document.elementFromPoint(x, y);
          return (
            !!el &&
            !el.closest(
              ".react-flow__node, .react-flow__edge, .cv-bar, .cv-side, .cv-rail",
            )
          );
        };
        for (let y = box.y + box.height - 100; y >= box.y + 100; y -= 20)
          for (let x = box.x + box.width - 140; x >= box.x + 140; x -= 20) {
            const ok = [-130, 0, 130].every((dx) =>
              [-80, 0, 80].every((dy) => free(x + dx, y + dy)),
            );
            if (ok) return { x, y };
          }
        return null;
      },
      { box: f2 },
    );
    await page.mouse.dblclick(dbl.x, dbl.y);
    await waitEditor();
    const dr = await page
      .locator(".react-flow__node:has(.cv-node[data-editing])")
      .boundingBox();
    check(
      "双击空白处：新卡片的中心在鼠标位置（不是左上角），允许吸附网格的误差",
      Math.abs(dr.x + dr.width / 2 - dbl.x) <= 12 &&
        Math.abs(dr.y + dr.height / 2 - dbl.y) <= 12,
      JSON.stringify([
        dr.x + dr.width / 2 - dbl.x,
        dr.y + dr.height / 2 - dbl.y,
      ]),
    );
    await page.keyboard.type("第二张");
    await page.keyboard.press("Control+s");
    await sleep(1500);
    await page.keyboard.press("Escape");
    await sleep(500);
    check("新建第二张卡片并保存", (await nodes().count()) === 2);

    // 保存是画布级的：卡片正文、位置都先攒着，工具条一个「保存」一起写。先记下现在的请求数
    const saveBtn = page
      .locator(".cv-bar")
      .getByRole("button", { name: "保存", exact: true });
    const diskCard = () =>
      readFileSync(join(dir, ".canvas", "想法.cards", "风险.md"), "utf8");
    await nodes().first().dblclick();
    await waitEditor();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("，再改一笔");
    await page.keyboard.press("Escape");
    await sleep(500);
    const first = nodeWith("再改一笔");
    check(
      "只改卡片正文、Esc 收起：卡片上标「未保存」并已显示新内容，文件没动",
      (await first.count()) === 1 &&
        (await first.locator(".cv-labtail").textContent())?.includes(
          "未保存",
        ) === true &&
        !diskCard().includes("再改一笔"),
    );
    const before = await first.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + 40);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 90, before.y + 70, {
      steps: 8,
    });
    await page.mouse.up();
    await sleep(1500);
    const wDrag = writes.length;
    // 切回标签后画布会重新适应视野，屏幕坐标会变：比较两张卡片的相对位置（按卡片宽度归一）
    const relative = async () => {
      const m = await nodeWith("再改一笔").boundingBox();
      const o = await nodeWith("第二张").boundingBox();
      return (m.x - o.x) / m.width;
    };
    const relMoved = await relative();
    const unsaved = await board("想法");
    check(
      "拖动节点：不会自己保存，画布文件里的位置没变，工具条标「未保存」",
      unsaved.canvas.nodes.find((n) => n.file.endsWith("风险.md")).x ===
        b1.canvas.nodes[0].x &&
        (await page.locator(".cv-bar .cv-save").textContent())?.includes(
          "未保存",
        ) === true,
    );

    // 切到别的标签再回来：没保存的改动还在
    await host.locator('.ws-pn-tab[data-type="files"]').click();
    await sleep(600);
    await host.locator('.ws-pn-tab[data-type="canvas"]').click();
    await page.waitForSelector(".cv .react-flow__node");
    await sleep(800);
    const relBack = await relative();
    check(
      "切到别的标签再切回：卡片正文与位置都还在，仍是「未保存」",
      Math.abs(relBack - relMoved) < 0.05 &&
        (await page.locator(".cv-bar .cv-save").textContent())?.includes(
          "未保存",
        ) === true &&
        (await nodeWith("再改一笔").locator(".cv-labtail").count()) === 1,
      JSON.stringify([relBack, relMoved]),
    );

    // 窄宽度：主区窄到放不下，「未保存」只留琥珀点（不换行、不叠在别的控件上），树栏强制悬浮
    await page.setViewportSize({ width: 520, height: 1000 });
    await sleep(800);
    const narrowInfo = await page.evaluate(() => {
      const bar = document.querySelector(".cv-bar");
      const save = document.querySelector(".cv-bar .cv-save");
      const text = save?.querySelector(".cv-save-text");
      const dot = save?.firstElementChild?.getBoundingClientRect();
      return {
        overflow: bar ? bar.scrollWidth > bar.clientWidth + 1 : null,
        textHidden: text ? getComputedStyle(text).display === "none" : null,
        dotShown: !!dot && dot.width > 0,
        oneLine: save ? save.getBoundingClientRect().height < 24 : null,
        title: save?.getAttribute("title"),
        treeFixed: document.querySelectorAll(".cv-side:not([data-float])")
          .length,
        rail: document.querySelectorAll(".cv-rail").length,
        toggle: document.querySelectorAll('.cv-bar [aria-label$="侧栏"]')
          .length,
      };
    });
    await shot("14-narrow");
    check(
      "窄宽度：「未保存」只剩琥珀点（悬停有提示）、一行、工具条不溢出；树栏不再占位；窄栏仍在（永久驻留），工具条上没有侧栏开关",
      narrowInfo.textHidden === true &&
        narrowInfo.dotShown &&
        narrowInfo.oneLine &&
        narrowInfo.overflow === false &&
        narrowInfo.title === "未保存" &&
        narrowInfo.treeFixed === 0 &&
        narrowInfo.rail === 1 &&
        narrowInfo.toggle === 0,
      JSON.stringify(narrowInfo),
    );
    await page.setViewportSize({ width: 1860, height: 1000 });
    await sleep(800);

    await saveBtn.click();
    await sleep(1800);
    const saved = await board("想法");
    const nodeA = saved.canvas.nodes.find((n) => n.file.endsWith("风险.md"));
    const sinceDrag = writes.slice(wDrag);
    check(
      "点工具条「保存」：卡片正文和位置在一个请求里写出去（POST /save），标记都消失",
      diskCard().includes("再改一笔") &&
        !!nodeA &&
        nodeA.x !== b1.canvas.nodes[0].x &&
        JSON.stringify(sinceDrag) === JSON.stringify(["POST /save"]) &&
        (await page.locator(".cv-bar .cv-save").count()) === 0 &&
        (await page.locator(".cv-labtail").count()) === 0,
      JSON.stringify(sinceDrag),
    );

    // 连接点：本体贴着卡片的边，感应区 32px（看得见的圈与实际一致），点盖在卡片之上
    const a = await nodeWith("再改一笔").boundingBox();
    const bBox = await nodeWith("第二张").boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await sleep(300);
    const probe = await page.evaluate(
      ({ x, y, w, h }) => {
        const at = (px, py) => {
          const el = document.elementFromPoint(px, py);
          return !!el?.closest(".cv-handle");
        };
        const handle = document.querySelector(
          ".react-flow__node:has(.cv-card) .cv-handle.react-flow__handle-right",
        );
        // 感应圈是 32 个屏幕像素（画布单位 = 32 / 缩放）：量出来的宽度乘缩放
        const zoom = new DOMMatrix(
          getComputedStyle(document.querySelector(".react-flow__viewport"))
            .transform,
        ).a;
        const ring = handle
          ? `${Math.round(Number.parseFloat(getComputedStyle(handle, "::before").width) * zoom)}px`
          : "none";
        return {
          inside: at(x + w - 8, y + h / 2),
          out10: at(x + w + 10, y + h / 2),
          out24: at(x + w + 24, y + h / 2),
          ring,
        };
      },
      { x: a.x, y: a.y, w: a.width, h: a.height },
    );
    check(
      "连接点盖在卡片之上：边内 8px、边外 10px 都点得到连接点，边外 24px 点不到；感应圈是 32 个屏幕像素（不随缩放）",
      probe.inside && probe.out10 && !probe.out24 && probe.ring === "32px",
      JSON.stringify(probe),
    );
    await page.mouse.move(a.x + a.width + 4, a.y + a.height / 2);
    await sleep(400);
    await shot("4a-handle-hover", {
      x: a.x - 30,
      y: a.y - 30,
      width: a.width + 70,
      height: a.height + 60,
    });
    await page.mouse.move(a.x + a.width + 10, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await sleep(800);
    const wiredLocal = await board("想法");
    check(
      "从连接点旁 10px 处起拖、在另一张卡片中间松手：连线先在本地，工具条标「未保存」，文件里还没有",
      wiredLocal.canvas.edges.length === 0 &&
        (await page.locator(".cv .react-flow__edge").count()) === 1 &&
        (await page.locator(".cv-bar .cv-save").count()) === 1,
    );
    await saveBtn.click();
    await sleep(1500);
    const wired = await board("想法");
    check(
      "保存后连线进了画布文件（方向取离落点最近的边）",
      wired.canvas.edges.length === 1 && !!wired.canvas.edges[0].toSide,
      JSON.stringify(wired.canvas.edges),
    );
    // 连线两端紧贴卡片的边（不再悬在 20px 之外）
    const gap = await page.evaluate(() => {
      const path = document.querySelector(".react-flow__edge-interaction");
      const m = path.getScreenCTM();
      const pt = (len) => {
        const p = path.getPointAtLength(len);
        return new DOMPoint(p.x, p.y).matrixTransform(m);
      };
      const boxes = [...document.querySelectorAll(".cv-card .cv-box")].map(
        (e) => e.parentElement.getBoundingClientRect(),
      );
      const dist = (p, r) => {
        const dx = Math.max(r.left - p.x, 0, p.x - r.right);
        const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
        return Math.hypot(dx, dy);
      };
      const near = (p) => Math.min(...boxes.map((r) => dist(p, r)));
      return { start: near(pt(0)), end: near(pt(path.getTotalLength())) };
    });
    check(
      "连线的起点与终点紧贴卡片的边（距离不超过 3px）",
      gap.start <= 3 && gap.end <= 3,
      JSON.stringify(gap),
    );
    await shot("4-wired");

    // 16) 吸附对齐
    // 被拖卡片的右边靠近目标卡片的右边（目标在窗格左缘附近，向左没有余地，所以用右边）；两张宽度相同
    const dragNear = async (altKey, release) => {
      // 先点空白处取消选中：选中了两张时拖一张会两张一起走，目标也跟着动
      const pane = await page.locator(".cv-flow").boundingBox();
      await page.mouse.click(pane.x + 30, pane.y + pane.height - 30);
      await sleep(200);
      const moveBox = await nodeWith("再改一笔").boundingBox();
      const target = await nodeWith("第二张").boundingBox();
      const grabX = moveBox.x + moveBox.width / 2;
      const grabY = moveBox.y + 40;
      const goalRight = target.x + target.width + 4;
      await page.mouse.move(grabX, grabY);
      if (altKey) await page.keyboard.down("Alt");
      await page.mouse.down();
      await page.mouse.move(grabX + 20, grabY + 30, { steps: 3 });
      // 按实测位置微调：被拖卡片的右边落在目标右边之外 4 个屏幕像素（在 6 像素阈值之内）
      for (let i = 0; i < 6; i++) {
        const cur = await nodeWith("再改一笔").boundingBox();
        const off = cur.x + cur.width - goalRight;
        if (Math.abs(off) < 0.6) break;
        await page.mouse.move(grabX + (cur.x - moveBox.x) - off, grabY + 30, {
          steps: 2,
        });
      }
      await sleep(250);
      const guide = await page.locator(".cv-guide").count();
      const during = await nodeWith("再改一笔").boundingBox();
      if (release) {
        await page.mouse.up();
        if (altKey) await page.keyboard.up("Alt");
        await sleep(400);
      }
      return { guide, during, target };
    };
    const snapped = await dragNear(false, false);
    await shot("16-snap-guide");
    await page.mouse.up();
    await sleep(500);
    const rightOf = (b) => b.x + b.width;
    const afterSnap = await nodeWith("再改一笔").boundingBox();
    const guideGone = (await page.locator(".cv-guide").count()) === 0;
    check(
      "拖到别的卡片右边之外 4 屏幕像素处：拖动中出参考线、卡片右边与它对齐（差不到 1px），松手后参考线消失、位置保持",
      snapped.guide >= 1 &&
        Math.abs(rightOf(snapped.during) - rightOf(snapped.target)) < 1 &&
        Math.abs(rightOf(afterSnap) - rightOf(snapped.target)) < 1 &&
        guideGone,
      JSON.stringify({
        guide: snapped.guide,
        during: rightOf(snapped.during),
        target: rightOf(snapped.target),
        after: rightOf(afterSnap),
      }),
    );
    const noSnap = await dragNear(true, true);
    check(
      "按住 Alt 拖：不吸附，没有参考线",
      noSnap.guide === 0,
      String(noSnap.guide),
    );

    // 22) 缩放时吸附：拖右（或左）边到别的卡片的某条线附近，出参考线、边与它对齐；按住 Alt 不吸；编辑状态下也能缩放
    {
      // 用一张专门的卡片来缩放（做完删掉），不动「再改一笔」与「第二张」：后面几条检查按它们现在的位置与缩放量屏幕像素
      const pane = await page.locator(".cv-flow").boundingBox();
      const made = await api("POST", `/canvas/local/cards?${q()}`, {
        board: "想法",
        name: "缩放验",
        text: "缩放验的卡片",
      });
      for (let i = 0; i < 40 && (await nodes().count()) < 3; i++)
        await sleep(250);
      await page.getByRole("button", { name: "适应" }).click();
      await sleep(500);
      await page.mouse.click(pane.x + 30, pane.y + pane.height - 30);
      await sleep(200);
      const resizeNode = () => nodeWith("缩放验的卡片");
      await resizeNode().locator(".cv-box").click();
      await sleep(200);
      const r0 = await resizeNode().boundingBox();
      const t0 = await nodeWith("第二张").boundingBox();
      const zoomNow = await page.evaluate(() => {
        const vp = document.querySelector(".react-flow__viewport");
        return new DOMMatrix(getComputedStyle(vp).transform).a;
      });
      // 最小宽度 160 画布单位：线要在这张卡片的左边（或右边）之外至少这么远再多 40 屏幕像素，才不会缩得比最小宽度还小
      const room = 160 * zoomNow + 40;
      const lines = [t0.x, t0.x + t0.width / 2, t0.x + t0.width];
      // 右边缩到别人的某条线；没有够远的就缩左边
      const lineR = lines.find((l) => l - r0.x >= room);
      const side = lineR === undefined ? "left" : "right";
      const line =
        lineR ?? lines.find((l) => r0.x + r0.width - l >= room) ?? lines[0];
      const edgeOf = (b) => (side === "right" ? b.x + b.width : b.x);
      const dragEdge = async (alt) => {
        const cb = await resizeNode()
          .locator(`.react-flow__resize-control.line.${side}`)
          .boundingBox();
        // 抓边的上 30% 处：正中间被连接点的感应区盖着（那里按下去是拉连线）
        const x0 = cb.x + cb.width / 2;
        const y0 = cb.y + cb.height * 0.3;
        const goal = line + 4;
        if (alt) await page.keyboard.down("Alt");
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        await page.mouse.move((x0 + goal) / 2, y0, { steps: 4 });
        await page.mouse.move(goal, y0, { steps: 4 });
        await sleep(250);
        const guide = await page.locator(".cv-guide").count();
        const during = await resizeNode().boundingBox();
        await page.mouse.up();
        if (alt) await page.keyboard.up("Alt");
        await sleep(300);
        return { guide, during };
      };
      const snappedResize = await dragEdge(false);
      const guideGone2 = (await page.locator(".cv-guide").count()) === 0;
      const afterResize = await resizeNode().boundingBox();
      check(
        "缩放时吸附：把被选中卡片的边拖到别的卡片的边 / 中线外 4 屏幕像素处，拖动中出参考线、边与那条线对齐（差不到 1px），松手后参考线消失、尺寸保持",
        snappedResize.guide >= 1 &&
          Math.abs(edgeOf(snappedResize.during) - line) < 1 &&
          Math.abs(edgeOf(afterResize) - line) < 1 &&
          guideGone2,
        JSON.stringify({
          side,
          line,
          guide: snappedResize.guide,
          during: edgeOf(snappedResize.during),
          after: edgeOf(afterResize),
        }),
      );
      // 回到原样再试 Alt（拖回去，不吸）
      const back = await resizeNode()
        .locator(`.react-flow__resize-control.line.${side}`)
        .boundingBox();
      await page.mouse.move(
        back.x + back.width / 2,
        back.y + back.height * 0.3,
      );
      await page.mouse.down();
      await page.mouse.move(
        back.x + back.width / 2 + (side === "right" ? -60 : 60),
        back.y + back.height * 0.3,
        { steps: 4 },
      );
      await page.mouse.up();
      await sleep(300);
      const altResize = await dragEdge(true);
      check(
        "按住 Alt 缩放：不吸附，没有参考线，边停在指针处（离那条线约 4px）",
        altResize.guide === 0 && Math.abs(edgeOf(altResize.during) - line) > 2,
        JSON.stringify({
          guide: altResize.guide,
          edge: edgeOf(altResize.during),
          line,
        }),
      );

      // 编辑状态下也能缩放：双击进编辑，缩放柄还在，拖右下角能把卡片拉宽，编辑器仍在
      await resizeNode().dblclick();
      await waitEditor();
      const handles = await resizeNode()
        .locator(".react-flow__resize-control.handle")
        .count();
      const before = await resizeNode().boundingBox();
      const corner = await resizeNode()
        .locator(".react-flow__resize-control.handle.bottom.right")
        .boundingBox();
      await page.mouse.move(
        corner.x + corner.width / 2,
        corner.y + corner.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        corner.x + corner.width / 2 + 70,
        corner.y + corner.height / 2 + 30,
        { steps: 5 },
      );
      await page.mouse.up();
      await sleep(300);
      const grown = await resizeNode().boundingBox();
      check(
        "编辑状态下也能缩放：编辑中缩放柄还在（四个角），拖右下角卡片变宽变高，编辑器仍在原位编辑",
        handles >= 4 &&
          grown.width > before.width + 40 &&
          grown.height > before.height + 15 &&
          (await page.locator(".cv-node[data-editing] .cm-content").count()) ===
            1,
        JSON.stringify({ handles, before, grown }),
      );
      const refocused =
        (await page.evaluate(() =>
          document.activeElement?.classList.contains("cm-content"),
        )) === true;
      await page.keyboard.press("Escape");
      await sleep(400);
      check(
        "编辑中缩放完：键盘焦点回到编辑器，按 Esc 能收起编辑",
        refocused &&
          (await page.locator(".cv-node[data-editing]").count()) === 0,
        String(refocused),
      );
      // 收拾：删掉这张专门的卡片（选中、Backspace、确认），节点数回到 2
      await resizeNode()
        .locator(".cv-box")
        .click({ position: { x: 24, y: 24 } });
      await sleep(300);
      const diagSel = await page.evaluate(() => ({
        selected: document.querySelectorAll(".cv-node[data-selected]").length,
        editing: document.querySelectorAll(".cv-node[data-editing]").length,
        active: document.activeElement?.className?.toString().slice(0, 60),
      }));
      await page.keyboard.press("Backspace");
      try {
        await page.getByRole("dialog").waitFor({ timeout: 5000 });
      } catch (e) {
        if (SHOTS)
          await page.screenshot({ path: join(SHOTS, "22-cleanup-fail.png") });
        throw new Error(
          `${e.message.split("\n")[0]} ${JSON.stringify(diagSel)}`,
        );
      }
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "删除", exact: true })
        .click();
      for (let i = 0; i < 40 && (await nodes().count()) !== 2; i++)
        await sleep(250);
      await page.getByRole("button", { name: "适应" }).click();
      await sleep(500);
      check(
        "缩放验用的卡片已删掉，画布回到两张卡片",
        made.status === 201 && (await nodes().count()) === 2,
        `status ${made.status}`,
      );
    }

    // 15) 缩放无关 + 连线在卡片之上
    await nodeWith("第二张").locator(".cv-box").click();
    const layers = await page.evaluate(() => {
      const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
      return {
        edge: z(document.querySelector(".react-flow__edgelabel-renderer")),
        maxNode: Math.max(
          ...[...document.querySelectorAll(".react-flow__node")].map(z),
        ),
      };
    });
    check(
      "连线看得见的那层（线、箭头、标签）层级高于所有卡片，选中的卡片也在它之下",
      layers.edge > layers.maxNode,
      JSON.stringify(layers),
    );
    const measure = () =>
      page.evaluate(() => {
        const vp = document.querySelector(".react-flow__viewport");
        const z = new DOMMatrix(getComputedStyle(vp).transform).a;
        const lb = document.querySelector(".cv-label")?.getBoundingClientRect();
        const poly = document
          .querySelector(".cv-edge-over polygon")
          ?.getBoundingClientRect();
        const h = document.querySelector(".cv-node .cv-handle");
        const ring = h
          ? Number.parseFloat(getComputedStyle(h, "::before").width) * z
          : 0;
        return {
          z,
          labelH: lb ? lb.height : 0,
          arrow: poly ? Math.max(poly.width, poly.height) : 0,
          ring,
        };
      });
    const fb = await page.locator(".cv-flow").boundingBox();
    const zoomBy = async (dy) => {
      await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, dy);
      await page.keyboard.up("Control");
      await sleep(600);
    };
    const z0 = await measure();
    await zoomBy(-150);
    const z1 = await measure();
    await zoomBy(300);
    const z2 = await measure();
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    check(
      "缩放无关：缩放到三档（放大、缩小），卡片名的高度、箭头大小、连接点感应圈在屏幕上都不变（约 20px、10px、32px）",
      Math.abs(z1.z / z0.z - 1) > 0.15 &&
        Math.abs(z2.z / z1.z - 1) > 0.15 &&
        [z0, z1, z2].every(
          (m) =>
            m.labelH > 0 && near(m.arrow, 10, 1.5) && near(m.ring, 32, 1.5),
        ) &&
        near(z1.labelH, z0.labelH, 2) &&
        near(z2.labelH, z0.labelH, 2),
      JSON.stringify([z0, z1, z2]),
    );
    await shot("15-zoomed-out");

    // 6) 刷新
    await page.reload();
    await page.waitForSelector(".cv .react-flow__node");
    await sleep(800);
    check(
      "刷新页面：画布标签还在，打开的还是这块画布，节点与连线都在",
      (await page.locator(".cv-viewname").textContent()) === "想法" &&
        (await nodes().count()) === 2 &&
        (await page.locator(".cv .react-flow__edge").count()) === 1,
    );

    // agent 一侧往画布里加卡片，界面自己刷新
    const agentCard = await api("POST", `/canvas/local/cards?${q()}`, {
      board: "想法",
      name: "agent 加的",
      text: "来自 agent 的一张卡片",
    });
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      seen = (await nodes().count()) === 3;
      if (!seen) await sleep(250);
    }
    check(
      "接口那头加了卡片（agent 的写法）：界面自己刷新出第三张，不用手动",
      agentCard.status === 201 && seen,
      `status ${agentCard.status}`,
    );

    // 7) 删除：Backspace → 确认 → 节点与文件一起没有
    // agent 加的卡片可能落在当前视野之外：先「适应」，让所有卡片都进视野
    await page.getByRole("button", { name: "适应" }).click();
    await sleep(500);
    await nodeWith("agent 加的").locator(".cv-box").click();
    await page.keyboard.press("Backspace");
    await page.getByRole("dialog").waitFor({ timeout: 5000 });
    check(
      "选中灵感卡按 Backspace：先弹确认，说明文件会被删除，此时节点还在",
      (await page.getByRole("dialog").textContent())?.includes(
        "文件会被删除",
      ) === true && (await nodes().count()) === 3,
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await sleep(1500);
    check(
      "确认删除：节点没了，卡片文件也没了",
      (await nodes().count()) === 2 &&
        !existsSync(join(dir, ".canvas", "想法.cards", "agent 加的.md")),
    );

    // 8) 拖文件进画布。先把画布标签拖到右侧拆出窗格，才能同时看到文件管理器
    const canvasTab = host.locator('.ws-pn-tab[data-type="canvas"]');
    const hb = await host.boundingBox();
    await dragTo(canvasTab, host, { x: hb.width - 24, y: hb.height / 2 });
    await page.mouse.move(hb.x + hb.width - 22, hb.y + hb.height / 2, {
      steps: 4,
    });
    await page.mouse.move(hb.x + hb.width - 20, hb.y + hb.height / 2 + 1);
    await sleep(300);
    await page.mouse.up();
    await sleep(800);
    const filesPane = paneOf("files");
    const canvasPane = paneOf("canvas");
    // 文件管理器与终端同在一个窗格，拆窗格后当前标签可能是终端：先切回文件管理器
    await filesPane.locator('.ws-pn-tab[data-type="files"]').click();
    await sleep(500);
    await filesPane.locator(".ws-fm-row[data-name='docs']").dblclick();
    await sleep(800);
    const dropAt = async (name, x, y) => {
      const row = filesPane.locator(
        `.ws-fm-row[data-name='${name}'] .u-lrow-main`,
      );
      await row.waitFor({ timeout: 8000 });
      const rb = await row.boundingBox();
      const cb = await canvasPane.locator(".cv-flow").boundingBox();
      await page.mouse.move(rb.x + 24, rb.y + rb.height / 2);
      await page.mouse.down();
      await page.mouse.move(rb.x + 40, rb.y + rb.height / 2 + 6, { steps: 3 });
      await page.mouse.move(cb.x + x, cb.y + y, { steps: 12 });
      await sleep(300);
      await page.mouse.move(cb.x + x + 2, cb.y + y + 2);
      await page.mouse.up();
      await sleep(1800);
    };
    await dropAt("a.md", 140, 120);
    const withRef = await board("想法");
    check(
      "把文件管理器里的 docs/a.md 拖进画布：成了一个引用节点，路径是 ../docs/a.md",
      withRef.canvas.nodes.some((n) => n.file === "../docs/a.md"),
      JSON.stringify(withRef.canvas.nodes.map((n) => n.file)),
    );
    const refNode = canvasPane.locator(".cv-ref", {
      hasText: "项目里的一份文档",
    });
    const refLabel = await refNode.locator(".cv-label").textContent();
    check(
      "引用卡上方标 主机:路径（文件名完整），里面渲染 markdown 预览",
      (await refNode.count()) === 1 &&
        /^本机:\/.*a\.md$/.test(refLabel ?? "") &&
        (await refNode.locator(".cv-md h1").count()) === 1,
      JSON.stringify(refLabel),
    );
    await shot("5-ref");

    // 23) 内容显示不下：没选中时直接显示滚动条，但只是提示、不能交互；选中（或编辑）之后才能拖滚动条
    {
      const pane = await page.locator(".cv-flow").boundingBox();
      await page.mouse.click(pane.x + 30, pane.y + pane.height - 30);
      await sleep(300);
      const body = refNode.locator(".cv-nbody");
      const state = () =>
        body.evaluate((el) => {
          const node = el.closest(".cv-node");
          const r = el.getBoundingClientRect();
          const bar = el.offsetWidth - el.clientWidth;
          const hit = document.elementFromPoint(r.right - 4, r.top + 24);
          return {
            selected: node.hasAttribute("data-selected"),
            scrollbar: bar,
            over: el.scrollHeight > el.clientHeight,
            overflowY: getComputedStyle(el).overflowY,
            pe: getComputedStyle(el).pointerEvents,
            hitIsBody: !!hit && (hit === el || el.contains(hit)),
            marked: node.hasAttribute("data-scroll"),
            scrollTop: el.scrollTop,
          };
        });
      // 卡片可能有一部分在窗口外（滚动条在右缘）：用滚轮把画布往左平移到看得见，量完再平移回去
      const vw = page.viewportSize().width;
      const bb0 = await body.boundingBox();
      const shift = Math.max(0, Math.ceil(bb0.x + bb0.width + 24 - vw));
      if (shift > 0) {
        await page.mouse.move(pane.x + pane.width / 2, pane.y + 200);
        await page.mouse.wheel(shift, 0);
        await sleep(400);
      }
      const viewX = () =>
        page.evaluate(() => {
          const vp = document.querySelector(".react-flow__viewport");
          return new DOMMatrix(getComputedStyle(vp).transform).e;
        });
      const idle = await state();
      check(
        "内容显示不下的卡片：没选中也直接显示滚动条（overflow-y 是 auto、有 8px 宽的滚动条、内容确实比卡片高），但整块不接鼠标（滚动条处按下去落在卡片上，不是滚动条）",
        idle.over &&
          idle.scrollbar === 8 &&
          idle.overflowY === "auto" &&
          !idle.selected &&
          idle.pe === "none" &&
          !idle.hitIsBody,
        JSON.stringify(idle),
      );
      // 没选中时在滚动条处按下并拖：内容不滚（拖的是卡片，拖回原处）
      const bb = await body.boundingBox();
      const gx = bb.x + bb.width - 4;
      await page.mouse.move(gx, bb.y + 24);
      await page.mouse.down();
      await page.mouse.move(gx, bb.y + 24 + 40, { steps: 4 });
      await page.mouse.move(gx, bb.y + 24, { steps: 4 });
      await page.mouse.up();
      await sleep(200);
      const afterIdleDrag = await state();
      // 中键按住往下拖：内容不滚（也就没有自动滚动），画布被平移
      const vx0 = await viewX();
      await page.mouse.move(bb.x + 60, bb.y + 60);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(bb.x + 60 - 70, bb.y + 60 + 50, { steps: 6 });
      await sleep(400);
      const midScroll = (await state()).scrollTop;
      await page.mouse.up({ button: "middle" });
      await sleep(200);
      const vx1 = await viewX();
      check(
        "没选中时：在滚动条处按下拖动、中键拖动，卡片内容都不滚（scrollTop 一直是 0）；中键拖的是画布（视口平移了）",
        afterIdleDrag.scrollTop === 0 &&
          midScroll === 0 &&
          Math.abs(vx1 - vx0) > 40,
        JSON.stringify({
          afterIdleDrag: afterIdleDrag.scrollTop,
          midScroll,
          vx0,
          vx1,
        }),
      );
      // 选中之后：滚动条接鼠标了，按住滚动条往下拖，内容跟着滚，卡片没有被拖走（右边缩放感应带让开了滚动条）
      await refNode.locator(".cv-box").click({ position: { x: 24, y: 24 } });
      await sleep(300);
      const picked = await state();
      const nodeBefore = await refNode.boundingBox();
      const bb2 = await body.boundingBox();
      const gx2 = bb2.x + bb2.width - 4;
      await page.mouse.move(gx2, bb2.y + 24);
      await page.mouse.down();
      await page.mouse.move(gx2, bb2.y + 24 + 50, { steps: 5 });
      await page.mouse.up();
      await sleep(200);
      const scrolled = (await state()).scrollTop;
      const nodeAfter = await refNode.boundingBox();
      await shot("23-scrollbar");
      if (shift > 0) {
        await page.mouse.move(pane.x + pane.width / 2, pane.y + 200);
        await page.mouse.wheel(-shift, 0);
        await sleep(300);
      }
      check(
        "选中之后：滚动条接鼠标（hit 在内容块上、pointer-events 恢复），按住往下拖内容跟着滚，卡片本身没有被拖走；缩放感应带让开了滚动条（节点标了 data-scroll）",
        picked.selected &&
          picked.pe !== "none" &&
          picked.hitIsBody &&
          picked.marked &&
          scrolled > 20 &&
          Math.abs(nodeAfter.x - nodeBefore.x) < 1 &&
          Math.abs(nodeAfter.y - nodeBefore.y) < 1,
        JSON.stringify({ picked, scrolled, nodeBefore, nodeAfter }),
      );
      await page.mouse.click(pane.x + 30, pane.y + pane.height - 30);
      await sleep(300);
      // 没选中时内容块虽然不接鼠标，里面本来要点的东西必须照旧能点：链接、按钮、<video>、<audio>
      const clickable = await page.evaluate(() => {
        const probe = (tag) => {
          const host = document.querySelector(
            ".cv-node:not([data-selected], [data-editing]) .cv-scroll",
          );
          if (!host) return null;
          const el = document.createElement(tag);
          host.appendChild(el);
          const pe = getComputedStyle(el).pointerEvents;
          el.remove();
          return pe;
        };
        return {
          host: getComputedStyle(
            document.querySelector(
              ".cv-node:not([data-selected], [data-editing]) .cv-scroll",
            ),
          ).pointerEvents,
          a: probe("a"),
          button: probe("button"),
          video: probe("video"),
          audio: probe("audio"),
        };
      });
      check(
        "没选中的节点：内容块自己不接鼠标，里面的链接、按钮、<video>、<audio> 照旧接（视频的「播放」按钮不能被屏蔽）",
        clickable.host === "none" &&
          ["a", "button", "video", "audio"].every(
            (t) => clickable[t] === "auto",
          ),
        JSON.stringify(clickable),
      );
    }

    // 图片：小图直接显示，大图显示的是缩略图
    await dropAt("small.png", 140, 420);
    await dropAt("big.png", 330, 420);
    const imgs = await canvasPane.locator(".cv-img").evaluateAll((els) =>
      els.map((e) => ({
        ok: e.complete && e.naturalWidth > 0,
        w: e.naturalWidth,
        h: e.naturalHeight,
      })),
    );
    check(
      "图片引用显示成图片；2400×1600 的大图拿到的是缩略图（最长边不超过 2000）",
      imgs.length === 2 &&
        imgs.every((i) => i.ok) &&
        imgs.some((i) => i.w === 320 && i.h === 200) &&
        imgs.some((i) => i.w <= 2000 && i.w > 0 && i.w < 2400),
      JSON.stringify(imgs),
    );
    await sleep(500);
    // 图片放下后按比例定的高度也是画布改动：保存之后才在文件里
    await canvasPane
      .locator(".cv-bar")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await sleep(1500);
    const fitted = await board("想法");
    const bigNode = fitted.canvas.nodes.find(
      (n) => n.file === "../docs/big.png",
    );
    check(
      "刚放进来的图片按图片比例定高度（3:2 的图，宽 320 → 高约 213）",
      !!bigNode &&
        Math.abs(bigNode.height - Math.round(bigNode.width / 1.5)) <= 8,
      JSON.stringify([bigNode?.width, bigNode?.height]),
    );
    await shot("6-images");

    // 以前被随意拉伸过的图片：载入时对齐到图片本身的比例（宽度不变），画布标「未保存」
    const stretched = structuredClone((await board("想法")).canvas);
    stretched.nodes.find((n) => n.file === "../docs/big.png").height = 420;
    const putStretched = await fetch(
      `${origin}/api/v1/canvas/local/board?${q({ name: "想法" })}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stretched),
      },
    );
    await page.reload();
    await page.waitForSelector(".cv .react-flow__node");
    await sleep(1500);
    const bigBox = canvasPane.locator(".react-flow__node", {
      has: page.locator("img.cv-img[alt='big.png']"),
    });
    const ratioOf = async (loc) => {
      const b = await loc.boundingBox();
      return b.width / b.height;
    };
    check(
      "以前拉伸过的图片：载入后宽高比回到图片本身的比例（3:2），画布标「未保存」",
      putStretched.ok &&
        Math.abs((await ratioOf(bigBox)) - 1.5) < 0.03 &&
        (await canvasPane.locator(".cv-bar .cv-save").count()) === 1,
      JSON.stringify([putStretched.status, await ratioOf(bigBox)]),
    );

    // 缩放：图片等比例；普通卡片仍可任意比例。感应区 32px（角点 32px 的圈，四边 32px 宽的带）
    await canvasPane.getByRole("button", { name: "适应" }).click();
    await sleep(500);
    await bigBox.locator(".cv-box").click();
    await sleep(300);
    const target = await bigBox.boundingBox();
    const resizeProbe = await page.evaluate(
      ({ x, y, w, h }) => {
        // 感应区是 32 个屏幕像素（与连接点的感应圈一样，不随缩放）：偏移直接是屏幕像素
        const z = new DOMMatrix(
          getComputedStyle(document.querySelector(".react-flow__viewport"))
            .transform,
        ).a;
        const near = 10;
        const far = 24;
        const part = (px, py) => {
          const el = document
            .elementFromPoint(px, py)
            ?.closest(".react-flow__resize-control");
          return el
            ? [...el.classList]
                .filter((c) => /^(line|handle|top|bottom|left|right)$/.test(c))
                .join(" ")
            : "";
        };
        return {
          z,
          cornerIn: part(x + w - near, y + h - near),
          cornerOut: part(x + w + near, y + h + near),
          cornerFar: part(x + w + far, y + h + far),
          edgeIn: part(x + near, y + h * 0.3),
          edgeOut: part(x - near, y + h * 0.3),
          edgeFar: part(x - far, y + h * 0.3),
          body: part(x + w / 2, y + h / 2),
        };
      },
      { x: target.x, y: target.y, w: target.width, h: target.height },
    );
    check(
      "缩放感应区 32 个屏幕像素（不随缩放，与连接点一样）：角点内外 10px 都点得到、外 24px 点不到；边的两侧 10px 点得到、外 24px 点不到；卡片中间不是缩放区",
      /handle/.test(resizeProbe.cornerIn) &&
        /handle/.test(resizeProbe.cornerOut) &&
        resizeProbe.cornerFar === "" &&
        /line.*left|left.*line/.test(resizeProbe.edgeIn) &&
        /line.*left|left.*line/.test(resizeProbe.edgeOut) &&
        resizeProbe.edgeFar === "" &&
        resizeProbe.body === "",
      JSON.stringify(resizeProbe),
    );
    await page.mouse.move(
      target.x + target.width + 4,
      target.y + target.height + 4,
    );
    await sleep(300);
    await shot("6a-resize-hover", {
      x: target.x - 40,
      y: target.y - 40,
      width: target.width + 80,
      height: target.height + 80,
    });
    // 从右下角斜着拖：横向多拖、纵向少拖，图片仍保持 3:2
    await page.mouse.down();
    await page.mouse.move(
      target.x + target.width + 70,
      target.y + target.height + 4,
      {
        steps: 8,
      },
    );
    await page.mouse.up();
    await sleep(500);
    const afterCorner = await bigBox.boundingBox();
    check(
      "拖图片的角点：宽高比仍是 3:2，尺寸确实变了（不会出现空白）",
      Math.abs(afterCorner.width / afterCorner.height - 1.5) < 0.03 &&
        afterCorner.width > target.width + 20,
      JSON.stringify([
        target.width,
        target.height,
        afterCorner.width,
        afterCorner.height,
      ]),
    );
    // 拖图片的左边（右边可能已经拖到视口之外）：只动横向，高度跟着等比
    await page.mouse.move(
      afterCorner.x - 4,
      afterCorner.y + afterCorner.height * 0.3,
    );
    await page.mouse.down();
    await page.mouse.move(
      afterCorner.x + 44,
      afterCorner.y + afterCorner.height * 0.3,
      { steps: 8 },
    );
    await page.mouse.up();
    await sleep(500);
    const afterEdge = await bigBox.boundingBox();
    check(
      "拖图片的边：宽高比仍是 3:2，宽度变小了",
      Math.abs(afterEdge.width / afterEdge.height - 1.5) < 0.03 &&
        afterEdge.width < afterCorner.width - 20,
      JSON.stringify([afterCorner.width, afterEdge.width, afterEdge.height]),
    );
    // 普通卡片（markdown 引用）不锁比例：只拖右边，高度不变
    const mdBox = canvasPane.locator(".react-flow__node", {
      has: page.locator(".cv-ref .cv-md"),
    });
    await mdBox.locator(".cv-box").click();
    await sleep(300);
    const md0 = await mdBox.boundingBox();
    // 抓边的上 15% 处：正中间被连接点的感应区盖着（那里按下去是拉连线）；内容溢出的卡片边里只留 2px，所以按在边外 4px
    await page.mouse.move(md0.x + md0.width + 4, md0.y + md0.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(md0.x + md0.width + 48, md0.y + md0.height * 0.15, {
      steps: 6,
    });
    await page.mouse.up();
    await sleep(500);
    const md1 = await mdBox.boundingBox();
    check(
      "普通卡片仍可任意比例缩放：拖右边只改宽度，高度不变",
      md1.width > md0.width + 15 && Math.abs(md1.height - md0.height) < 3,
      JSON.stringify([md0.width, md0.height, md1.width, md1.height]),
    );

    // 多媒体：GIF 原样（会动）、视频与音频点了才播。节点直接写进画布文件，刷新后看
    const withMedia = structuredClone((await board("想法")).canvas);
    const mediaNode = (id, file, x, w, h) => ({
      id,
      type: "file",
      file,
      x,
      y: 1800,
      width: w,
      height: h,
    });
    withMedia.nodes.push(
      mediaNode("mv", "../docs/clip.mp4", 0, 480, 270),
      mediaNode("ma", "../docs/tone.mp3", 600, 320, 96),
      mediaNode("mg", "../docs/loop.gif", 1000, 320, 160),
    );
    await fetch(`${origin}/api/v1/canvas/local/board?${q({ name: "想法" })}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withMedia),
    });
    await page.reload();
    await page.waitForSelector(".cv .react-flow__node");
    await sleep(1500);
    await canvasPane.getByRole("button", { name: "适应" }).click();
    await sleep(800);
    const playBtn = canvasPane.getByRole("button", { name: "播放 clip.mp4" });
    check(
      "视频卡片平时只有一个「播放」按钮：没有 <video>，也没有请求音视频流；音频有播放条但不预读",
      (await playBtn.count()) === 1 &&
        (await canvasPane.locator("video").count()) === 0 &&
        (await canvasPane.locator("audio.cv-audio[preload='none']").count()) ===
          1 &&
        mediaReqs.length === 0,
      JSON.stringify(mediaReqs),
    );
    await shot("7-media");
    const played = page.waitForRequest(
      (r) => r.url().includes("/media?") && r.url().includes("clip.mp4"),
    );
    await playBtn.click();
    const playReq = await played;
    await sleep(500);
    check(
      "点「播放」才请求视频：带 Range、走画布的媒体接口；之后出现 <video>（或解码失败的提示，这里的内容不是真视频）",
      playReq.headers().range !== undefined &&
        ((await canvasPane.locator("video.cv-video").count()) === 1 ||
          (await canvasPane.getByText("这个视频浏览器播不了").count()) === 1),
      JSON.stringify([playReq.headers().range, mediaReqs]),
    );

    // GIF：不超过上限原样给（动画保留）；设置里把上限调到 1MB，3MB 的 GIF 就只剩第一帧缩略图
    const gifUrl = await canvasPane
      .locator("img.cv-img[alt='loop.gif']")
      .evaluate((el) => el.src);
    const gifKind = () =>
      page.evaluate(
        async (u) =>
          (await fetch(u, { cache: "no-store" })).headers.get("x-canvas-image"),
        gifUrl,
      );
    const gifRaw = await gifKind();
    const putMedia = (gifMaxMB) =>
      api("PUT", "/defaults", {
        canvasMedia: {
          thumbMaxSide: 2000,
          thumbQuality: 85,
          gifMaxMB,
          sourceMaxMB: 20,
          assetGitMaxMB: 5,
          uploadMaxMB: 500,
        },
      });
    await putMedia(1);
    const small = await gifKind();
    await putMedia(8);
    const restored = await gifKind();
    check(
      "GIF：3MB 的动图默认原样给出（raw）；设置里把上限调到 1MB 后立即只给缩略图（thumb），调回去又原样",
      gifRaw === "raw" && small === "thumb" && restored === "raw",
      JSON.stringify([gifRaw, small, restored]),
    );

    await refNode.locator(".cv-box").dblclick();
    await sleep(1200);
    check(
      "双击引用卡：在预览标签里打开这个文件",
      (await page.locator(".ws-pn-tab[data-type='preview']").count()) === 1,
    );

    // 9) 历史来源
    await sleep(6500);
    const log = git("log --format=%s");
    check(
      "保存的改动合成提交，来源是 user",
      /^user\b/m.test(log),
      JSON.stringify(log.split("\n").slice(0, 6)),
    );

    // 11) 手势、右键菜单、复制粘贴、网页链接、视频拖动、最大 500%：在新画布「手势」上做，结束时才保存
    {
      // 一个本地网页，给链接卡片抓：标题、摘要、封面
      const coverPng = png(320, 200);
      const web = createServer((req, res) => {
        if (req.url === "/cover.png") {
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(coverPng);
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          '<html><head><title>备用标题</title><meta property="og:title" content="本地测试页"><meta property="og:description" content="这是一段摘要"><meta property="og:image" content="/cover.png"></head><body></body></html>',
        );
      });
      await new Promise((r) => web.listen(0, "127.0.0.1", r));
      const pageUrl = `http://127.0.0.1:${web.address().port}/page`;

      // 用一个全新的页面：前面的步骤留下的分栏、没保存的改动都不带进来，画布有整块的宽度
      const page = await (
        await browser.newContext({ viewport: { width: 2800, height: 1200 } })
      ).newPage();
      page.on("pageerror", (e) =>
        problems.push(`pageerror ${e.message.split("\n")[0]}`),
      );
      // 故意触发服务端拒绝（改名撞名的 409）时打开：窗口内的 409 与浏览器为它打的 console.error 不算问题
      let expectFail = false;
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        if (expectFail && /status of 409/.test(m.text())) return;
        problems.push(`console.error ${m.text().slice(0, 140)}`);
      });
      page.on("response", (r) => {
        if (!r.url().includes("/api/v1/") || r.status() < 400) return;
        if (expectFail && r.status() === 409) return;
        problems.push(
          `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
      });
      const nodes = () => page.locator(".cv .react-flow__node");
      const shot = async (n) => {
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${n}.png`) });
      };
      const waitEditor = async () => {
        await page.waitForSelector(".cv-node[data-editing] .cm-content", {
          timeout: 15000,
        });
        await sleep(300);
      };
      const paste = (specs) =>
        page.evaluate((specs) => {
          const dt = new DataTransfer();
          for (const f of specs)
            dt.items.add(
              new File(
                [Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))],
                f.name,
                { type: f.type },
              ),
            );
          document.querySelector(".cv").dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
        }, specs);
      const saveBtn = page
        .locator(".cv-bar")
        .getByRole("button", { name: "保存", exact: true });
      // 工作区与它的分栏记在 Server 上（一个目录一个工作区），新页面会带着前面的分栏：另用一个目录，布局与画布都是干净的
      const dir2 = join(work, "proj2");
      mkdirSync(join(dir2, "docs"), { recursive: true });
      // 项目内的文件：拖拽引用检查要用（相对路径）
      writeFileSync(join(dir2, "docs", "intro.md"), "# 介绍\n");
      writeFileSync(join(dir2, "docs", "pic.png"), png(40, 30));
      execSync("git init -q", { cwd: dir2 });
      const ws2 = await api("POST", "/workspaces", {
        name: "手势验",
        directories: [{ path: dir2 }],
      });
      await api("POST", "/sessions", { workspaceId: ws2.body.id });
      await page.goto(origin);
      await page.waitForSelector(".sh-app");
      await page.locator(".rl-wh", { hasText: "手势验" }).click();
      await page.waitForSelector(".ws-pane");
      await sleep(1000);
      await page
        .locator(".ws-pane")
        .first()
        .getByRole("button", { name: "新建标签页" })
        .click();
      await page.getByRole("menuitem", { name: "画布" }).click();
      await page.waitForSelector(".cv");
      await page.getByRole("button", { name: "新建画布" }).last().click();
      await page.getByLabel("名字", { exact: true }).fill("手势");
      await page.locator('button[type="submit"]', { hasText: "新建" }).click();
      await page.waitForSelector(".cv-hint");
      await sleep(700);

      const pane = page.locator(".cv-flow .react-flow__pane");
      const pb = await pane.boundingBox();
      const at = (fx, fy) => ({
        x: pb.x + fx * pb.width,
        y: pb.y + fy * pb.height,
      });
      const blank = { x: pb.x + 12, y: pb.y + pb.height - 12 };
      const clearSel = async () => {
        await page.mouse.click(blank.x, blank.y);
        await sleep(200);
      };
      const edges = () => page.locator(".cv .react-flow__edge");
      const box = async (i) => nodes().nth(i).boundingBox();
      const vp = async () => {
        const t = await page
          .locator(".cv .react-flow__viewport")
          .evaluate((el) => el.style.transform);
        const m =
          /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(
            t,
          );
        return { x: +m[1], y: +m[2], z: +m[3] };
      };
      const edgeMid = (i) =>
        page.evaluate((i) => {
          const path = document.querySelectorAll(
            ".react-flow__edge-interaction",
          )[i];
          const p = path.getPointAtLength(path.getTotalLength() / 2);
          const pt = new DOMPoint(p.x, p.y).matrixTransform(
            path.getScreenCTM(),
          );
          return { x: pt.x, y: pt.y };
        }, i);

      // 三张空卡片（双击空白新建，中心在鼠标处）
      for (const [fx, fy] of [
        [0.2, 0.25],
        [0.55, 0.25],
        [0.55, 0.65],
      ]) {
        const p = at(fx, fy);
        await page.mouse.dblclick(p.x, p.y);
        await sleep(450);
        await page.keyboard.press("Escape");
        await page.mouse.click(blank.x, blank.y);
        await sleep(200);
      }
      const [b0, b1, b2] = [await box(0), await box(1), await box(2)];
      check("手势：三张新卡片都在画布里", (await nodes().count()) === 3);

      // 连线松在卡片范围内的任何位置都连得上；拖线经过时那张卡片亮起来
      await page.mouse.move(b0.x + b0.width + 10, b0.y + b0.height / 2);
      await page.mouse.down();
      await page.mouse.move(b1.x + 60, b1.y + 80, { steps: 12 });
      const lit = await page.locator(".react-flow__node.cv-target").count();
      await page.mouse.up();
      await sleep(300);
      await page.mouse.move(b0.x + b0.width + 10, b0.y + b0.height / 2);
      await page.mouse.down();
      await page.mouse.move(b2.x + b2.width - 40, b2.y + b2.height - 30, {
        steps: 12,
      });
      await page.mouse.up();
      await sleep(300);
      check(
        "连线松在卡片中间任何位置（左侧内部、右下角内部）都连得上，拖线经过时目标卡片亮起",
        (await edges().count()) === 2 && lit === 1,
        JSON.stringify([await edges().count(), lit]),
      );
      await shot("11-connected");

      // 左键拖空白是框选：框住卡片 2、3，不动视野
      await clearSel();
      const vp0 = await vp();
      await page.mouse.move(b1.x - 30, b1.y - 40);
      await page.mouse.down();
      await page.mouse.move(b1.x + b1.width + 30, b2.y + b2.height + 40, {
        steps: 10,
      });
      await shot("11-marquee");
      await page.mouse.up();
      await sleep(250);
      const sel = await page.locator(".react-flow__node.selected").count();
      const vp1 = await vp();
      check(
        "左键拖空白框选：框住的两张卡片被选中，视野没动",
        sel === 2 && vp1.x === vp0.x && vp1.y === vp0.y,
        JSON.stringify([sel, vp0, vp1]),
      );

      // 只框住一条连线（不碰任何卡片）：线被选中，卡片都没选
      await clearSel();
      const mid = await edgeMid(0);
      await page.mouse.move(mid.x - 30, mid.y - 22);
      await page.mouse.down();
      await page.mouse.move(mid.x + 30, mid.y + 22, { steps: 6 });
      await page.mouse.up();
      await sleep(250);
      check(
        "框住一条连线：线被选中，没有卡片被选中",
        (await page.locator(".react-flow__edge.selected").count()) === 1 &&
          (await page.locator(".react-flow__node.selected").count()) === 0,
        JSON.stringify([
          await page.locator(".react-flow__edge.selected").count(),
          await page.locator(".react-flow__node.selected").count(),
        ]),
      );

      // 平移：空格+拖、鼠标中键拖；触控板的小步长滑动平移、物理滚轮的大步长缩放
      await clearSel();
      const pv0 = await vp();
      await page.keyboard.down("Space");
      await page.mouse.move(blank.x + 100, blank.y - 150);
      await page.mouse.down();
      await page.mouse.move(blank.x + 180, blank.y - 120, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      const pv1 = await vp();
      await page.mouse.move(blank.x + 100, blank.y - 150);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(blank.x + 160, blank.y - 150, { steps: 6 });
      await page.mouse.up({ button: "middle" });
      const pv2 = await vp();
      await page.mouse.move(blank.x + 100, blank.y - 150);
      await page.mouse.wheel(0, 8);
      await sleep(400);
      const pv3 = await vp();
      await page.mouse.wheel(0, 120);
      await sleep(400);
      const pv4 = await vp();
      check(
        "平移：空格+拖、鼠标中键拖都能平移；滚轮小步长（触控板）平移不缩放，大步长（物理滚轮）缩放",
        Math.abs(pv1.x - pv0.x - 80) < 3 &&
          Math.abs(pv2.x - pv1.x - 60) < 3 &&
          pv3.z === pv2.z &&
          Math.abs(pv3.y - pv2.y + 8) < 1 &&
          pv4.z !== pv3.z,
        JSON.stringify([pv0, pv1, pv2, pv3, pv4]),
      );
      await page.getByRole("button", { name: "适应" }).click();
      await sleep(500);

      // 右键菜单：空白处、卡片（还没保存的也有）、连线
      const menuLabels = () =>
        page
          .getByRole("menuitem")
          .evaluateAll((els) =>
            els.map((e) => e.textContent?.trim().replace(/Ctrl\+\w$/, "")),
          );
      const blank2 = { x: pb.x + pb.width - 20, y: pb.y + 40 };
      await page.mouse.click(blank2.x, blank2.y, { button: "right" });
      await sleep(250);
      const paneMenu = await menuLabels();
      await page.getByRole("menuitem", { name: "全选" }).click();
      await sleep(250);
      const allSel = [
        await page.locator(".react-flow__node.selected").count(),
        await page.locator(".react-flow__edge.selected").count(),
      ];
      await clearSel();
      const nb = await box(1);
      await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2, {
        button: "right",
      });
      await sleep(250);
      const cardMenu = await menuLabels();
      await page.keyboard.press("Escape");
      await clearSel();
      const em = await edgeMid(0);
      await page.mouse.click(em.x, em.y, { button: "right" });
      await sleep(250);
      const edgeMenu = await menuLabels();
      check(
        "右键菜单：空白处（新建卡片 / 粘贴 / 全选 / 适应窗口）、没保存的卡片（编辑 / 复制 / 从画布移除）、连线（反向 / 删除连线）；全选选中全部节点与连线",
        JSON.stringify(paneMenu) ===
          JSON.stringify(["新建卡片", "粘贴", "全选", "适应窗口"]) &&
          JSON.stringify(allSel) === JSON.stringify([3, 2]) &&
          JSON.stringify(cardMenu) ===
            JSON.stringify(["编辑", "复制", "从画布移除"]) &&
          JSON.stringify(edgeMenu) === JSON.stringify(["反向", "删除连线"]),
        JSON.stringify([paneMenu, allSel, cardMenu, edgeMenu]),
      );
      await page.getByRole("menuitem", { name: "反向" }).click();
      await sleep(300);

      // 复制粘贴：卡片 2 写上字，复制，鼠标放到空地粘贴 → 新卡片的中心在鼠标处、带着正文、被选中；不动鼠标再粘一次错开一点
      await clearSel();
      const cb1 = await box(1);
      await page.mouse.dblclick(cb1.x + cb1.width / 2, cb1.y + cb1.height / 2);
      await waitEditor();
      await page.keyboard.type("复制我");
      await page.keyboard.press("Escape");
      await sleep(300);
      await page.mouse.click(cb1.x + cb1.width / 2, cb1.y + cb1.height / 2);
      await sleep(200);
      const dtCopy = () =>
        page.evaluate(() => {
          window.__dt = new DataTransfer();
          document.querySelector(".cv").dispatchEvent(
            new ClipboardEvent("copy", {
              clipboardData: window.__dt,
              bubbles: true,
              cancelable: true,
            }),
          );
          return window.__dt.getData("text/plain");
        });
      const dtPaste = (text) =>
        page.evaluate((text) => {
          const dt = new DataTransfer();
          if (text !== undefined) dt.setData("text/plain", text);
          else dt.setData("text/plain", window.__dt.getData("text/plain"));
          document.querySelector(".cv").dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
        }, text);
      const copied = await dtCopy();
      const spot = at(0.2, 0.75);
      await page.mouse.move(spot.x, spot.y);
      await dtPaste();
      await sleep(700);
      const center = async (i) => {
        const b = await box(i);
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      };
      const n1 = await nodes().count();
      const c1 = await center(n1 - 1);
      await dtPaste();
      await sleep(700);
      const c2 = await center((await nodes().count()) - 1);
      const zoomNow = (await vp()).z;
      check(
        "复制卡片再粘贴：系统剪贴板里是卡片正文；新卡片中心落在鼠标处、带着正文并被选中；不动鼠标再粘一次错开 24 个画布单位",
        copied === "复制我" &&
          n1 === 4 &&
          Math.hypot(c1.x - spot.x, c1.y - spot.y) < 12 * zoomNow + 4 &&
          (await nodes().last().innerText()).includes("复制我") &&
          (await page.locator(".react-flow__node.selected").count()) === 1 &&
          Math.abs(c2.x - c1.x - 24 * zoomNow) < 6 &&
          Math.abs(c2.y - c1.y - 24 * zoomNow) < 6,
        JSON.stringify([copied, n1, c1, spot, c2, zoomNow]),
      );

      // 粘贴网页链接：每行都是地址才算；链接卡片显示 Server 抓到的标题、摘要、封面；别的文字不处理；双击在新标签页打开
      const spot2 = at(0.78, 0.5);
      await page.mouse.move(spot2.x, spot2.y);
      const nBefore = await nodes().count();
      await dtPaste("随便一句话，不是链接");
      await sleep(300);
      const ignored = (await nodes().count()) === nBefore;
      await dtPaste(pageUrl);
      await page
        .locator(".cv-link .cv-linktitle", { hasText: "本地测试页" })
        .waitFor({ timeout: 15000 });
      await sleep(600);
      const link = nodes().filter({ has: page.locator(".cv-link") });
      const lb = await link.boundingBox();
      const coverW = await page
        .locator("img.cv-linkcover")
        .evaluate((el) => el.naturalWidth);
      const [popup] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 8000 }),
        link.locator(".cv-box").dblclick(),
      ]);
      await popup.waitForLoadState("domcontentloaded");
      const popupUrl = popup.url();
      await popup.close();
      await shot("11-link");
      check(
        "粘贴网页链接：不是链接的文字不处理；链接卡片显示标题 / 摘要 / 封面，中心在鼠标处；双击在新标签页打开",
        ignored &&
          (await link.innerText()).includes("这是一段摘要") &&
          coverW === 320 &&
          Math.hypot(
            lb.x + lb.width / 2 - spot2.x,
            lb.y + lb.height / 2 - spot2.y,
          ) <
            12 * zoomNow + 4 &&
          popupUrl === pageUrl,
        JSON.stringify([ignored, coverW, popupUrl]),
      );

      // 播放中的视频：上沿的拖动条能把卡片挪走（浏览器自己录一段 webm，保证能解码）
      const webm = await page.evaluate(async () => {
        const c = document.createElement("canvas");
        c.width = 320;
        c.height = 180;
        const g = c.getContext("2d");
        const rec = new MediaRecorder(c.captureStream(15), {
          mimeType: "video/webm",
        });
        const chunks = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        const done = new Promise((r) => (rec.onstop = r));
        rec.start();
        for (let i = 0; i < 20; i++) {
          g.fillStyle = `hsl(${i * 18},80%,50%)`;
          g.fillRect(0, 0, 320, 180);
          await new Promise((r) => setTimeout(r, 50));
        }
        rec.stop();
        await done;
        const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let s = "";
        for (const b of buf) s += String.fromCharCode(b);
        return btoa(s);
      });
      await page.mouse.move(at(0.4, 0.88).x, at(0.4, 0.88).y);
      await paste([{ name: "rec.webm", type: "video/webm", b64: webm }]);
      await page
        .getByText("已放入 1 个文件")
        .first()
        .waitFor({ timeout: 15000 });
      await sleep(800);
      await page.getByRole("button", { name: "播放 rec.webm" }).click();
      await page.waitForSelector("video.cv-video", { timeout: 10000 });
      const vnode = nodes().filter({ has: page.locator("video.cv-video") });
      const vb = await vnode.boundingBox();
      await page.mouse.move(vb.x + 30, vb.y + vb.height / 2);
      await sleep(300);
      const v0 = await vnode.boundingBox();
      const grip = await vnode.locator(".cv-vgrip").boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        grip.x + grip.width / 2 + 150,
        grip.y + grip.height / 2 + 40,
        { steps: 8 },
      );
      await page.mouse.up();
      await sleep(300);
      const v1 = await vnode.boundingBox();
      check(
        "播放中的视频：抓上沿的拖动条能挪动卡片",
        Math.abs(v1.x - v0.x - 150) < 24 && Math.abs(v1.y - v0.y - 40) < 24,
        JSON.stringify([v0, v1]),
      );

      // 最大放大倍率 500%
      for (let i = 0; i < 18; i++) {
        await page.getByRole("button", { name: "放大" }).click();
        await sleep(120);
      }
      await sleep(300);
      check(
        "最大放大倍率是 500%",
        (await page.locator(".cv-zoom").innerText()).trim() === "500%",
        await page.locator(".cv-zoom").innerText(),
      );
      await page.getByRole("button", { name: "适应" }).click();
      await sleep(500);

      // 保存：卡片（含粘贴出来的带正文的）、链接节点、反向的连线都进了文件
      await saveBtn.click();
      await page.getByText("已保存").first().waitFor({ timeout: 10000 });
      await sleep(600);
      const gb = (
        await api(
          "GET",
          `/canvas/local/board?${new URLSearchParams({ dir: dir2, name: "手势" })}`,
        )
      ).body;
      // 两条线原本都从第一张卡片出发；反向过的那条现在指向它
      const ends = gb.canvas.edges.flatMap((e) => [e.fromNode, e.toNode]);
      const hub = ends.find((id) => ends.filter((x) => x === id).length === 2);
      const first = gb.canvas.nodes.filter(
        (n) => n.type === "file" && n.file.includes(".cards/"),
      );
      const cards2 = join(dir2, ".canvas", "手势.cards");
      const texts = readdirSync(cards2).map((f) =>
        readFileSync(join(cards2, f), "utf8"),
      );
      check(
        "保存后：粘贴出来的卡片带着正文、链接节点是标准 link 节点、被反向的那条连线指向原来的起点卡片",
        first.length === 5 &&
          texts.filter((t) => t === "复制我").length === 3 &&
          gb.canvas.nodes.some((n) => n.type === "link" && n.url === pageUrl) &&
          gb.canvas.edges.length === 2 &&
          gb.canvas.edges.filter((e) => e.toNode === hub).length === 1 &&
          gb.canvas.edges.filter((e) => e.fromNode === hub).length === 1,
        JSON.stringify([first.length, texts, gb.canvas.edges]),
      );

      // 图片设置变了，图片地址跟着变（浏览器长期缓存的旧缩略图才会作废）
      await page.mouse.move(at(0.1, 0.9).x, at(0.1, 0.9).y);
      await paste([{ name: "image.png", type: "image/png", b64: pngB64 }]);
      await page
        .getByText("已放入 1 个文件")
        .first()
        .waitFor({ timeout: 15000 });
      await sleep(800);
      const revOf = async () =>
        new URL(
          await page
            .locator("img.cv-img[alt^='粘贴-']")
            .first()
            .evaluate((el) => el.src),
        ).searchParams.get("r");
      const r1 = await revOf();
      await putMedia(1);
      await page.reload();
      await page.waitForSelector("img.cv-img[alt^='粘贴-']", {
        timeout: 15000,
      });
      const r2 = await revOf();
      await putMedia(8);
      check(
        "改了图片设置再打开，图片地址里的版本跟着变",
        !!r1 && !!r2 && r1 !== r2,
        JSON.stringify([r1, r2]),
      );

      // 引用目录之外 / 别的主机上的文件：节点是 host + 绝对路径；这里没有第二台主机，用本机（host = local）的目录之外的文件
      // 与一个不存在的主机代替——读取、渲染、打开预览、未连接态、索引都走同一套
      const outsideMd = join(work, "outside-notes.md");
      writeFileSync(outsideMd, "# 目录之外的笔记\n\n正文一行\n");
      writeFileSync(join(work, "outside-pic.png"), png(320, 200));
      const fm = page.locator(".ws-pane", {
        has: page.locator(".ws-pn-tab[data-type='files']"),
      });
      await fm.getByLabel("上一级").click();
      await sleep(900);
      const dropFm = async (name, x, y) => {
        const row = fm.locator(`.ws-fm-row[data-name='${name}'] .u-lrow-main`);
        await row.waitFor({ timeout: 8000 });
        const rb = await row.boundingBox();
        const cb = await page.locator(".cv-flow").boundingBox();
        await page.mouse.move(rb.x + 24, rb.y + rb.height / 2);
        await page.mouse.down();
        await page.mouse.move(rb.x + 40, rb.y + rb.height / 2 + 6, {
          steps: 3,
        });
        await page.mouse.move(cb.x + x, cb.y + y, { steps: 12 });
        await sleep(300);
        await page.mouse.move(cb.x + x + 2, cb.y + y + 2);
        await page.mouse.up();
        await sleep(1800);
      };
      await dropFm("outside-notes.md", 200, 120);
      await dropFm("outside-pic.png", 600, 120);
      const boardNow = async () =>
        (
          await api(
            "GET",
            `/canvas/local/board?${new URLSearchParams({ dir: dir2, name: "手势" })}`,
          )
        ).body;
      const remoteNode = (await boardNow()).canvas.nodes.find(
        (n) => n.file === outsideMd,
      );
      const mdCard = nodes().filter({ hasText: "目录之外的笔记" });
      const picSrc = await page
        .locator("img.cv-img[alt='outside-pic.png']")
        .evaluate((el) => ({
          src: el.src,
          w: el.naturalWidth,
        }))
        .catch(() => null);
      check(
        "把目录之外的文件从文件管理器拖进画布：节点带 host、file 是绝对路径；markdown 渲染预览、图片按那台主机读到并显示；标注是 主机:绝对路径",
        remoteNode?.host === "local" &&
          (await mdCard.count()) === 1 &&
          (await mdCard.locator(".cv-label").innerText()).includes(
            "outside-notes.md",
          ) &&
          picSrc?.src.includes("host=local") &&
          picSrc.w === 320,
        JSON.stringify([remoteNode, picSrc]),
      );

      // 主机不存在（没连上）：卡片显示「主机未连接」，不是「文件缺失」；API 写进去后界面自己刷出来
      const cur = await boardNow();
      cur.canvas.nodes.push({
        id: "ghostnode000000a",
        type: "file",
        file: "/srv/ghost.md",
        host: "ghost-host",
        x: 0,
        y: 400,
        width: 260,
        height: 120,
      });
      const put = await fetch(
        `${origin}/api/v1/canvas/local/board?${new URLSearchParams({
          dir: dir2,
          name: "手势",
          expect_mtime: String(cur.baseline.mtimeMs),
          expect_sha256: cur.baseline.sha256,
        })}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(cur.canvas),
        },
      );
      await page.getByText("主机未连接").first().waitFor({ timeout: 15000 });
      check(
        "引用的主机不在：卡片显示「主机未连接」而不是「文件缺失」",
        put.ok &&
          (await page.getByText("主机未连接").count()) >= 1 &&
          (await page.getByText("文件缺失").count()) === 0,
      );

      // 双击在那台主机上打开预览；索引里写「主机名:绝对路径」，不为远端引用查文件（索引随提交的停顿一起重写，要多等一会儿）
      await mdCard.locator(".cv-box").dblclick();
      await sleep(1500);
      const opened =
        (await page.locator(".ws-pn-tab[data-type='preview']").count()) >= 1;
      await sleep(7000);
      const index = readFileSync(join(dir2, ".canvas", "index.md"), "utf8");
      check(
        "双击远端引用：在预览标签里打开；index.md 里写 local:绝对路径 与 ghost-host:路径",
        opened &&
          index.includes(`local:${outsideMd}`) &&
          index.includes("ghost-host:/srv/ghost.md"),
        JSON.stringify([
          opened,
          index
            .split("\n")
            .filter((l) => l.includes("srv") || l.includes("outside")),
        ]),
      );

      // 13) 笔记与树
      const root2 = join(dir2, ".canvas");
      const noteFile = join(root2, "产品", "用户研究.md");
      const canvasTabs = () =>
        page.locator(".ws-pn-tab[data-type='canvas']").count();
      const previewTabs = () =>
        page.locator(".ws-pn-tab[data-type='preview']").count();
      const waitFor = async (fn, ms = 15000) => {
        for (let t = 0; t < ms; t += 250) {
          if (await fn()) return true;
          await sleep(250);
        }
        return false;
      };
      const row = (id) => page.locator(`.cv-tree [data-tree-id="${id}"]`);
      const rowBtn = (id) => row(id).locator(".u-lrow-main");
      // 窄窗格里树栏是盖在主区上的、选了东西就收起：每步用树之前先确保它是展开的
      // 拖到一半停住：读落点的计算样式（应是 2px 强调色描边 + 极浅蓝底，不是主机色），截图，Esc 取消
      const accentLook = await page.evaluate(() => {
        const d = document.createElement("div");
        d.style.cssText = "color:var(--accent);background:var(--accent-bg)";
        document.body.appendChild(d);
        const c = getComputedStyle(d);
        const r = { accent: c.color, bg: c.backgroundColor };
        d.remove();
        return r;
      });
      const holdDrag = async (src, dst, markOf, shotName, finish) => {
        const sb = await src.boundingBox();
        const db = await dst.boundingBox();
        await page.mouse.move(sb.x + 24, sb.y + sb.height / 2);
        await page.mouse.down();
        await page.mouse.move(sb.x + 40, sb.y + sb.height / 2 + 6, {
          steps: 3,
        });
        await page.mouse.move(db.x + 60, db.y + db.height / 2, { steps: 12 });
        await sleep(400);
        const look = await markOf.evaluate((el) => {
          const c = getComputedStyle(el);
          return {
            outline: c.outlineColor,
            width: c.outlineWidth,
            bg: c.backgroundColor,
          };
        });
        await shot(shotName);
        if (finish) {
          await page.mouse.up();
        } else {
          await page.keyboard.press("Escape");
          await page.mouse.up();
        }
        return (
          look.outline === accentLook.accent &&
          look.width === "2px" &&
          look.bg === accentLook.bg
        );
      };
      const showTree = async () => {
        if ((await page.locator(".cv-tree").count()) === 0)
          await page.getByRole("button", { name: "展开树栏" }).click();
        await page.locator(".cv-tree").waitFor();
      };
      const newFromTree = async (item) => {
        await showTree();
        await page
          .locator(".cv-tree-head")
          .getByRole("button", { name: "新建" })
          .click();
        await page.getByRole("menuitem", { name: item }).click();
      };
      const switchBoard = async (label) => {
        await showTree();
        await rowBtn(`${label}.canvas`).click();
        await sleep(900);
      };
      const previewsBefore = await previewTabs();
      const canvasBefore = await canvasTabs();

      // 先建文件夹，再建笔记（对话框里选位置）
      await newFromTree("新建文件夹");
      const folderName = page.getByLabel("名字", { exact: true });
      await folderName.fill("产品");
      await folderName.press("Enter");
      await showTree();
      await row("产品").waitFor({ timeout: 10000 });
      await newFromTree("新建笔记");
      const dlg = page.getByRole("dialog");
      const rootLoc = await dlg
        .getByRole("combobox")
        .getAttribute("data-value");
      await dlg.getByRole("combobox").click();
      await page.getByRole("option", { name: "产品" }).click();
      const noteInput = page.getByLabel("名字", { exact: true });
      await noteInput.fill("用户研究");
      await noteInput.press("Enter");
      const made = await waitFor(async () => existsSync(noteFile));
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await sleep(500);
      check(
        "树里「新建」→ 新建笔记：对话框是「位置 + 名字」，默认位置是当前画布所在的根；选位置「产品」、名字「用户研究」，建出 .canvas/产品/用户研究.md，在本标签的主区里打开（标题是路径），不开预览标签；树里它所在的文件夹自动展开并高亮",
        rootLoc === "" &&
          made &&
          (await page.locator(".cv-viewname").textContent()) ===
            "产品/用户研究" &&
          (await previewTabs()) === previewsBefore &&
          (await canvasTabs()) === canvasBefore &&
          (await rowBtn("产品/用户研究.md").count()) === 1 &&
          (await row("产品/用户研究.md").getAttribute("aria-selected")) ===
            "true",
        JSON.stringify([
          made,
          await page.locator(".cv-viewname").textContent(),
        ]),
      );

      // 空笔记直接进编辑：写正文与 [[链接]]，Ctrl+S 存盘
      await page
        .locator(".cv-note-edit .cm-content")
        .waitFor({ timeout: 10000 });
      await sleep(300);
      await page.keyboard.type("# 研究\n见 [[手势.canvas]] 与 [[不存在]]");
      await shot("13-note-edit");
      await page.keyboard.press("Control+s");
      const saved = await waitFor(
        () =>
          existsSync(noteFile) &&
          readFileSync(noteFile, "utf8").includes("[[手势.canvas]]"),
      );
      const cleared = await waitFor(
        async () =>
          !(await page.locator(".cv-tail").innerText()).includes("未保存"),
        5000,
      );
      check(
        "空笔记直接进编辑；写完 Ctrl+S：正文写回笔记文件，「未保存」标记消失",
        saved && cleared,
        saved ? "" : "没有写回",
      );

      // 回到画布「手势」，把树里的笔记拖到画布上
      await switchBoard("手势");
      await page.locator(".cv .react-flow").waitFor({ timeout: 10000 });
      const flow = page.locator(".cv-flow");
      await showTree();
      await rowBtn("产品/用户研究.md").dragTo(flow, {
        targetPosition: { x: 420, y: 360 },
      });
      const noteNode = page.locator(".react-flow__node-note");
      await noteNode.first().waitFor({ timeout: 10000 });
      const labelText = await noteNode
        .first()
        .locator(".cv-labtext")
        .innerText();
      check(
        "把树里的笔记拖到画布上：放出笔记节点，上方标「笔记 · 路径」，显示渲染后的正文，标「未保存」直到保存",
        labelText === "笔记 · 产品/用户研究" &&
          (await noteNode.first().innerText()).includes("研究") &&
          (await page.getByText("未保存").count()) >= 1,
        labelText,
      );
      await page.keyboard.press("Control+s");
      await sleep(1200);
      await shot("13-note-on-canvas");

      // 索引（随提交的停顿一起重写）
      await sleep(7000);
      const index2 = readFileSync(join(root2, "index.md"), "utf8");
      check(
        "index.md：## notes 里有这篇笔记，appears-in 是画布、links-to 有 [[手势.canvas]] 与缺失的 [[不存在]]；画布节点是 note 种类",
        index2.includes("## notes") &&
          /产品\/用户研究\.md/.test(index2) &&
          /appears-in: b\d+/.test(index2) &&
          index2.includes("[[手势.canvas]] [[不存在]](missing)") &&
          /note {2}产品\/用户研究\.md/.test(index2),
        index2
          .split("\n")
          .filter((l) => l.includes("用户研究") || l.includes("links-to"))
          .join(" / "),
      );

      // 双击笔记节点：本标签的主区里打开（切到笔记视图），预览态里 [[画布]] 可点，点了切到那块画布，后退回到笔记
      await noteNode
        .first()
        .locator(".cv-box")
        .dblclick({ position: { x: 20, y: 20 } });
      await sleep(600);
      // 双击是原地编辑；这里要的是「在笔记视图里打开」：右键菜单
      await page.keyboard.press("Escape");
      await noteNode.first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "在预览里打开" }).click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await page.locator(".cv-bar").getByText("预览", { exact: true }).click();
      const wikiLink = page.locator(".cv-note-read a[title='手势.canvas']");
      await wikiLink.waitFor({ timeout: 10000 });
      await shot("13-note-read");
      await wikiLink.click();
      await page.locator(".cv .react-flow").waitFor({ timeout: 10000 });
      const onBoard =
        (await page.locator(".cv-viewname").textContent()) === "手势";
      await page.getByRole("button", { name: "后退" }).click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      const backOnNote =
        (await page.locator(".cv-viewname").textContent()) === "产品/用户研究";
      await page.getByRole("button", { name: "前进" }).click();
      await page.locator(".cv .react-flow").waitFor({ timeout: 10000 });
      check(
        "笔记视图（预览）里的 [[手势.canvas]] 是可点的链接：点了切到那块画布；后退回到笔记、前进再回到画布；全程没有多开标签",
        onBoard &&
          backOnNote &&
          (await canvasTabs()) === canvasBefore &&
          (await previewTabs()) === previewsBefore,
        JSON.stringify([onBoard, backOnNote]),
      );

      // 指不到的 [[不存在]]：点了问要不要建（预填路径）
      await showTree();
      await rowBtn("产品/用户研究.md").click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await page.locator(".cv-note-read a[title='不存在']").click();
      const prefilled = await page
        .getByLabel("名字", { exact: true })
        .inputValue();
      const prefilledLoc = await page
        .getByRole("dialog")
        .getByRole("combobox")
        .getAttribute("data-value");
      await page.keyboard.press("Escape");
      check(
        "指不到的 [[不存在]]：点了弹出新建笔记，名字已填好、位置是根",
        prefilled === "不存在" && prefilledLoc === "",
        JSON.stringify([prefilled, prefilledLoc]),
      );
      // 17) 拖拽引用：打开笔记「产品/用户研究」进编辑态，从树里拖「总览」笔记与「手势」画布进来
      // （「总览」笔记引用着「用户研究」，后面的 F2 改名检查要看它里面的链接跟着改）
      const other = await api(
        "POST",
        `/canvas/local/notes?${new URLSearchParams({ dir: dir2 })}`,
        {
          path: "总览",
          text: "见 [[产品/用户研究]]",
        },
      );
      await sleep(1800);

      // 21) Markdown 的渲染：笔记预览、画布卡片、对话共用一份样式（md-prose + t-doc）。这里在笔记预览里量：
      // 无序 / 有序列表的标记要在（以前预览里不显示）、标题按层级递减且 h1 明显大于正文、正文是前景色不是灰色、
      // 单个换行渲染成 <br>、任务列表没有圆点
      await api(
        "POST",
        `/canvas/local/notes?${new URLSearchParams({ dir: dir2 })}`,
        {
          path: "格式样例",
          text: "# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n正文第一行\n正文第二行\n\n- 无序项一\n- 无序项二\n\n1. 有序项一\n2. 有序项二\n\n- [x] 已完成\n- [ ] 待办\n\n> 引用\n",
        },
      );
      await sleep(1800);
      await showTree();
      await rowBtn("格式样例.md").click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await page.locator(".cv-bar").getByText("预览", { exact: true }).click();
      await page
        .locator(".cv-note-read .md-prose h1")
        .waitFor({ timeout: 10000 });
      const doc = await page.evaluate(() => {
        const q = (sel) => document.querySelector(`.cv-note-read ${sel}`);
        const cs = (sel) => getComputedStyle(q(sel));
        const px = (sel) => Number.parseFloat(cs(sel).fontSize);
        return {
          ul: cs("ul:not(.contains-task-list) > li").listStyleType,
          ulDisplay: cs("ul:not(.contains-task-list) > li").display,
          ol: cs("ol > li").listStyleType,
          task: cs("li.task-list-item").listStyleType,
          h1: px("h1"),
          h2: px("h2"),
          h3: px("h3"),
          p: px("p"),
          pColor: cs("p").color,
          h1Color: cs("h1").color,
          brs: q("p")?.querySelectorAll("br").length,
          quoteBar: cs("blockquote").borderLeftWidth,
        };
      });
      if (SHOTS)
        await page
          .locator(".cv-note")
          .screenshot({ path: join(SHOTS, "21-note-doc.png") });
      check(
        "Markdown 渲染（笔记预览）：列表有圆点 / 序号（任务列表没有）；标题 h1 > h2 > h3 > 正文且 h1 至少是正文的 1.5 倍；正文是前景色（与标题同色）；单个换行是 <br>；引用有竖条",
        doc.ul === "disc" &&
          doc.ulDisplay === "list-item" &&
          doc.ol === "decimal" &&
          doc.task === "none" &&
          doc.h1 > doc.h2 &&
          doc.h2 > doc.h3 &&
          doc.h3 > doc.p &&
          doc.h1 >= doc.p * 1.5 &&
          doc.pColor === doc.h1Color &&
          doc.brs === 1 &&
          doc.quoteBar === "3px",
        JSON.stringify(doc),
      );
      // 28) 添加到对话：预览里选中一段 → 按钮把它连同来源（主机名:.canvas 里的绝对路径:行号）加进借用会话的输入草稿；agent 收到的是 Quote 块
      await page.evaluate(() => {
        const p = document.querySelector(".cv-note-read p");
        const r = document.createRange();
        r.selectNodeContents(p);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      });
      await page
        .locator(".cv-bar")
        .getByRole("button", { name: "添加到对话" })
        .click();
      const quoted = await page
        .getByText(/已添加到对话/)
        .first()
        .waitFor({ timeout: 5000 })
        .then(
          () => true,
          () => false,
        );
      const chatTab = page.locator(".ws-pn-tab[data-type='chat']").first();
      const canvasTab = page.locator(".ws-pn-tab[data-type='canvas']").first();
      let chip = null;
      if (await chatTab.count()) {
        await chatTab.click();
        await page
          .locator(".ch-qchip")
          .first()
          .waitFor({ timeout: 5000 })
          .catch(() => {});
        chip = await page.evaluate(() => {
          const el = document.querySelector(".ch-qchip");
          return (
            el && { label: el.textContent, text: el.getAttribute("title") }
          );
        });
        await canvasTab.click();
        await page.locator(".cv-note").waitFor({ timeout: 10000 });
      }
      check(
        "笔记「添加到对话」：选中一段 → 提示已添加；对话输入框里多一条引用，来源是 主机名:.canvas 里的笔记路径:行号，内容是选中的那段",
        quoted &&
          chip !== null &&
          chip.label.includes("/.canvas/格式样例.md:L7-L8") &&
          chip.text.includes("正文第一行") &&
          chip.text.includes("正文第二行") &&
          !chip.text.includes("无序项"),
        JSON.stringify({ quoted, chip }),
      );
      await api(
        "DELETE",
        `/canvas/local/note?${new URLSearchParams({ dir: dir2, path: "格式样例.md" })}`,
      );
      await sleep(1200);

      // 26) 笔记里的图片：相对地址相对这篇笔记所在文件夹、走画布接口读（ssh 项目读 Server 本机副本）；读不到的显示占位
      mkdirSync(join(dir2, ".canvas", ".assets", "图文"), { recursive: true });
      writeFileSync(
        join(dir2, ".canvas", ".assets", "图文", "pic.png"),
        png(120, 80),
      );
      await api(
        "POST",
        `/canvas/local/notes?${new URLSearchParams({ dir: dir2 })}`,
        {
          path: "图文",
          text: "![配图](./.assets/图文/pic.png)\n\n![丢了](./.assets/图文/none.png)\n\n![远程](https://example.com/a.png)\n",
        },
      );
      await sleep(1800);
      await showTree();
      await rowBtn("图文.md").click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await page.locator(".cv-bar").getByText("预览", { exact: true }).click();
      await page
        .locator(".cv-note-read .md-img img")
        .waitFor({ timeout: 10000 });
      await page
        .locator(".cv-note-read .md-img-note[data-state='fail']")
        .waitFor({ timeout: 10000 });
      const noteImg = await page.evaluate(() => {
        const img = document.querySelector(".cv-note-read .md-img img");
        const ext = document.querySelector(".cv-note-read a.ws-pv-img-ph");
        return {
          w: img?.naturalWidth,
          h: img?.naturalHeight,
          fail: document.querySelector(
            ".cv-note-read .md-img-note[data-state='fail']",
          )?.textContent,
          ext: ext?.getAttribute("href"),
          imgs: document.querySelectorAll(".cv-note-read img").length,
        };
      });
      if (SHOTS)
        await page
          .locator(".cv-note")
          .screenshot({ path: join(SHOTS, "26-note-images.png") });
      check(
        "笔记里的图片：相对笔记的图显示出来（120×80）、读不到的是占位、外链不加载只是可点的占位（页面里只有一张 img）",
        noteImg.w === 120 &&
          noteImg.h === 80 &&
          noteImg.fail?.startsWith("[图片：丢了]") &&
          noteImg.ext === "https://example.com/a.png" &&
          noteImg.imgs === 1,
        JSON.stringify(noteImg),
      );
      await api(
        "DELETE",
        `/canvas/local/note?${new URLSearchParams({ dir: dir2, path: "图文.md" })}`,
      );
      await sleep(1200);

      // 27) 往笔记里粘贴 / 拖入图片：存进笔记旁边的 <笔记名>.assets/（画布接口），插入相对笔记的链接；
      // 保存后预览里显示；笔记改名时资源夹跟着改名、正文里的链接改到新名、图片仍然显示；删除笔记连资源夹一起删
      await api(
        "POST",
        `/canvas/local/notes?${new URLSearchParams({ dir: dir2 })}`,
        { path: "产品/配图笔记", text: "开头\n" },
      );
      await sleep(1800);
      await showTree();
      await rowBtn("产品/配图笔记.md").click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await page.locator(".cv-bar").getByText("编辑", { exact: true }).click();
      await page
        .locator(".cv-note-edit .cm-content")
        .waitFor({ timeout: 10000 });
      await sleep(300);
      await page.locator(".cv-note-edit .cm-content").click();
      await page.keyboard.press("Control+End");
      await page.evaluate(
        ([b64]) => {
          const dt = new DataTransfer();
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
          document.querySelector(".cv-note-edit .cm-content").dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        [png(64, 48).toString("base64")],
      );
      await page.waitForFunction(() =>
        /!\[\]\(\.\/\.assets\/配图笔记\/image-\d{8}-\d{6}\.png\)/.test(
          document.querySelector(".cv-note-edit .cm-content").innerText,
        ),
      );
      const assetDir = join(dir2, ".canvas", "产品", ".assets", "配图笔记");
      // 资源夹里还有一个空的 _large/（上传的临时文件放在里面，不进 git）
      const pasted = readdirSync(assetDir).filter((n) => n !== "_large");
      check(
        "笔记里粘贴截图：存进笔记所在文件夹的 .assets/配图笔记/（image-日期时间.png），光标处插入相对笔记的链接（笔记在「产品」文件夹里，链接不带文件夹），笔记标「未保存」",
        pasted.length === 1 &&
          /^image-\d{8}-\d{6}\.png$/.test(pasted[0]) &&
          (await page.locator(".cv-tail").innerText()).includes("未保存"),
        JSON.stringify(pasted),
      );
      await page.keyboard.press("Control+s");
      await page.waitForFunction(
        () =>
          !document.querySelector(".cv-tail")?.textContent?.includes("未保存"),
      );
      await page.locator(".cv-bar").getByText("预览", { exact: true }).click();
      await page
        .locator(".cv-note-read .md-img img")
        .waitFor({ timeout: 10000 });
      const shown = await page.evaluate(() => {
        const i = document.querySelector(".cv-note-read .md-img img");
        return [i.naturalWidth, i.naturalHeight];
      });
      if (SHOTS)
        await page
          .locator(".cv-note")
          .screenshot({ path: join(SHOTS, "27-note-pasted.png") });
      check(
        "保存后切到预览：刚粘贴的图显示出来（64×48）",
        shown[0] === 64 && shown[1] === 48,
        JSON.stringify(shown),
      );

      const renamed = await api(
        "PATCH",
        `/canvas/local/note?${new URLSearchParams({ dir: dir2, path: "产品/配图笔记.md" })}`,
        { to: "产品/新配图" },
      );
      await sleep(1800);
      const newText = readFileSync(
        join(dir2, ".canvas", "产品", "新配图.md"),
        "utf8",
      );
      check(
        "笔记改名：资源夹跟着改名（.assets/新配图），旧的没了；正文里的链接改到新资源夹",
        renamed.body?.path === "产品/新配图.md" &&
          existsSync(
            join(dir2, ".canvas", "产品", ".assets", "新配图", pasted[0]),
          ) &&
          !existsSync(assetDir) &&
          newText.includes(`./.assets/新配图/${pasted[0]}`) &&
          !newText.includes(".assets/配图笔记/"),
        JSON.stringify([renamed, newText]),
      );
      await showTree();
      await rowBtn("产品/新配图.md").click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await page.locator(".cv-bar").getByText("预览", { exact: true }).click();
      await page
        .locator(".cv-note-read .md-img img")
        .waitFor({ timeout: 10000 });
      check(
        "改名后打开笔记：图片仍然显示",
        (await page.evaluate(
          () =>
            document.querySelector(".cv-note-read .md-img img").naturalWidth,
        )) === 64,
      );

      const removedNote = await api(
        "DELETE",
        `/canvas/local/note?${new URLSearchParams({ dir: dir2, path: "产品/新配图.md" })}`,
      );
      await sleep(1200);
      check(
        "删除笔记：它的资源夹一起删，删空了的 .assets/ 也收掉",
        !existsSync(join(dir2, ".canvas", "产品", ".assets")),
        JSON.stringify([
          removedNote,
          existsSync(join(dir2, ".canvas", "产品", ".assets", "新配图"))
            ? readdirSync(join(dir2, ".canvas", "产品", ".assets", "新配图"))
            : null,
        ]),
      );

      await showTree();
      await rowBtn("产品/用户研究.md").click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await page.locator(".cv-bar").getByText("编辑", { exact: true }).click();
      await page
        .locator(".cv-note-edit .cm-content")
        .waitFor({ timeout: 10000 });
      await sleep(300);
      const editBox = page.locator(".cv-note-edit");
      const dropIntoEditor = async (src) => {
        await showTree();
        const sb = await src.boundingBox();
        const eb = await editBox.boundingBox();
        await page.mouse.move(sb.x + 24, sb.y + sb.height / 2);
        await page.mouse.down();
        await page.mouse.move(sb.x + 40, sb.y + sb.height / 2 + 6, {
          steps: 3,
        });
        await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height - 20, {
          steps: 12,
        });
        await sleep(200);
        await page.mouse.up();
        await sleep(400);
      };
      await dropIntoEditor(rowBtn("总览.md"));
      await dropIntoEditor(rowBtn("手势.canvas"));
      const editorText = await page
        .locator(".cv-note-edit .cm-content")
        .innerText();
      check(
        "把树里的笔记「总览」和画布「手势」拖进笔记编辑区：自动写成 [[总览]] 与 [[手势.canvas]]（笔记去掉 .md、画布保留 .canvas），笔记标「未保存」",
        editorText.includes("[[总览]]") &&
          editorText.includes("[[手势.canvas]]") &&
          (await page.locator(".cv-tail").innerText()).includes("未保存"),
        JSON.stringify(editorText.slice(-80)),
      );

      // 文件管理器里的文件拖进来：项目内的写相对当前笔记（.canvas/产品/）的标准链接（图片带 !），
      // 目录之外的（文件管理器在 work 下，那里的 outside-notes.md 不在这个项目里）写 file:主机:绝对路径
      const dragFmInto = async (name) => {
        const row = fm.locator(`.ws-fm-row[data-name='${name}'] .u-lrow-main`);
        await row.waitFor({ timeout: 8000 });
        const rb = await row.boundingBox();
        const eb = await editBox.boundingBox();
        await page.mouse.move(rb.x + 24, rb.y + rb.height / 2);
        await page.mouse.down();
        await page.mouse.move(rb.x + 40, rb.y + rb.height / 2 + 6, {
          steps: 3,
        });
        await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height - 20, {
          steps: 12,
        });
        await sleep(200);
        await page.mouse.up();
        await sleep(400);
      };
      // 文件管理器的当前目录：回到 work（上一级），那里有 outside-notes.md 与 proj2
      // 面包屑每一级都是按钮，而路径里可能还有别的叫 work 的目录（GitHub runner 的工作目录就是 /home/runner/work/…）：
      // 要精确匹配名字，并取最深的那一个，不能用子串匹配加 first()
      const crumbWork = fm.locator(".ws-fm-crumb button", {
        hasText: /^work$/,
      });
      if ((await crumbWork.count()) > 0) {
        await crumbWork.last().click();
        await sleep(800);
      }
      await dragFmInto("outside-notes.md");
      await fm.locator(".ws-fm-row[data-name='proj2']").dblclick();
      await sleep(800);
      await fm.locator(".ws-fm-row[data-name='docs']").dblclick();
      await sleep(800);
      await dragFmInto("intro.md");
      await dragFmInto("pic.png");
      const editorText2 = await page
        .locator(".cv-note-edit .cm-content")
        .innerText();
      check(
        "把文件管理器里的文件拖进笔记编辑区：项目内的 docs/intro.md 与 pic.png 写成相对这篇笔记（.canvas/产品/）的标准链接（图片带 !）；目录之外的 outside-notes.md 写成 file:主机:绝对路径（不写一路 ../ 的相对路径）",
        /\[intro\.md\]\(\.\.\/\.\.\/docs\/intro\.md\)/.test(editorText2) &&
          /!\[pic\.png\]\(\.\.\/\.\.\/docs\/pic\.png\)/.test(editorText2) &&
          /\[outside-notes\.md\]\(file:[^)]*outside-notes\.md\)/.test(
            editorText2,
          ) &&
          !/\.\.\/\.\.\/\.\.\//.test(editorText2),
        JSON.stringify(editorText2.slice(-200)),
      );
      // 文件管理器退回 work：后面的「落点样式」检查还要拖 work 下的 outside-notes.md
      await crumbWork.last().click();
      await sleep(800);
      // 还原，免得后面的步骤带着没保存的改动
      await page
        .locator(".cv-tail")
        .getByRole("button", { name: "还原" })
        .click();
      await sleep(400);

      // 在 产品/ 里的笔记打开着时，新建的默认位置是它所在的文件夹（树里最后选中的是它自己）
      await showTree();
      const treeLoc = async () => {
        await newFromTree("新建笔记");
        const loc = await page
          .getByRole("dialog")
          .getByRole("combobox")
          .getAttribute("data-value");
        await page.keyboard.press("Escape");
        return loc;
      };
      const pickedFirst = await treeLoc();
      await rowBtn("产品/用户研究.md").click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      const inFolderLoc = await treeLoc();
      check(
        "新建的默认位置是当前打开的东西所在的文件夹",
        inFolderLoc === "产品",
        JSON.stringify([pickedFirst, inFolderLoc]),
      );

      // F2 改名：别的笔记里的 [[链接]] 与画布上的节点跟着改（「总览」已在上面的拖拽检查前建好）。
      // 先显式打开这篇笔记（主区在笔记视图里），改名之后主区的标题要跟到新路径
      await showTree();
      await rowBtn("产品/用户研究.md").click();
      await page.locator(".cv-note").waitFor({ timeout: 10000 });
      await page.keyboard.press("F2");
      const rn = page.getByLabel("新名字");
      await rn.fill("访谈");
      await rn.press("Enter");
      const renamedOk = await waitFor(async () =>
        existsSync(join(root2, "产品", "访谈.md")),
      );
      // 打开着的这篇笔记的标题要等服务端确认之后才跟到新路径
      await waitFor(
        async () =>
          (await page.locator(".cv-viewname").textContent()) === "产品/访谈",
        6000,
      );
      const overview = readFileSync(join(root2, "总览.md"), "utf8");
      const boardAfter = await boardNow();
      check(
        "树里 F2 改名：文件改名、别的笔记里的 [[链接]] 跟着改、画布上的笔记节点跟着改、打开的主区跟过去",
        other.status === 201 &&
          renamedOk &&
          overview === "见 [[产品/访谈]]" &&
          boardAfter.canvas.nodes.some((n) => n.file === "产品/访谈.md") &&
          (await page.locator(".cv-viewname").textContent()) === "产品/访谈",
        JSON.stringify([
          overview,
          await page.locator(".cv-viewname").textContent(),
        ]),
      );

      // 18) 乐观更新：把写类请求拖慢 1.5 秒（模拟远程主机），树上改名应当远快于它
      const SLOW_MS = 1500;
      await page.route("**/api/v1/canvas/**", async (route) => {
        if (route.request().method() !== "GET") await sleep(SLOW_MS);
        await route.continue();
      });
      await showTree();
      await rowBtn("产品/访谈.md").click();
      await page.keyboard.press("F2");
      const slowRn = page.getByLabel("新名字");
      await slowRn.fill("访谈二");
      const t0 = Date.now();
      await slowRn.press("Enter");
      await row("产品/访谈二.md").waitFor({ timeout: 4000 });
      const treeMs = Date.now() - t0;
      const inputClosed = (await page.getByLabel("新名字").count()) === 0;
      const stillOnDisk = existsSync(join(root2, "产品", "访谈.md"));
      check(
        "服务端慢（写请求拖 1.5 秒）：树上改名立刻生效（远快于服务端）、输入框立刻收起，此刻磁盘上还没改",
        treeMs < SLOW_MS * 0.6 && inputClosed && stillOnDisk,
        JSON.stringify({ treeMs, inputClosed, stillOnDisk }),
      );
      const landed = await waitFor(
        async () => existsSync(join(root2, "产品", "访谈二.md")),
        8000,
      );
      await sleep(SLOW_MS);
      check(
        "服务端做完后：文件确实改了名，树里只有新名字（没有重复、没有闪回）",
        landed &&
          (await row("产品/访谈二.md").count()) === 1 &&
          (await row("产品/访谈.md").count()) === 0,
        String(landed),
      );
      // 服务端出错：先让「访谈二」的目标已存在（磁盘上直接建一个同名文件，界面不知道），改名应回滚并提示
      writeFileSync(join(root2, "产品", "冲突.md"), "x");
      expectFail = true;
      await rowBtn("产品/访谈二.md").click();
      await page.keyboard.press("F2");
      const failRn = page.getByLabel("新名字");
      await failRn.fill("冲突");
      await failRn.press("Enter");
      await row("产品/冲突.md")
        .first()
        .waitFor({ timeout: 4000 })
        .catch(() => {});
      const optimistic = (await row("产品/访谈二.md").count()) === 0;
      await sleep(SLOW_MS + 1500);
      const rolledBack =
        (await row("产品/访谈二.md").count()) === 1 &&
        existsSync(join(root2, "产品", "访谈二.md"));
      const toastText = await page
        .locator("[role=status], .u-toast")
        .allInnerTexts();
      check(
        "服务端拒绝（目标已存在）：树上先照改，随后回滚到原名，并弹出提示",
        optimistic && rolledBack && toastText.join(" ").includes("同名"),
        JSON.stringify({ optimistic, rolledBack, toastText }),
      );
      expectFail = false;
      await page.unroute("**/api/v1/canvas/**");
      rmSync(join(root2, "产品", "冲突.md"), { force: true });
      // 改回「访谈」，让后面依赖这个名字的检查照旧
      await showTree();
      await rowBtn("产品/访谈二.md").click();
      await page.keyboard.press("F2");
      const backRn = page.getByLabel("新名字");
      await backRn.fill("访谈");
      await backRn.press("Enter");
      await waitFor(
        async () => existsSync(join(root2, "产品", "访谈.md")),
        8000,
      );
      await sleep(1200);

      // 新建文件夹 + 拖拽移动：笔记拖进文件夹，链接与节点再跟一次
      await newFromTree("新建文件夹");
      await page.getByLabel("名字", { exact: true }).fill("归档");
      // 默认位置是当前打开的笔记所在的文件夹；这里要建在根上，改位置
      await page.getByRole("dialog").getByRole("combobox").click();
      await page.getByRole("option", { name: "根目录" }).click();
      await page.getByLabel("名字", { exact: true }).press("Enter");
      await showTree();
      await row("归档").waitFor({ timeout: 10000 });
      const treeLookOk = await holdDrag(
        rowBtn("产品/访谈.md"),
        rowBtn("归档"),
        row("归档").locator(".u-lrow"),
        "13-tree-drop",
        true,
      );
      const moved = await waitFor(async () =>
        existsSync(join(root2, "归档", "访谈.md")),
      );
      await sleep(800);
      const overview2 = readFileSync(join(root2, "总览.md"), "utf8");
      // 文件管理器：把一个文件拖到文件夹行上，同样的落点样式
      const fmLookOk = await holdDrag(
        fm.locator(".ws-fm-row[data-name='outside-notes.md'] .u-lrow-main"),
        fm.locator(".ws-fm-row[data-name='proj'] .u-lrow-main"),
        fm.locator(".ws-fm-row[data-name='proj']"),
        "13-fm-drop",
        false,
      );
      check(
        "拖拽落点（树里的文件夹行、文件管理器里的文件夹行）：2px 强调色描边 + 极浅蓝底，不是主机色",
        treeLookOk && fmLookOk,
        JSON.stringify({ treeLookOk, fmLookOk, accentLook }),
      );
      check(
        "新建文件夹后，把笔记从树里拖进去：文件挪走、[[链接]] 与画布节点跟着改、目标文件夹展开；拖到空白处挪回根",
        moved &&
          overview2 === "见 [[归档/访谈]]" &&
          (await boardNow()).canvas.nodes.some(
            (n) => n.file === "归档/访谈.md",
          ) &&
          (await row("归档/访谈.md").count()) === 1,
        JSON.stringify([moved, overview2]),
      );
      await showTree();
      await rowBtn("归档/访谈.md").dragTo(page.locator(".cv-tree-body"), {
        targetPosition: { x: 120, y: 500 },
      });
      const movedBack = await waitFor(async () =>
        existsSync(join(root2, "访谈.md")),
      );
      check(
        "拖到树的空白处：挪到根",
        movedBack && !existsSync(join(root2, "归档", "访谈.md")),
      );

      // 删除：先确认，写明被谁引用；确认后文件、画布上的节点都没了
      await showTree();
      await row("访谈.md").click({ button: "right" });
      await page.getByRole("menuitem", { name: "删除" }).click();
      const dialog = page.locator("[role=dialog]");
      await dialog.waitFor({ timeout: 10000 });
      const warned = await dialog.innerText();
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const removed = await waitFor(
        async () => !existsSync(join(root2, "访谈.md")),
      );
      await sleep(800);
      check(
        "树里右键删除：先弹确认，写明有几块画布放着它、几篇笔记的 [[链接]] 指向它；确认后文件与画布上的节点都没了",
        /1 块画布放着它/.test(warned) &&
          /1 篇笔记/.test(warned) &&
          removed &&
          !(await boardNow()).canvas.nodes.some((n) =>
            /访谈/.test(String(n.file)),
          ),
        warned.replace(/\s+/g, " ").slice(0, 160),
      );

      // 14) 树栏模式
      await showTree();
      const sideW = () =>
        page
          .locator(".cv-side")
          .evaluate((el) => el.getBoundingClientRect().width);
      const mainW = () =>
        page
          .locator(".cv-main")
          .evaluate((el) => el.getBoundingClientRect().width);
      const pinBtn = () =>
        page
          .locator(".cv-tree-head")
          .getByRole("button", { name: /悬浮|固定在侧边/ });
      const sideW0 = await sideW();
      const mainFixed = await mainW();
      const gripBox = await page.locator(".cv-side-grip").boundingBox();
      await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + 300);
      await page.mouse.down();
      await page.mouse.move(
        gripBox.x + gripBox.width / 2 + 100,
        gripBox.y + 300,
        {
          steps: 6,
        },
      );
      await page.mouse.up();
      await sleep(300);
      const sideW1 = await sideW();
      const stored = JSON.parse(
        await page.evaluate(() => localStorage.getItem("ys.canvas.tree")),
      );
      check(
        "固定模式：拖树栏右边缘调宽（默认 240），宽度记在浏览器里",
        Math.abs(sideW0 - 240) < 2 &&
          sideW1 > sideW0 + 80 &&
          stored.width === Math.round(sideW1) &&
          stored.mode === "fixed",
        JSON.stringify([sideW0, sideW1, stored]),
      );

      // 窄栏永久驻留：固定着的树栏旁边也有它，底色与展开的树栏一样（白），树栏紧贴在它右边
      const railFixed = await page.locator(".cv-rail").boundingBox();
      const sideFixed = await page.locator(".cv-side").boundingBox();
      const colors = await page.evaluate(() => ({
        rail: getComputedStyle(document.querySelector(".cv-rail"))
          .backgroundColor,
        side: getComputedStyle(document.querySelector(".cv-side"))
          .backgroundColor,
        railLine: getComputedStyle(document.querySelector(".cv-rail"))
          .borderRightColor,
      }));
      check(
        "窄栏永久驻留：树栏固定着时它也在（40px），树栏紧贴在它右边、中间不画线（连成一体）；底色与展开的树栏一样（白）；工具条上没有侧栏开关",
        Math.abs(railFixed.width - 40) < 1 &&
          Math.abs(sideFixed.x - (railFixed.x + railFixed.width)) < 1 &&
          colors.rail === colors.side &&
          colors.railLine === "rgba(0, 0, 0, 0)" &&
          (await page.locator('.cv-bar [aria-label$="侧栏"]').count()) === 0,
        JSON.stringify([railFixed.width, sideFixed.x, railFixed.x, colors]),
      );
      await shot("14-rail-fixed");

      await pinBtn().click();
      await sleep(400);
      const mainFloat = await mainW();
      const railBox = await page.locator(".cv-rail").boundingBox();
      check(
        "改为悬浮：树栏不再占位（主区变宽），窄栏还在原处（40px）",
        (await page.locator(".cv-side").count()) === 0 &&
          (await page.locator(".cv-rail").count()) === 1 &&
          Math.abs(railBox.width - 40) < 1 &&
          Math.abs(railBox.x - railFixed.x) < 1 &&
          mainFloat > mainFixed + 80,
        JSON.stringify([mainFixed, mainFloat, railBox.width]),
      );
      await shot("14-rail");

      const edge = railBox;
      const farX = edge.x + 800;
      await page.mouse.move(edge.x + 20, edge.y + 300);
      await sleep(80);
      const hoverOpened =
        (await page.locator(".cv-side[data-float]").count()) === 1;
      const sideBox = await page.locator(".cv-side").boundingBox();
      const attached =
        Math.abs(sideBox.x - (railBox.x + railBox.width)) < 1 &&
        Math.abs(sideBox.y - railBox.y) < 1;
      await shot("14-float-open");
      // 阴影只在右边：左边紧挨窄栏的几列像素与窄栏本色一样（没有被阴影压暗），右边紧贴处比远处暗；
      // 窄栏右边那条线在树栏展开时也没了（连成一体）
      await sleep(400);
      const meanAt = async (x, y, w, h) => {
        const buf = await page.screenshot({
          clip: { x, y, width: w, height: h },
        });
        return page.evaluate(async (b64) => {
          const img = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${b64}`)).blob(),
          );
          const g = new OffscreenCanvas(img.width, img.height).getContext("2d");
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, img.width, img.height).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4)
            sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
          return sum / (d.length / 4);
        }, buf.toString("base64"));
      };
      const py = sideBox.y + 500;
      const railPx = await meanAt(railBox.x + 8, py, 8, 12);
      const leftPx = await meanAt(sideBox.x - 6, py, 5, 12);
      const nearR = await meanAt(sideBox.x + sideBox.width + 2, py, 6, 12);
      const farR = await meanAt(sideBox.x + sideBox.width + 140, py, 6, 12);
      const railLineOpen = await page.evaluate(
        () =>
          getComputedStyle(document.querySelector(".cv-rail")).borderRightColor,
      );
      check(
        "悬浮的树栏：左边没有阴影（紧挨窄栏处与窄栏本色一样）、窄栏与树栏之间不画线，阴影只留右边（紧贴处比远处暗）",
        Math.abs(leftPx - railPx) < 1.5 &&
          nearR < farR - 2 &&
          railLineOpen === "rgba(0, 0, 0, 0)",
        JSON.stringify([railPx, leftPx, nearR, farR, railLineOpen]),
      );
      await page.mouse.move(farX, edge.y + 300);
      await sleep(800);
      const hoverClosed = (await page.locator(".cv-side").count()) === 0;
      check(
        "悬浮：鼠标一移到窄栏上（不到 0.1 秒）就展开成浮层（贴在窄栏右边、从顶上开始），移开后收回",
        hoverOpened && attached && hoverClosed,
        JSON.stringify([hoverOpened, attached, hoverClosed]),
      );

      // 忙着不收：右键开了菜单，鼠标移走也不收；关掉菜单、鼠标仍在外面才收
      await page.mouse.move(edge.x + 20, edge.y + 300);
      await sleep(450);
      await rowBtn("手势.canvas").click({ button: "right" });
      await page.getByRole("menu").waitFor({ timeout: 5000 });
      await page.mouse.move(farX, edge.y + 600);
      await sleep(800);
      const busyStays =
        (await page.locator(".cv-side[data-float]").count()) === 1 &&
        (await page.getByRole("menu").count()) === 1;
      await page.keyboard.press("Escape");
      await sleep(800);
      const busyThenClosed = (await page.locator(".cv-side").count()) === 0;
      check(
        "悬浮时树栏里开着菜单：鼠标移到外面也不收；菜单关了之后才收回",
        busyStays && busyThenClosed,
        JSON.stringify([busyStays, busyThenClosed]),
      );

      // 点窄栏上的树按钮手动展开：鼠标离开不收；再点、Esc、点别处才收
      await page.getByRole("button", { name: "展开树栏" }).click();
      await sleep(300);
      await page.mouse.move(farX, edge.y + 600);
      await sleep(800);
      const manualStays =
        (await page.locator(".cv-side[data-float]").count()) === 1;
      await page.keyboard.press("Escape");
      await sleep(300);
      const escClosed = (await page.locator(".cv-side").count()) === 0;
      await page.getByRole("button", { name: "展开树栏" }).click();
      await sleep(300);
      await page.getByRole("button", { name: "收起树栏" }).click();
      await sleep(300);
      const toggledClosed = (await page.locator(".cv-side").count()) === 0;
      // 先悬停展开、再点按钮：改成手动展开（留着），鼠标离开不收
      await page.mouse.move(edge.x + 20, edge.y + 300);
      await sleep(450);
      await page.getByRole("button", { name: "展开树栏" }).click();
      await page.mouse.move(farX, edge.y + 600);
      await sleep(800);
      const hoverThenClick =
        (await page.locator(".cv-side[data-float]").count()) === 1 &&
        (await page.getByRole("button", { name: "收起树栏" }).count()) === 1;
      await page.keyboard.press("Escape");
      await sleep(300);
      check(
        "手动点窄栏上的树按钮展开的悬浮树栏：鼠标离开不收；Esc 或再点按钮才收；先悬停再点也是留着",
        manualStays && escClosed && toggledClosed && hoverThenClick,
        JSON.stringify([manualStays, escClosed, toggledClosed, hoverThenClick]),
      );

      // 快捷新建：窄栏上的「新建笔记 / 新建画布」直接弹出「位置 + 名字」确认框，位置按树里选中的优先，
      // 其次是主区打开的东西所在的文件夹，都没有就是根
      const quickLoc = async (name) => {
        await page.getByRole("button", { name }).click();
        const loc = await page
          .getByRole("dialog")
          .getByRole("combobox")
          .getAttribute("data-value");
        await page.keyboard.press("Escape");
        await sleep(300);
        return loc;
      };
      await page.mouse.move(edge.x + 20, edge.y + 300);
      await sleep(450);
      const folderId = await page
        .locator('.u-tree-row[data-kind="folder"]')
        .first()
        .getAttribute("data-tree-id");
      await page
        .locator(`.u-tree-row[data-tree-id="${folderId}"] .u-lrow-main`)
        .click();
      await page.mouse.move(farX, edge.y + 600);
      await sleep(800);
      const closedAfterPick = (await page.locator(".cv-side").count()) === 0;
      const locPicked = await quickLoc("新建笔记");
      const locPickedBoard = await quickLoc("新建画布");
      // 树收起期间选中的行由标签记着：再展开时它还是选中的，头上的「新建」菜单也以它为准
      await page.mouse.move(edge.x + 20, edge.y + 300);
      await sleep(450);
      const stillSelected =
        (await page
          .locator(`.u-tree-row[data-tree-id="${folderId}"]`)
          .getAttribute("aria-selected")) === "true";
      await page
        .locator(".cv-tree-head")
        .getByRole("button", { name: "新建" })
        .click();
      await page.getByRole("menuitem", { name: "新建画布" }).click();
      const locMenu = await page
        .getByRole("dialog")
        .getByRole("combobox")
        .getAttribute("data-value");
      await page.keyboard.press("Escape");
      await sleep(300);
      // 点一张在根目录的画布（主区换成它）：选中作废，位置回到按打开的东西算 = 根
      await rowBtn("手势.canvas").click();
      await sleep(900);
      await page.mouse.move(farX, edge.y + 600);
      await sleep(800);
      const locRoot = await quickLoc("新建笔记");
      check(
        "快捷新建：树里选了文件夹 → 位置是它（树收起后仍记着，再展开仍选中，头上的「新建」菜单同口径）；主区换了东西后回到按打开的东西算，根目录下的画布 → 根",
        !!folderId &&
          closedAfterPick &&
          locPicked === folderId &&
          locPickedBoard === folderId &&
          stillSelected &&
          locMenu === folderId &&
          locRoot === "",
        JSON.stringify([
          folderId,
          closedAfterPick,
          locPicked,
          locPickedBoard,
          stillSelected,
          locMenu,
          locRoot,
        ]),
      );

      // 全部展开 / 全部折叠：一个按钮来回切换；展开状态在树栏收起再展开之后还在
      const foldBtn = () =>
        page
          .locator(".cv-tree-head")
          .getByRole("button", { name: /^全部(折叠|展开)$/ });
      const folderRows = () => page.locator('.u-tree-row[data-kind="folder"]');
      const countOpen = () =>
        folderRows().evaluateAll(
          (els) =>
            els.filter((e) => e.getAttribute("aria-expanded") === "true")
              .length,
        );
      const hoverOpen = async () => {
        await page.mouse.move(edge.x + 20, edge.y + 300);
        await page.locator(".cv-tree").waitFor();
      };
      await hoverOpen();
      if ((await foldBtn().getAttribute("aria-label")) === "全部折叠")
        await foldBtn().click();
      const collapsedFirst = (await countOpen()) === 0;
      const labelWhenCollapsed = await foldBtn().getAttribute("aria-label");
      await foldBtn().click();
      const expandedAll = await folderRows().evaluateAll(
        (els) =>
          els.length >= 2 &&
          els.every((e) => e.getAttribute("aria-expanded") === "true"),
      );
      const labelWhenExpanded = await foldBtn().getAttribute("aria-label");
      await foldBtn().click();
      const collapsedAgain = (await countOpen()) === 0;
      check(
        "全部展开 / 全部折叠是一个按钮：全折叠时叫「全部展开」，点了所有文件夹（含嵌套的）都展开、按钮变成「全部折叠」，再点又全部折叠",
        collapsedFirst &&
          labelWhenCollapsed === "全部展开" &&
          expandedAll &&
          labelWhenExpanded === "全部折叠" &&
          collapsedAgain,
        JSON.stringify([
          collapsedFirst,
          labelWhenCollapsed,
          expandedAll,
          labelWhenExpanded,
          collapsedAgain,
        ]),
      );
      // 手动展开一个文件夹，把悬浮树栏收起再展开：展开的状态还在（树组件被卸载过）
      const treeOpenId = await folderRows()
        .first()
        .getAttribute("data-tree-id");
      await folderRows().first().locator(".u-lrow-main").click();
      await sleep(200);
      await page.mouse.move(farX, edge.y + 600);
      await sleep(800);
      const closedNow = (await page.locator(".cv-side").count()) === 0;
      await hoverOpen();
      const stillOpen =
        (await page
          .locator(`.u-tree-row[data-tree-id="${treeOpenId}"]`)
          .getAttribute("aria-expanded")) === "true";
      check(
        "悬浮树栏收起（组件卸载）再展开：展开着的文件夹还是展开的",
        closedNow && stillOpen,
        JSON.stringify([closedNow, stillOpen, treeOpenId]),
      );
      await page.mouse.move(farX, edge.y + 600);
      await sleep(800);

      // 固定回去：宽度还是拖过的那个
      await page.mouse.move(edge.x + 20, edge.y + 300);
      await sleep(450);
      await pinBtn().click();
      await sleep(400);
      const backFixed = await sideW();
      check(
        "固定在侧边：树栏回来占位，宽度还是拖过的那个",
        (await page.locator(".cv-side:not([data-float])").count()) === 1 &&
          Math.abs(backFixed - sideW1) < 2,
        JSON.stringify([backFixed, sideW1]),
      );
      // 固定着时点窄栏上的树按钮 = 收起（改成悬浮，窄栏还在）
      await page.getByRole("button", { name: "收起树栏" }).click();
      await sleep(400);
      check(
        "固定着的树栏：点窄栏上的树按钮就收起成悬浮（树栏不再占位，窄栏还在，偏好记成悬浮）",
        (await page.locator(".cv-side").count()) === 0 &&
          (await page.locator(".cv-rail").count()) === 1 &&
          JSON.parse(
            await page.evaluate(() => localStorage.getItem("ys.canvas.tree")),
          ).mode === "float",
      );

      // 25) 标签页面状态：同一窗格里的两个画布标签各看各的，切走再切回、刷新页面之后还在原来的页面
      // （以前同一个目录的画布标签共用一个 store、浏览历史又只存在组件里：切走再回来就回到第一块画布）
      {
        const cvPane = () =>
          page.locator(".ws-pane", { has: page.locator(".cv") });
        const cvTabs = () =>
          cvPane().locator('.ws-pn-tab[data-type="canvas"] .ws-pn-tab-btn');
        const viewName = async () =>
          (await page.locator(".cv-viewname").textContent()) ?? "";
        await showTree();
        await rowBtn("总览.md").click();
        await page.locator(".cv-note").waitFor({ timeout: 10000 });
        const firstView = await viewName();
        await cvPane().getByRole("button", { name: "新建标签页" }).click();
        await page.getByRole("menuitem", { name: /画布/ }).click();
        await sleep(300);
        const hostItem = page.getByRole("menuitem").first();
        if ((await hostItem.count()) > 0) await hostItem.click();
        await page.locator(".cv-bar").waitFor({ timeout: 10000 });
        await sleep(800);
        const twoTabs = (await cvTabs().count()) === 2;
        const secondView = await viewName();
        const secondIsBoard =
          (await page.locator(".cv .react-flow").count()) === 1;
        await cvTabs().nth(0).click();
        await page.locator(".cv-note").waitFor({ timeout: 10000 });
        const backFirst = await viewName();
        await cvTabs().nth(1).click();
        await page.locator(".cv .react-flow").waitFor({ timeout: 10000 });
        const backSecond = await viewName();
        check(
          "同一窗格开两个画布标签：一个在笔记、一个在画布，来回切换各回到自己原来的页面（不会都回到第一块画布）",
          firstView === "总览" &&
            twoTabs &&
            secondIsBoard &&
            backFirst === "总览" &&
            backSecond === secondView,
          JSON.stringify({
            firstView,
            twoTabs,
            secondView,
            backFirst,
            backSecond,
          }),
        );
        // 刷新页面：浏览历史存在标签记录里（随布局保存），第一个标签仍在笔记
        await sleep(1500);
        await cvTabs().nth(0).click();
        await page.locator(".cv-note").waitFor({ timeout: 10000 });
        await sleep(1500);
        await page.reload();
        await page.waitForSelector(".cv-bar");
        await sleep(1200);
        const afterReload = await viewName();
        check(
          "刷新页面：画布标签的浏览历史也还原（笔记标签刷新后仍是那篇笔记，不回到第一块画布）",
          afterReload === "总览" &&
            (await page.locator(".cv-note").count()) === 1,
          afterReload,
        );
        // 收拾：关掉多开的那个标签，别影响后面的步骤
        await cvPane()
          .locator('.ws-pn-tab[data-type="canvas"]')
          .nth(1)
          .getByRole("button", { name: /关闭/ })
          .click()
          .catch(() => {});
        await sleep(500);
      }

      // 19) 远端同步提示：服务端回报没推完 / 离线 / 有另存时工具条露出来，平时（本机环境）没有
      let mirror = {
        state: "offline",
        pending: 2,
        error: "connection lost",
        asides: [],
      };
      await page.route("**/api/v1/canvas/*/mirror*", (route) =>
        route.fulfill({ json: { mirror } }),
      );
      // 展开状态存在浏览器里：刷新页面之后还原
      const savedOpen = await page.evaluate(
        (k) => {
          const raw = localStorage.getItem(k);
          return raw ? JSON.parse(raw).open : null;
        },
        `ys.canvas.treeview:local:${encodeURIComponent(dir2)}`,
      );
      await page.reload();
      await page.waitForSelector(".cv-bar");
      await page.locator(".cv-rail").waitFor();
      {
        const rb = await page.locator(".cv-rail").boundingBox();
        await page.mouse.move(rb.x + 20, rb.y + 300);
      }
      await page.locator(".cv-tree").waitFor();
      const restored = await page.evaluate(
        (ids) =>
          ids.every(
            (id) =>
              document
                .querySelector(`.u-tree-row[data-tree-id="${CSS.escape(id)}"]`)
                ?.getAttribute("aria-expanded") === "true",
          ),
        savedOpen ?? [],
      );
      check(
        "刷新页面：树里展开的文件夹存在浏览器里，回来仍是展开的",
        Array.isArray(savedOpen) && savedOpen.includes(treeOpenId) && restored,
        JSON.stringify([savedOpen, treeOpenId, restored]),
      );
      await page.mouse.move(2000, 600);
      await sleep(800);
      const sync = () => page.locator(".cv-bar .cv-save", { hasText: "远端" });
      await sync().first().waitFor({ timeout: 8000 });
      const offlineTip = await sync().first().getAttribute("title");
      check(
        "远端离线：工具条标「远端未同步」，悬停写明原因与待推送数",
        (await sync().first().textContent())?.includes("远端未同步") &&
          offlineTip?.includes("connection lost") &&
          offlineTip?.includes("2 项"),
        offlineTip ?? "",
      );
      if (SHOTS)
        await page
          .locator(".cv-bar")
          .screenshot({ path: join(SHOTS, "19-sync.png") });
      mirror = {
        state: "synced",
        pending: 0,
        asides: ["/p/.canvas/a.remote-1.md"],
      };
      await sleep(3600);
      check(
        "远端文件被外部改过：标「远端有 1 份改动已另存」，悬停列出另存的路径",
        (await sync().first().textContent())?.includes("已另存") &&
          (await sync().first().getAttribute("title"))?.includes(
            "a.remote-1.md",
          ),
      );
      mirror = { state: "synced", pending: 0, asides: [] };
      await sleep(3600);
      check("推完且没有另存：提示消失", (await sync().count()) === 0);
      await page.unroute("**/api/v1/canvas/*/mirror*");
      web.close();
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

// 预期的 404：第 26 段故意放了一张读不到的图（none.png）；第 21 / 26 / 27 段用接口删掉了正开着的笔记，
// 笔记视图收到变更重读时读不到（显示「笔记不存在」），以及浏览器随之打的控制台行
const uniq = [...new Set(problems)].filter(
  (p) =>
    p !== "404 GET /api/v1/canvas/local/image" &&
    p !== "404 GET /api/v1/canvas/local/card" &&
    !p.includes("status of 404 (Not Found)"),
);
check(
  "全程没有控制台报错与失败的接口请求（预期的 404 除外：读不到的图、被删掉的笔记重读）",
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
    : `\nPASS  灵感画布：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
