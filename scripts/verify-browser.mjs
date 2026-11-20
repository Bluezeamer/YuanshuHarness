// 浏览器全链路的真机检查：真 Chromium + 本地假站点，经真代理（`server:<端口>` 虚拟主机名）
// 走完 agent 工具与用户接管的主路径，并核对页面生命周期。进程内直接用构建产物里的模块，不起 Server、不用模型。
//  1) 打开服务 / 本地文件，快照里有元素编号；点击、输入、按键后拿到变化；
//  2) 截图是 JPEG，控制台能读到页面里的报错与失败请求；
//  3) 代理拒绝元数据地址与敏感文件，工具给出可读的原因；
//  4) 用户接管：手动操作期间 agent 动不了，交还后恢复；接管提问走完；
//  5) 休眠与唤醒：缩略图留档，唤醒后页面内容回来；
//  6) 弹窗继承来源页面的归属；会话归档后只有 agent 页面被关，用户页留着。
// 前提：已构建 server（packages/server/dist）。浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用 playwright-core 装的那份，
//   再没有就由引擎自己下载（需要能下载，镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser.mjs   （SHOW=1 顺带打印每一步工具的返回）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentChromePath } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/server/dist");
const load = (p) => import(join(dist, p));

const guard = setTimeout(() => {
  console.error("verify-browser 超时（180 秒）");
  process.exit(2);
}, 180_000);
guard.unref();

const agentChromeFound = agentChromePath();
if (agentChromeFound) process.env.YUANSHU_BROWSER = agentChromeFound;

const problems = [];
let checks = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (!ok) {
    problems.push(`${name}${detail ? `：${detail}` : ""}`);
    console.error(`✗ ${name}${detail ? `：${detail}` : ""}`);
  } else console.log(`✓ ${name}`);
};
const show = (title, text) => {
  if (process.env.SHOW) console.log(`\n--- ${title} ---\n${text}\n`);
};

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-"));
const site = join(base, "site");
mkdirSync(site, { recursive: true });
mkdirSync(join(base, "data"), { recursive: true });
writeFileSync(
  join(site, "index.html"),
  "<!doctype html><title>文件页</title><h1>本地文件标题</h1><p>来自工作区</p>",
);
// 敏感名单里的路径（.aws）：HTML 会被浏览器渲染，放行的话内容一定出得来，检查才不会空转。
mkdirSync(join(site, ".aws"), { recursive: true });
writeFileSync(
  join(site, ".aws", "creds.html"),
  "<!doctype html><title>x</title><p>SECRET-IN-HTML</p>",
);

// —— 假站点 ——
const pages = {
  "/": `<!doctype html><title>登录页</title><h1>登录 Acme</h1>
    <label>用户名 <input id="u" name="user" aria-label="用户名"></label>
    <button id="go" onclick="document.getElementById('out').textContent='已点击'">登录</button>
    <p id="out">尚未点击</p>
    <a href="/console">控制台页</a> <a href="/popup">弹窗页</a>`,
  "/console": `<!doctype html><title>控制台页</title><h1>控制台</h1>
    <script>console.error("boom-from-page"); fetch("/missing.json");</script>`,
  "/popup": `<!doctype html><title>弹窗页</title>
    <button onclick="window.open('/', '_blank')">开新页</button>`,
};
const fixture = http.createServer((req, res) => {
  const body = pages[req.url?.split("?")[0] ?? "/"];
  if (!body) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nf");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
await new Promise((ok) => fixture.listen(0, "127.0.0.1", ok));
const sitePort = fixture.address().port;

// —— 被测的装配（与 server.ts 同一套）——
const { Engine } = await load("browser/engine/engine.js");
const { BrowserService } = await load("browser/service.js");
const { createCleaner } = await load("browser/agent/clean/index.js");
const { browserTools } = await load("browser/agent/index.js");
const { targetOptions, workspaceReach } = await load("browser/reach.js");
const { openDatabase } = await load("store/db.js");
const { LocalEnv } = await load("env/local.js");

const db = openDatabase(join(base, "data"));
const engine = new Engine({
  dataDir: join(base, "data"),
  log: (m) => process.env.SHOW && console.log(`[engine] ${m}`),
});
const dirs = () => [{ environmentId: "local", path: site }];
const service = new BrowserService({
  dataDir: join(base, "data"),
  db,
  masterKey: Buffer.alloc(32, 7),
  engine,
  proxy: {
    env: (id) => (id === "local" ? new LocalEnv() : null),
    onDeny: ({ code, host }) =>
      process.env.SHOW && console.log(`[proxy deny] ${code} ${host}`),
  },
  cleaner: createCleaner({
    aux: () => null,
    reader: () => null,
    mask: (t) => t,
  }),
  watch: { set() {}, release() {}, onChanged: () => () => {} },
  scope: () => workspaceReach(dirs),
  rootOf: (id) => id,
  isBusy: () => false,
  label: (id) => `会话 ${id}`,
});

const asks = [];
const answers = [];
// 提问等待期间用户做的事（比如点「手动操作」）：在回答之前执行。
let duringAsk = null;
const tools = new Map();
browserTools(
  {
    registry: service.registry,
    cleaner: service.cleaner,
    targetOptions: () =>
      targetOptions(() => [{ id: "local", name: "本机" }], "local", "local"),
    workspaceKey: () => "w1",
    approveOpen: async () => ({ allowed: true }),
    access: service.access,
    ask: async (spec) => {
      asks.push(spec);
      duringAsk?.();
      return answers.shift() ?? { outcome: "answered", optionId: "done" };
    },
    // 下载、上传、展示不在这个脚本的范围（见 verify-browser-downloads / uploads / tools）：只给能跑通装配的替身
    downloads: service.downloads,
    approveDownload: async () => ({ allowed: false, note: "" }),
    saveFile: async ({ name }) => ({
      marker: `[attach_file] ${name}`,
      size: 0,
      sizeText: "0 B",
    }),
    fileMaxBytes: () => 1_000_000,
    resolveUpload: async () => {
      throw new Error("本脚本不测上传");
    },
    approveUpload: async () => ({ allowed: false, note: "" }),
    show: () => 0,
    // 附件区与图片压缩不在这个脚本的范围（见 verify-browser-assets）：存成一行标记、图片原样放行
    saveAsset: async ({ name }) => ({ marker: `[attach_file] ${name}` }),
    mask: (text) => text,
    modelImage: async (bytes, mimeType) => ({
      mimeType,
      data: bytes.toString("base64"),
    }),
  },
  "s1",
)({ registerTool: (t) => tools.set(t.name, t) });

const run = async (name, params = {}) => {
  const r = await tools.get(name).execute("c", params);
  const text = r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  show(`${name} ${JSON.stringify(params)}`, text);
  return { text, content: r.content };
};
const fails = async (name, params) =>
  tools
    .get(name)
    .execute("c", params)
    .then(
      () => null,
      (e) => e.message,
    );

try {
  // 1) 打开服务、快照、点击、输入、按键
  const opened = await run("browser_open", {
    target: `server:${sitePort}/`,
  });
  const pageId = /PAGE ID: (p[a-z0-9]+) · HTTP/.exec(opened.text)?.[1];
  check("打开本机服务", pageId !== undefined, opened.text.slice(0, 120));
  check(
    "快照里有输入框与按钮的编号",
    /e\d+/.test(opened.text) && opened.text.includes("登录"),
  );

  const ref = (label, re) => re.exec(label)?.[1];
  const snap = (await run("browser_snapshot", { pageId })).text;
  const buttonRef =
    ref(snap, /button[^\n]*"登录"[^\n]*\[ref=(e\d+)\]/) ??
    ref(snap, /(e\d+)[^\n]*button[^\n]*登录/);
  const inputRef =
    ref(snap, /textbox[^\n]*\[ref=(e\d+)\]/) ??
    ref(snap, /(e\d+)[^\n]*textbox/);
  check(
    "能从快照取到按钮与输入框的编号",
    Boolean(buttonRef && inputRef),
    snap.slice(0, 300),
  );

  if (buttonRef) {
    const clicked = (await run("browser_click", { pageId, ref: buttonRef }))
      .text;
    check(
      "点击后看到页面变化",
      clicked.includes("ACTION: click") && clicked.includes("已点击"),
      clicked.slice(0, 200),
    );
  }
  if (inputRef) {
    const typed = (
      await run("browser_type", { pageId, ref: inputRef, text: "alice" })
    ).text;
    check("输入后快照带上了值", typed.includes("alice"), typed.slice(0, 200));
  }
  const pressed = (await run("browser_press", { pageId, key: "Tab" })).text;
  check("按键返回快照", pressed.length > 0);

  // 点坐标（视口左上角附近没有可点元素，只验证不报错且有返回）
  const point = (await run("browser_click", { pageId, x: 5, y: 5 })).text;
  check("坐标点击不报错", point.includes("ACTION: click (5,5)"));

  // 2) 截图与控制台
  const shot = await run("browser_screenshot", { pageId });
  const image = shot.content.find((c) => c.type === "image");
  const jpeg = image ? Buffer.from(image.data, "base64") : Buffer.alloc(0);
  check(
    "截图是 JPEG",
    jpeg[0] === 0xff && jpeg[1] === 0xd8,
    `${jpeg.length} 字节`,
  );

  const consolePage = (
    await run("browser_open", { target: `server:${sitePort}/console` })
  ).text;
  const consoleId = /PAGE ID: (p[a-z0-9]+) · HTTP/.exec(consolePage)?.[1];
  await new Promise((r) => setTimeout(r, 500));
  const logs = (await run("browser_console", { pageId: consoleId })).text;
  check(
    "控制台有页面报错",
    logs.includes("boom-from-page"),
    logs.slice(0, 200),
  );
  check("控制台有失败请求", /missing\.json|404/.test(logs), logs.slice(0, 200));

  // 3) 代理的拒绝：元数据地址、敏感文件；本地文件能开
  const meta = await run("browser_open", {
    target: "http://169.254.169.254/latest/meta-data/",
  }).catch((e) => ({ text: e.message }));
  check(
    "元数据地址被拒并说明原因",
    /内网|回环|保留|拒绝|不允许/.test(meta.text),
    meta.text.slice(0, 200),
  );

  const file = (await run("browser_open", { target: join(site, "index.html") }))
    .text;
  check("本地文件能打开", file.includes("本地文件标题"), file.slice(0, 200));
  const secret = await run("browser_open", {
    target: join(site, ".aws", "creds.html"),
  }).catch((e) => ({ text: e.message }));
  check(
    "敏感路径被拒，内容没有泄露",
    !secret.text.includes("SECRET-IN-HTML"),
    secret.text.slice(0, 200),
  );
  check(
    "拒绝原因说得清楚",
    /不允许读取/.test(secret.text),
    secret.text.slice(0, 200),
  );

  // 4) 用户接管与交还
  service.registry.control(pageId, "user");
  const denied = await fails("browser_click", { pageId, x: 5, y: 5 });
  check(
    "手动操作期间 agent 被拒",
    denied?.includes("用户正在操作"),
    String(denied),
  );
  const readOnly = await run("browser_snapshot", { pageId });
  check("手动操作期间只读照常", readOnly.text.length > 0);
  service.registry.control(pageId, "agent");
  const back = await run("browser_click", { pageId, x: 5, y: 5 });
  check("交还后 agent 恢复", back.text.includes("ACTION: click (5,5)"));

  // 接管提问：等待期间用户点了「手动操作」、做完后点「我已操作完成」。
  const epochBefore = service.registry.get(pageId).epoch;
  duringAsk = () => service.registry.control(pageId, "user");
  answers.push({ outcome: "answered", optionId: "done" });
  const handed = await run("browser_handoff", { pageId, reason: "需要登录" });
  duringAsk = null;
  check(
    "接管提问走完并交还",
    handed.text.includes(
      "ACTION: handoff: user finished and returned the page",
    ),
    handed.text.slice(0, 120),
  );
  check("接管卡片带原因", asks.at(-1)?.body?.includes("需要登录"));
  const after = service.registry.get(pageId);
  check(
    "交还后 epoch 加一、页面回到 agent",
    after.epoch === epochBefore + 1 && after.controller === "agent",
    JSON.stringify({ epochBefore, epoch: after.epoch, c: after.controller }),
  );
  check("接管完成后页面不再标记等待接管", after.handoffPending === false);

  // 5) 休眠与唤醒
  await service.registry.sleep(consoleId);
  const slept = service.registry.get(consoleId);
  check("休眠后有缩略图", slept.state === "sleeping" && slept.hasThumb);
  const woke = await service.registry.activate(consoleId);
  check("唤醒后回到激活", woke.state === "active");
  const again = (await run("browser_snapshot", { pageId: consoleId })).text;
  check("唤醒后页面内容回来", again.includes("控制台"), again.slice(0, 120));

  // 6) 弹窗继承归属；会话归档：agent 页面被关，用户页留着
  const popupPage = (
    await run("browser_open", { target: `server:${sitePort}/popup` })
  ).text;
  const popupId = /PAGE ID: (p[a-z0-9]+) · HTTP/.exec(popupPage)?.[1];
  const beforeIds = new Set(service.registry.list("w1").map((p) => p.id));
  const popSnap = (await run("browser_snapshot", { pageId: popupId })).text;
  const popRef =
    /(e\d+)[^\n]*button[^\n]*开新页|button[^\n]*开新页[^\n]*\[ref=(e\d+)\]/.exec(
      popSnap,
    );
  const popBtn = popRef?.[1] ?? popRef?.[2];
  if (popBtn) {
    await run("browser_click", { pageId: popupId, ref: popBtn });
    await new Promise((r) => setTimeout(r, 800));
    const added = service.registry
      .list("w1")
      .filter((p) => !beforeIds.has(p.id));
    check("弹窗登记成新页面", added.length === 1, `新增 ${added.length} 个`);
    check(
      "弹窗继承来源页面的归属",
      Boolean(added[0]?.usedBy.includes("s1")),
      JSON.stringify(added[0]?.usedBy),
    );
  } else check("能从快照取到「开新页」按钮", false, popSnap.slice(0, 300));

  const mine = await service.registry.open({
    workspaceKey: "w1",
    actor: null,
    url: `http://server.localhost:${sitePort}/`,
  });
  await service.releaseSession("s1");
  const left = service.registry.list("w1");
  check(
    "会话归档后 agent 页面被关、用户页留着",
    left.length === 1 && left[0].id === mine.page.id,
    JSON.stringify(left.map((p) => p.id)),
  );
  check("留下的用户页仍是手动操作", left[0]?.controller === "user");
} catch (err) {
  problems.push(`脚本异常：${err instanceof Error ? err.stack : String(err)}`);
  console.error(err);
} finally {
  await service.close().catch(() => {});
  db.close();
  fixture.close();
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${checks} 项检查，${problems.length} 项问题`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(problems.length === 0 ? 0 : 1);
