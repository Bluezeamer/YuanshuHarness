// 浏览器下载的真机检查：真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 假模型（按剧本真的调浏览器工具）
// + 本地假站点，不需要真实模型，也不需要用户那一侧的浏览器：审批卡片直接经会话 WebSocket 作答。
// 接线问题（审批、附件落盘、大小上限、完全允许档有没有传到工具层）单测测不出，这里用真 Server 验。
// 会话一（默认档位，每次审批）：
//  1) 点下载链接 → 弹「允许 agent 下载这个文件？」，写着文件名、来源页面与文件地址，选项只有通过 / 拒绝（没有「记住」）；通过后文件存进本会话附件区，字节与站点发出的逐字节相同，工具结果带 [attach_file]
//  2) 页面 JS 造的 blob 下载同样走卡片、能存
//  3) 拒绝：工具结果说用户没有批准，附件区里没有这个文件
//  4) 来得比宽限晚的下载（页面里 2.5 秒后才触发）：被取消，不进附件区，控制台里有一条「没有对应的 agent 动作」
//  5) 超过设置里的大小上限（临时调成 1 MB）的文件：丢弃并说明「文件太大」
//  6) browser_open 直接打开一个下载地址：走同一条路存下来，新开的空白页被关掉，结果里不给页面编号
//  7) 附件区里恰好是通过的那三个文件，没有 .part 残留
// 会话二（完全允许档）：同样的点击不弹卡片，直接存进附件区。
// 前提：已构建 server（packages/server/dist）。浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用 playwright-core 装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-downloads.mjs
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

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-downloads-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(`${work}/proj`, { recursive: true });

// —— 假站点：四个按钮固定在视口左侧，剧本按坐标点 ——
const BYTES = Buffer.from(
  Array.from({ length: 40_000 }, (_, i) => (i * 7 + 3) & 255),
);
const ZIP = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(200, 120)]);
const BIG = Buffer.alloc(1_500_000, 1);
const PAGE = `<!doctype html><meta charset=utf-8><title>下载站点</title>
<style>.b{position:fixed;left:100px;width:200px;height:60px;display:block;background:#ddd;font:20px sans-serif}</style>
<a class="b" style="top:100px" href="/file.bin">下载文件</a>
<button class="b" style="top:200px" id="blob">造一个 blob</button>
<button class="b" style="top:300px" id="late">稍后下载</button>
<a class="b" style="top:400px" href="/big.bin">下载大文件</a>
<script>
  const save = (href, name) => {
    const a = document.createElement("a");
    a.href = href;
    if (name) a.download = name;
    document.body.appendChild(a);
    a.click();
  };
  document.getElementById("blob").onclick = () =>
    setTimeout(() => save(URL.createObjectURL(new Blob(["blob-content"])), "blob.txt"), 150);
  document.getElementById("late").onclick = () => setTimeout(() => save("/file.bin"), 2500);
</script>`;
const attach = (name) => ({
  "content-type": "application/octet-stream",
  "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
});
const site = http.createServer((req, res) => {
  if (req.url === "/file.bin")
    return res.writeHead(200, attach("报告.bin")).end(BYTES);
  if (req.url === "/big.bin")
    return res.writeHead(200, attach("big.bin")).end(BIG);
  if (req.url === "/dl.zip")
    return res
      .writeHead(200, {
        ...attach("dl.zip"),
        "content-type": "application/zip",
      })
      .end(ZIP);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const sitePort = site.address().port;

// 取上一个工具结果里的页面编号：「PAGE ID: xxxxxx · HTTP …」
const pageIdOf = (messages) => {
  for (const m of [...messages].reverse()) {
    const hit = /PAGE ID: ([a-z0-9]+) · HTTP/.exec(
      JSON.stringify(m.content ?? ""),
    );
    if (hit) return hit[1];
  }
  return "";
};
const onPage = (name, extra = {}) => ({
  name,
  args: (messages) => ({ pageId: pageIdOf(messages), ...extra }),
});
const open = (path) => ({
  name: "browser_open",
  args: { target: `server:${sitePort}${path}` },
});
const clickAt = (y) => onPage("browser_click", { x: 200, y });

const SCRIPT = [
  // 先让命令输出里出现这个端口，之后 browser_open 不用批准
  {
    tools: [
      {
        name: "bash",
        args: { command: `echo "ready on http://localhost:${sitePort}/"` },
      },
    ],
  },
  { tools: [open("/")] }, // 2
  { tools: [clickAt(130)] }, // 3 下载链接：通过
  { tools: [clickAt(230)] }, // 4 blob：通过
  { tools: [clickAt(130)] }, // 5 下载链接：拒绝
  { tools: [clickAt(330)] }, // 6 稍后下载：来不及，取消
  { tools: [{ name: "bash", args: { command: "sleep 3" } }] }, // 7 等它被取消
  { tools: [onPage("browser_console")] }, // 8
  { tools: [clickAt(430)] }, // 9 大文件：通过，但超限
  { tools: [open("/dl.zip")] }, // 10 直接打开下载地址：通过
  { tools: [{ name: "browser_pages", args: {} }] }, // 11
  { text: "做完了。" }, // 12
  // 会话二（完全允许档）
  { tools: [open("/")] },
  { tools: [clickAt(130)] },
  { text: "完全允许档做完了。" },
];
const fake = await startFakeModel(SCRIPT, { delay: 20 });

const port = 18900 + Math.floor(Math.random() * 90);
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
  return { status: r.status, json: text ? JSON.parse(text) : null };
};

/** 在一个会话里发一句话，按顺序答复审批卡片，跑到 run.ended；返回下载卡片、全部帧与结束与否。 */
async function runSession(sessionId, text, decide) {
  const frames = [];
  const cards = [];
  const sock = new WebSocket(
    `ws://127.0.0.1:${port}/api/v1/sessions/${sessionId}/stream`,
    ["yuanshu.v1"],
  );
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = rej;
  });
  let n = 0;
  const send = (type, extra = {}) =>
    sock.send(JSON.stringify({ id: `c${++n}`, type, ...extra }));
  sock.onmessage = (e) => {
    const f = JSON.parse(e.data);
    if (f.type === "ack") return;
    frames.push(f);
    if (f.type !== "prompt.requested" || f.data.source !== "approval") return;
    const isDownload = String(f.data.title).startsWith("允许 agent 下载");
    // 下载卡片按预定顺序答；别的审批（比如 bash）一律通过
    const want = isDownload ? decide[cards.length] : "allow";
    if (isDownload) cards.push(f.data);
    const pick = f.data.options.find((o) => o.id === want) ?? f.data.options[0];
    send("answer_prompt", { promptId: f.data.promptId, optionId: pick.id });
  };
  send("send_message", { text });
  const ended = await until(
    async () => frames.some((f) => f.type === "run.ended"),
    180_000,
  );
  sock.close();
  const failed = frames.find((f) => f.type === "run.failed");
  return { cards, frames, ended: !!ended, failed };
}

/** 假模型最近一次主对话请求里的全部工具结果（按顺序）。 */
const toolResults = () => {
  const main = fake.requests.filter((r) => r.main);
  const messages = main.at(-1)?.body.messages ?? [];
  return messages
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
};

const filesUnder = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
};
// 附件区的文件名原样保留（只换路径分隔符、引号、控制字符），目录部分是日期与随机前缀：「报告.bin」落盘仍叫 报告.bin
// 标记行是 `[attach_file] attachment:/<日期>/<前缀>-<名字> (mime, 大小)`，按路径取回时直接用 `/` 之后的相对路径
const SAVED_REPORT = "报告.bin";
const markerPath = (text, name) =>
  new RegExp(`attachment:/([^\\n]*-${name.replace(".", "\\.")}) \\(`).exec(
    text,
  )?.[1] ?? "";

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
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  // 大小上限沿用设置里的「单个文件上限」：调成 1 MB，让 1.5 MB 的文件超限
  const defaults = (await api("GET", "/defaults")).json;
  const put = await api("PUT", "/defaults", {
    canvasMedia: { ...defaults.canvasMedia, uploadMaxMB: 1 },
  });
  if (put.status !== 200)
    throw new Error(
      `调不了大小上限：${put.status} ${JSON.stringify(put.json)}`,
    );

  const ws = (
    await api("POST", "/workspaces", {
      name: "下载",
      directories: [{ path: `${work}/proj` }],
    })
  ).json;

  // —— 会话一：默认档位，每次审批 ——
  const s1 = (await api("POST", "/sessions", { workspaceId: ws.id })).json;
  const r1 = await runSession(s1.id, "把页面上的文件下载下来。", [
    "allow",
    "allow",
    "deny",
    "allow",
    "allow",
  ]);
  check(
    "会话一跑完（run.ended）",
    r1.ended,
    r1.failed ? String(r1.failed.data?.message ?? "").slice(0, 200) : "",
  );
  if (!r1.ended) return;

  const t = toolResults();
  check(
    "工具结果按剧本一共 11 条",
    t.length === 11,
    `${t.length} 条：${t.map((x) => x.slice(0, 24).replace(/\n/g, " ")).join(" | ")}`,
  );

  const cards = r1.cards;
  const first = cards[0];
  check(
    "弹了 5 张下载卡片：文件名依次是 报告.bin / blob.txt / 报告.bin / big.bin / dl.zip",
    cards.length === 5 &&
      ["报告.bin", "blob.txt", "报告.bin", "big.bin", "dl.zip"].every((n, i) =>
        String(cards[i]?.body).includes(`文件：${n}`),
      ),
    cards.map((c) => String(c.body).split("\n")[0]).join(" | "),
  );
  check(
    "卡片标题与内容：来源页面与文件地址是浏览器里的真地址，选项只有通过 / 拒绝",
    first?.title === "允许 agent 下载这个文件？" &&
      String(first.body).includes(
        `来源页面：http://server.localhost:${sitePort}/`,
      ) &&
      String(first.body).includes(
        `文件地址：http://server.localhost:${sitePort}/file.bin`,
      ) &&
      JSON.stringify(first.options.map((o) => o.id)) ===
        JSON.stringify(["allow", "deny"]),
    JSON.stringify(first?.options?.map((o) => o.id)),
  );

  // 附件区按工作区存放（<数据目录>/attachments/<工作区 id>），同一工作区的会话共用一块
  const attachDir = join(base, "data", "attachments", ws.id);
  const readBack = async (id, p) => {
    const r = await fetch(
      `${origin}/api/v1/sessions/${id}/attachments/content?path=${encodeURIComponent(p)}`,
    );
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  };

  const reportPath = markerPath(t[2], SAVED_REPORT);
  const reportBack = reportPath ? await readBack(s1.id, reportPath) : null;
  check(
    "通过后文件存进附件区：工具结果带 [attach_file]，按路径取回的字节与站点发出的逐字节相同",
    t[2].includes("Downloaded: 报告.bin") &&
      t[2].includes("transfer_files") &&
      reportBack?.equals(BYTES) === true,
    t[2].replace(/\n/g, " | ").slice(0, 200),
  );
  const blobPath = markerPath(t[3], "blob.txt");
  const blobBack = blobPath ? await readBack(s1.id, blobPath) : null;
  check(
    "页面 JS 造的 blob 下载同样存下来，内容一致",
    t[3].includes("Downloaded: blob.txt") &&
      blobBack?.toString() === "blob-content",
    t[3].replace(/\n/g, " | ").slice(0, 200),
  );
  check(
    "拒绝：工具结果说用户没有批准，这次没有产生新文件",
    t[4].includes("用户没有批准下载 报告.bin") &&
      !t[4].includes("[attach_file]"),
    t[4].replace(/\n/g, " | ").slice(0, 160),
  );
  check(
    "来得比宽限晚的下载：点击的结果里没有下载行（也没有卡片）",
    !t[5].includes("已下载") && !t[5].includes("用户没有批准"),
    t[5].replace(/\n/g, " | ").slice(0, 120),
  );
  check(
    "……它被取消了，控制台里留了一条「没有对应的 agent 动作」",
    t[7].includes("已取消下载") && t[7].includes("没有对应的 agent 动作"),
    t[7].replace(/\n/g, " | ").slice(0, 200),
  );
  check(
    "超过大小上限的文件：丢弃并说明「文件太大」",
    t[8].includes("文件太大") && !t[8].includes("[attach_file]"),
    t[8].replace(/\n/g, " | ").slice(0, 200),
  );
  check(
    "browser_open 直接打开下载地址：存下来了，说明这不是网页，也没给页面编号",
    t[9].includes("是文件下载，不是网页") &&
      t[9].includes("Downloaded: dl.zip") &&
      !/PAGE ID: [a-z0-9]+ · HTTP/.test(t[9]),
    t[9].replace(/\n/g, " | ").slice(0, 220),
  );
  const pageLines = t[10].split("\n").filter((l) => l.trim() !== "");
  check(
    "那个新开的空白页被关掉了：页面列表里只剩第一个页面",
    pageLines.length === 1 && pageLines[0].includes("下载站点"),
    t[10].replace(/\n/g, " | ").slice(0, 200),
  );

  const files1 = filesUnder(attachDir);
  const names1 = files1.map((f) => f.split("/").pop()).sort();
  check(
    "附件区里恰好是通过且没超限的三个文件，没有 .part 残留",
    files1.length === 3 &&
      files1.some((f) => f.endsWith(`-${SAVED_REPORT}`)) &&
      files1.some((f) => f.endsWith("-blob.txt")) &&
      files1.some((f) => f.endsWith("-dl.zip")) &&
      !files1.some((f) => f.endsWith(".part")),
    names1.join(", "),
  );

  // —— 会话二：完全允许档 ——
  const s2res = await api("POST", "/sessions", {
    workspaceId: ws.id,
    config: { permissionTier: "full" },
  });
  if (s2res.status !== 201 && s2res.status !== 200)
    throw new Error(
      `建不了完全允许档的会话：${s2res.status} ${JSON.stringify(s2res.json)}`,
    );
  const s2 = s2res.json;
  const r2 = await runSession(s2.id, "在完全允许档下再下载一次。", []);
  check(
    "会话二（完全允许档）跑完",
    r2.ended,
    r2.failed ? String(r2.failed.data?.message ?? "").slice(0, 200) : "",
  );
  const t2 = toolResults();
  // 与会话一共用一块附件区：扣掉会话一已有的文件，剩下的才是会话二新存的
  const files2 = filesUnder(attachDir).filter((f) => !files1.includes(f));
  check(
    "完全允许档：不弹下载卡片，直接存进附件区，字节一致",
    r2.cards.length === 0 &&
      t2.at(-1)?.includes("Downloaded: 报告.bin") === true &&
      files2.length === 1 &&
      readFileSync(files2[0]).equals(BYTES),
    `卡片 ${r2.cards.length} 张；${t2.at(-1)?.replace(/\n/g, " | ").slice(0, 120)}`,
  );
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  proc.kill("SIGTERM");
  site.closeAllConnections();
  site.close();
  await fake.close();
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

if (crashed)
  console.log(
    `脚本异常：${String(crashed.stack ?? crashed.message)
      .split("\n")
      .slice(0, 6)
      .join(" | ")}`,
  );
const failed = results.filter((x) => !x).length + (crashed ? 1 : 0);
if (failed > 0 && logs.length > 0)
  console.log(
    `Server 日志末尾：${logs.join("").split("\n").slice(-8).join(" | ")}`,
  );
console.log(
  `\n浏览器下载：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
