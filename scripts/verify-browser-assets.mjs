// 浏览器「素材」的真机检查：真实 Server（临时数据目录，真 Chromium 当 agent 的浏览器）+ 假模型（按剧本
// 真的调 browser_open / browser_snapshot / browser_screenshot / browser_assets）+ 本地假站点，不需要真实模型。
//  1) 整屏截图与元素截图都进了会话附件区：JPEG / PNG 魔数、元素截图的宽高与页面里的表格相符；
//  2) browser_assets 先列清单（地址、大小、图片尺寸，占位小图一眼可辨），再按地址存：缓存里的图（有 alt 的、
//     无 alt 的、跨源的）原样存下、字节与站点发出的逐字节相同；清单外的地址走新请求（结果行带 `(new request)`）；
//  3) 假模型收到的工具结果里有图片块（OpenAI 兼容格式把图片放进紧随工具结果的 user 消息），文本里有
//     `[attach_file]` 标记，标记里的路径在磁盘上确实存在；browser_assets 的结果只有文本；
//  4) 文本里的路径经 GET /api/v1/sessions/:id/attachments/content 能取回同样的字节（与粘贴的图片同一个出口）；
//  5) 全程服务端没有报错日志。
// 前提：已构建 server（packages/server/dist）。浏览器取 YUANSHU_BROWSER；没设时用 playwright-core 装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-assets.mjs
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { startFakeModel } from "./lib/fake-model.mjs";
import { agentChromePath } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentChrome = agentChromePath();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(150);
    v = await fn();
  }
  return v;
}

/** 现造一张纯色 PNG（不引依赖）；每张图颜色不同，内容才各不相同。 */
function png(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const off = y * stride; // 每行第一个字节是 filt：0 = None
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const tag = Buffer.from(type, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
    return Buffer.concat([len, tag, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩色
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PNG 的宽高：IHDR 就在签名后的第一块里。 */
const pngSize = (bytes) => ({
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});
const isPng = (b) => b.subarray(1, 4).toString("latin1") === "PNG";
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// —— 假站点：有 alt 的、没 alt 的、16×16 图标、跨源图（另一个端口）、data: 图，外加一张有 caption 的表格 ——
const PICKS = {
  "/pic/with-alt.png": png(320, 240, [200, 40, 40]),
  "/pic/no-alt.png": png(260, 180, [40, 120, 200]),
  "/pic/icon.png": png(16, 16, [10, 10, 10]),
  "/pic/cross.png": png(280, 200, [30, 160, 90]),
  "/pic/data.png": png(220, 220, [120, 60, 200]),
};
// 表格定死尺寸，元素截图截出来的应是它的大小（边框、caption 会多出几十像素，给个容差）。
const TABLE = { width: 600, height: 300 };
const NEAR = (got, want) => Math.abs(got - want) <= 80;

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return server;
};
const serveRaw = (res, bytes) =>
  res
    .writeHead(200, {
      "content-type": "image/png",
      "content-length": bytes.length,
      "cache-control": "no-store",
    })
    .end(bytes);

// 跨源图另起一个端口（同主机不同端口 = 不同源），先起它，主站点的 HTML 里要带它的端口号。
const crossSite = await listen((req, res) => {
  const pic = PICKS[`${(req.url ?? "").split("?")[0]}`];
  if (pic) serveRaw(res, pic);
  else res.writeHead(404).end();
});
const crossPort = crossSite.address().port;

const site = await listen((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const pic = PICKS[url];
  if (pic) return serveRaw(res, pic);
  if (url !== "/") return res.writeHead(404).end();
  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html><meta charset="utf-8"><title>素材站点</title>
      <style>body{margin:0;font:20px sans-serif;background:#fff} img{display:block}</style>
      <h1>素材站点</h1>
      <table id="t" style="width:${TABLE.width}px;height:${TABLE.height}px;border:2px solid #333;border-collapse:collapse">
        <caption>季度报表</caption>
        <tr><th>项目</th><th>金额</th></tr>
        <tr><td>收入</td><td>12800</td></tr>
        <tr><td>成本</td><td>7300</td></tr>
      </table>
      <img alt="柱状图" src="/pic/with-alt.png">
      <img src="/pic/no-alt.png">
      <img src="/pic/icon.png">
      <img alt="跨源图" src="http://server.localhost:${crossPort}/pic/cross.png">
      <img alt="内联图" src="data:image/png;base64,${PICKS["/pic/data.png"].toString("base64")}">`);
});
const sitePort = site.address().port;

// —— 假模型剧本：开页面 → 取原始快照（表格的编号只在原始快照里）→ 整屏截图 → 元素截图 → 存图 ——
const toolTexts = (messages) =>
  messages
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
const pageIdOf = (messages) => {
  for (const t of [...toolTexts(messages)].reverse()) {
    const hit = /PAGE ID: ([a-z0-9]+) · HTTP/.exec(t);
    if (hit) return hit[1];
  }
  return "";
};
const tableRefOf = (messages) => {
  let ref = "";
  for (const t of toolTexts(messages)) {
    const hit = /table(?: "[^"]*")? \[ref=([^\]]+)\]/.exec(t);
    if (hit) ref = hit[1];
  }
  return ref;
};
const SCRIPT = [
  {
    // 先「启动服务」：命令输出里出现这个端口，之后 browser_open 才不用批准
    tools: [
      {
        name: "bash",
        args: { command: `echo "ready on http://localhost:${sitePort}/"` },
      },
    ],
  },
  {
    tools: [{ name: "browser_open", args: { target: `server:${sitePort}/` } }],
  },
  {
    tools: [
      {
        name: "browser_snapshot",
        args: (messages) => ({ pageId: pageIdOf(messages), raw: true }),
      },
    ],
  },
  {
    tools: [
      {
        name: "browser_screenshot",
        args: (messages) => ({ pageId: pageIdOf(messages) }),
      },
    ],
  },
  {
    tools: [
      {
        name: "browser_screenshot",
        args: (messages) => ({
          pageId: pageIdOf(messages),
          ref: tableRefOf(messages),
        }),
      },
    ],
  },
  {
    tools: [
      {
        name: "browser_assets",
        args: (messages) => ({ pageId: pageIdOf(messages) }),
      },
    ],
  },
  {
    // 按清单里的地址存三张；再加一个清单外的（站点自己的 /pic/data.png，页面没引用过它）走新请求
    tools: [
      {
        name: "browser_assets",
        args: (messages) => {
          const list = [...toolTexts(messages)]
            .reverse()
            .find((t) => t.startsWith("ASSETS:"));
          const listed = [
            ...(list ?? "").matchAll(
              /https?:\S+\/pic\/(?:with-alt|no-alt|cross)\.png/g,
            ),
          ].map((m) => m[0]);
          return {
            pageId: pageIdOf(messages),
            urls: [
              ...listed,
              `http://server.localhost:${sitePort}/pic/data.png`,
            ],
          };
        },
      },
    ],
  },
  { text: "素材已留存。" },
];
const fake = await startFakeModel(SCRIPT, { delay: 5 });

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-assets-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(`${work}/proj`, { recursive: true });

const port = 18500 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const logs = [];
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
    stdio: ["ignore", "pipe", "pipe"],
    cwd: work,
    env: {
      ...process.env,
      ...(agentChrome ? { YUANSHU_BROWSER: agentChrome } : {}),
    },
  },
);
proc.stdout.on("data", (b) => logs.push(b.toString()));
proc.stderr.on("data", (b) => logs.push(b.toString()));

const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
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

  // 模型要支持图片输入，工具结果里的图片块才会被序列化出去。
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
        reasoning: false,
        levels: [],
        input: ["text", "image"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  const ws = await api("POST", "/workspaces", {
    name: "素材",
    directories: [{ path: `${work}/proj` }],
  });
  const session = await api("POST", "/sessions", { workspaceId: ws.id });

  const frames = [];
  const sock = new WebSocket(
    `ws://127.0.0.1:${port}/api/v1/sessions/${session.id}/stream`,
    ["yuanshu.v1"],
  );
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = rej;
  });
  sock.onmessage = (e) => {
    const f = JSON.parse(e.data);
    if (f.type !== "ack") frames.push(f);
  };
  sock.send(
    JSON.stringify({
      type: "send_message",
      id: "m1",
      text: "把这一页的图和表格存成素材。",
    }),
  );
  const ended = await until(
    async () => frames.some((f) => f.type === "run.ended"),
    180_000,
  );
  sock.close();
  const failed = frames.find((f) => f.type === "run.failed");
  check(
    "这一轮跑完（run.ended）",
    !!ended,
    failed ? String(failed.data?.message ?? "").slice(0, 200) : "",
  );
  if (!ended) return;

  // —— 附件区：<data-dir>/attachments/<工作区 id>/<日期>/（属主是工作区，不是会话）——
  const attachDir = join(base, "data", "attachments", ws.id);
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  if (existsSync(attachDir)) walk(attachDir);
  const rel = (p) => (p === "" ? "" : p.slice(attachDir.length + 1));
  const byName = (name) => files.filter((f) => f.endsWith(`-${name}`));
  const same = (file, want) =>
    file !== undefined && readFileSync(file).equals(want);

  const screen = byName("screenshot.jpg");
  check(
    "整屏截图进了附件区（JPEG 魔数、日期目录 + 随机前缀）",
    screen.length === 1 &&
      /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-screenshot\.jpg$/.test(rel(screen[0])) &&
      isJpeg(readFileSync(screen[0])),
    rel(screen[0]),
  );

  const elements = files.filter((f) =>
    /\/[0-9a-f]{8}-element-f?\d*e\d+\.png$/.test(f),
  );
  const elementBytes =
    elements.length === 1 ? readFileSync(elements[0]) : Buffer.alloc(24);
  const el = pngSize(elementBytes);
  check(
    "元素截图进了附件区（PNG 魔数、宽高与表格相符）",
    elements.length === 1 &&
      isPng(elementBytes) &&
      NEAR(el.width, TABLE.width) &&
      NEAR(el.height, TABLE.height),
    `${rel(elements[0] ?? "")} ${el.width}×${el.height}`,
  );

  const withAlt = byName("with-alt.png")[0] ?? "";
  const noAlt = byName("no-alt.png")[0] ?? "";
  const cross = byName("cross.png")[0] ?? "";
  const fresh = byName("data.png")[0] ?? "";
  check(
    "有 alt 的图原样存下（逐字节相同）",
    same(withAlt, PICKS["/pic/with-alt.png"]),
    rel(withAlt),
  );
  check("没 alt 的图也存了", same(noAlt, PICKS["/pic/no-alt.png"]), rel(noAlt));
  check("跨源的图也存了", same(cross, PICKS["/pic/cross.png"]), rel(cross));
  check(
    "清单外的地址走新请求存下（页面没引用过它，字节仍与站点发出的相同）",
    same(fresh, PICKS["/pic/data.png"]),
    rel(fresh),
  );
  check(
    "没点名的小图标不会被存",
    byName("icon.png").length === 0,
    files.map(rel).join(","),
  );

  // —— 假模型收到的请求体 ——
  const messages = fake.requests
    .filter((r) => r.main)
    .flatMap((r) => r.body.messages ?? []);
  const toolMsgs = messages
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
  const imageUrls = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const block of m.content)
      if (block?.type === "image_url")
        imageUrls.push(block.image_url?.url ?? "");
  }
  check(
    "假模型收到了图片块（整屏 JPEG + 元素 PNG 各一）",
    imageUrls.some((u) => u.startsWith("data:image/jpeg;base64,")) &&
      imageUrls.some((u) => u.startsWith("data:image/png;base64,")),
    imageUrls.map((u) => u.slice(0, 24)).join(" | "),
  );

  // 标记行是 `[attach_file] attachment:/<日期>/<前缀>-<名字> (mime, 大小)`，取 `/` 之后的相对路径
  const markerPaths = [
    ...new Set(
      toolMsgs.flatMap((t) =>
        [...t.matchAll(/attachment:\/([^\n]+?) \(/g)].map((m) => m[1]),
      ),
    ),
  ];
  check(
    "工具结果文本里带 [attach_file] 标记，路径在磁盘上确实存在",
    markerPaths.length >= 3 &&
      markerPaths.every((p) => existsSync(join(attachDir, p))),
    markerPaths.join(","),
  );

  const listMsg = toolMsgs.find((t) => t.startsWith("ASSETS:")) ?? "";
  check(
    "清单每行有大小与尺寸：16×16 小图标可辨、内联图写成说明而不是整串 data:",
    /image image\/png \d+ B 16×16 .*\/pic\/icon\.png/.test(listMsg) &&
      /alt「内联图」 data:image\/png \(\d+ chars\)/.test(listMsg) &&
      !/data:image\/png;base64/.test(listMsg),
    listMsg.replace(/\n/g, " | ").slice(0, 400),
  );
  const saveMsg = toolMsgs.find((t) => t.startsWith("Saved ")) ?? "";
  const saveLines = saveMsg
    .split("\n")
    .filter((l) => l.includes("[attach_file]"));
  check(
    "保存结果只有文本：头行计数、每个成功项一行 marker、只有清单外那个带 (new request)、没有失败项",
    saveMsg.startsWith("Saved 4 of 4 assets") &&
      saveLines.length === 4 &&
      saveLines.filter((l) => l.includes("(new request)")).length === 1 &&
      !saveMsg.includes("FAILED"),
    saveMsg.replace(/\n/g, " | ").slice(0, 400),
  );

  // —— 文本里的路径经用户同一个出口取回同样的字节 ——
  const readBack = async (p) => {
    const r = await fetch(
      `${origin}/api/v1/sessions/${session.id}/attachments/content?path=${encodeURIComponent(p)}`,
    );
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  };
  const markerFor = (suffix) =>
    markerPaths.find((p) => p.endsWith(suffix)) ?? "";
  const shotMarker = markerFor("screenshot.jpg");
  const shotBack = shotMarker ? await readBack(shotMarker) : null;
  check(
    "截图按文本里的路径能从附件接口取回同样的字节",
    !!shotMarker &&
      isJpeg(shotBack ?? Buffer.alloc(0)) &&
      shotBack?.equals(readFileSync(join(attachDir, shotMarker))) === true,
    shotMarker,
  );
  const imgMarker = markerFor("cross.png");
  const imgBack = imgMarker ? await readBack(imgMarker) : null;
  check(
    "保存下来的图片也能从附件接口取回同样的字节",
    !!imgMarker && imgBack?.equals(PICKS["/pic/cross.png"]) === true,
    imgMarker,
  );
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  proc.kill("SIGTERM");
  await fake.close();
  site.close();
  crossSite.close();
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

const errorLines = logs
  .join("")
  .split("\n")
  .filter((l) => /"level":(50|60)/.test(l));
check(
  "服务端没有报错日志",
  errorLines.length === 0,
  errorLines.slice(0, 3).join(" | ").slice(0, 400),
);
if (crashed)
  console.log(
    `脚本异常：${String(crashed.stack ?? crashed.message)
      .split("\n")
      .slice(0, 6)
      .join(" | ")}`,
  );
const failedCount = results.filter((x) => !x).length + (crashed ? 1 : 0);
console.log(
  `\n浏览器素材：${results.length - failedCount}/${results.length} 项通过`,
);
process.exit(failedCount === 0 ? 0 : 1);
