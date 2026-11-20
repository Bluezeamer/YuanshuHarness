// 浏览器上传的真机检查：真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 假模型（按剧本真的调浏览器工具）
// + 一个会记下收到的表单上传的本地假站点，不需要真实模型，也不需要用户那一侧的浏览器：审批卡片经会话 WebSocket 作答。
// 接线问题（来源文件的范围、审批档、卡片内容、文件真的到了站点）单测测不出，这里用真 Server 验。
// 会话一（默认档位，每次审批）：
//  1) 上传工作区里的文件：弹「允许 agent 上传文件？」，写着目标站点（页面真实地址）与文件，选项只有通过 / 拒绝（没有「记住」）
//  2) 通过后文件进了页面的上传入口；点页面上的提交，站点收到原文件名与逐字节相同的内容（选完文件到提交之间源文件早已不被占用）
//  3) 硬边界不弹卡片、直接说明原因：敏感文件（.env）、符号链接指到工作区外、工作区之外的绝对路径
//  4) 拒绝：工具结果说用户没有批准，站点没有收到第二份
// 会话二（完全允许档）：同样的上传不弹卡片，直接交出文件，站点收到。
// 前提：已构建 server（packages/server/dist）。浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用 playwright-core 装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-uploads.mjs
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
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
const base = mkdtempSync(join(root, "tmp", "browser-uploads-"));
const work = `${realpathSync(base)}/work`;
const proj = `${work}/proj`;
mkdirSync(proj, { recursive: true });

// —— 工作区里的文件：一个能传的、一个敏感的、一个符号链接指到工作区外的 ——
const PAYLOAD = `UPLOAD-PAYLOAD-${Math.random().toString(16).slice(2)}-`.repeat(
  400,
);
writeFileSync(join(proj, "report.txt"), PAYLOAD);
writeFileSync(join(proj, ".env"), "API_KEY=do-not-upload");
writeFileSync(`${work}/outside.txt`, "outside the workspace");
symlinkSync(`${work}/outside.txt`, join(proj, "escape.txt"));

// —— 假站点：一个带上传入口和提交按钮的表单；收到的每次表单上传都记下来 ——
const PAGE = `<!doctype html><meta charset=utf-8><title>上传站点</title>
<form method="post" action="/up" enctype="multipart/form-data">
  <input type="file" name="f" aria-label="简历" style="position:fixed;left:50px;top:80px;width:300px;height:40px">
  <button type="submit" style="position:fixed;left:50px;top:160px;width:200px;height:50px">提交</button>
</form>`;
const received = [];
const site = http.createServer((req, res) => {
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      received.push({
        filename: /filename="([^"]*)"/.exec(body)?.[1] ?? "",
        hasPayload: body.includes(PAYLOAD),
      });
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<!doctype html><title>已收到</title>已收到");
    });
    return;
  }
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
// 取快照里某个名字的元素编号：机械层的写法 `button "简历" [ref=e12]`
const refOf = (messages, name) => {
  const re = new RegExp(
    `[a-z]+ \\\\?"${name}\\\\?"[^\\\\]*?\\[ref=(f?\\d*e\\d+)\\]`,
  );
  for (const m of [...messages].reverse()) {
    const hit = re.exec(JSON.stringify(m.content ?? ""));
    if (hit) return hit[1];
  }
  return "";
};
const upload = (path, extra = {}) => ({
  name: "browser_upload",
  args: (messages) => ({
    pageId: pageIdOf(messages),
    ref: refOf(messages, "简历"),
    files: [path],
    ...extra,
  }),
});
const submit = {
  name: "browser_click",
  args: (messages) => ({
    pageId: pageIdOf(messages),
    ref: refOf(messages, "提交"),
  }),
};
const open = {
  name: "browser_open",
  args: { target: `server:${sitePort}/` },
};

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
  { tools: [open] }, // 2
  { tools: [upload("report.txt")] }, // 3 通过
  { tools: [submit] }, // 4 点提交，站点收到
  { tools: [upload(".env")] }, // 5 敏感文件：直接拒
  { tools: [upload("escape.txt")] }, // 6 符号链接指到工作区外：直接拒
  { tools: [upload("/etc/hostname")] }, // 7 工作区之外：直接拒
  { tools: [upload("report.txt")] }, // 8 拒绝
  { text: "做完了。" }, // 9
  // 会话二（完全允许档）
  { tools: [open] },
  { tools: [upload("report.txt")] },
  { tools: [submit] },
  { text: "完全允许档做完了。" },
];
const fake = await startFakeModel(SCRIPT, { delay: 20 });

const port = 19000 + Math.floor(Math.random() * 90);
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

/** 在一个会话里发一句话，按顺序答复上传卡片，跑到 run.ended；返回上传卡片与结束与否。 */
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
    const isUpload = String(f.data.title).startsWith("允许 agent 上传");
    // 上传卡片按预定顺序答；别的审批（比如 bash）一律通过
    const want = isUpload ? decide[cards.length] : "allow";
    if (isUpload) cards.push(f.data);
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
const brief = (t) => (t ?? "").replace(/\n/g, " | ").slice(0, 200);

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
  const ws = (
    await api("POST", "/workspaces", {
      name: "上传",
      directories: [{ path: proj }],
    })
  ).json;

  // —— 会话一：默认档位，每次审批 ——
  const s1 = (await api("POST", "/sessions", { workspaceId: ws.id })).json;
  const r1 = await runSession(s1.id, "把简历上传到这个页面。", [
    "allow",
    "deny",
  ]);
  check(
    "会话一跑完（run.ended）",
    r1.ended,
    r1.failed ? String(r1.failed.data?.message ?? "").slice(0, 200) : "",
  );
  if (!r1.ended) return;

  const t = toolResults();
  check(
    "工具结果按剧本一共 8 条",
    t.length === 8,
    `${t.length} 条：${t.map((x) => x.slice(0, 20).replace(/\n/g, " ")).join(" | ")}`,
  );

  const cards = r1.cards;
  const first = cards[0];
  check(
    "只弹了 2 张上传卡片（通过的与拒绝的）：硬边界拒绝的三次没有弹卡片",
    cards.length === 2,
    `${cards.length} 张`,
  );
  check(
    "卡片：目标站点是页面真实地址，写着文件名，选项只有通过 / 拒绝",
    first?.title === "允许 agent 上传文件？" &&
      String(first.body).includes(
        `目标站点：http://server.localhost:${sitePort}`,
      ) &&
      String(first.body).includes("report.txt") &&
      JSON.stringify(first.options.map((o) => o.id)) ===
        JSON.stringify(["allow", "deny"]),
    `${JSON.stringify(first?.options?.map((o) => o.id))} ${String(first?.body).split("\n")[0]}`,
  );
  check(
    "通过后：工具结果的 ACTION 写 upload，UPLOADED 行里有文件名",
    t[2].includes("ACTION: upload 1 files") &&
      t[2].includes("UPLOADED: report.txt"),
    brief(t[2]),
  );
  check(
    "点页面上的提交后，站点收到原文件名与逐字节相同的内容",
    received.length === 1 &&
      received[0].filename === "report.txt" &&
      received[0].hasPayload,
    JSON.stringify(received),
  );
  check(
    "敏感文件（.env）：直接拒绝并说明原因",
    t[4].includes("secret or credential file"),
    brief(t[4]),
  );
  check(
    "符号链接指到工作区外：直接拒绝",
    t[5].includes("is not inside its directory"),
    brief(t[5]),
  );
  check(
    "工作区之外的绝对路径：直接拒绝",
    t[6].includes("is not inside its directory"),
    brief(t[6]),
  );
  check(
    "拒绝：工具结果说用户没有批准上传，站点没有再收到文件",
    t[7].includes("用户没有批准上传") && received.length === 1,
    `${brief(t[7])}；站点共收到 ${received.length} 份`,
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
  const r2 = await runSession(s2res.json.id, "完全允许档下再上传一次。", []);
  check(
    "会话二（完全允许档）跑完",
    r2.ended,
    r2.failed ? String(r2.failed.data?.message ?? "").slice(0, 200) : "",
  );
  const t2 = toolResults();
  check(
    "完全允许档：不弹上传卡片，直接交出文件，站点收到",
    r2.cards.length === 0 &&
      t2.some((x) => x.includes("ACTION: upload 1 files")) &&
      received.length === 2 &&
      received[1].filename === "report.txt" &&
      received[1].hasPayload,
    `卡片 ${r2.cards.length} 张；站点共收到 ${received.length} 份`,
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
  `\n浏览器上传：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
