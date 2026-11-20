// 页面内容管线的真机检查：起真实 Server（临时数据目录，真 Chromium 当 agent 浏览器）+ 假模型（主对话按剧本调浏览器工具，
// 辅助调用与页面阅读 agent 也由假模型回 JSON 指针）+ 本地假站点，不需要真实模型，也不开用户侧浏览器。
// 这里验的是接线：辅助模型设置、aux 调用、内置只读阅读 agent（page-reader）、指针展开与回落，单测都够不到。
//  1) 配了辅助模型、页面不大：open 走单次调用，结果是「概述」（gist、部分、代表元素原文展开、全文文件）
//  2) 带 intent 的 snapshot：只展开辅助模型指认的元素，没指认的不出现
//  3) 辅助模型回的不是 JSON：重试一次后回落成机械层全文，最前面一行 NOTE 写明原因，页面内容仍在
//  4) 页面很大（> 60000 字符）：Server 起内置只读 agent 读它，agent 经 deliver 交出指针，结果按指针展开；agent 读的是附件区里的全文文件
// 用法：node scripts/verify-browser-content.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
const base = mkdtempSync(join(root, "tmp", "browser-content-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(`${work}/proj`, { recursive: true });

// —— 假站点：/list 是机械层 800–12000 字符的列表页；/huge 超过 60000 字符，分四个标题段 ——
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const LIST = `<!doctype html><title>条目库</title><h1>条目库</h1>
  <p>下面是全部条目。</p><ul>${range(60)
    .map((n) => `<li><a href="/i/${n}">条目 ${n}</a></li>`)
    .join("")}</ul>`;
const HUGE = `<!doctype html><title>巨型目录</title><h1>巨型目录</h1>${range(4)
  .map(
    (k) =>
      `<h2>分类 ${k}</h2><ul>${range(450)
        .map(
          (n) =>
            `<li><a href="/i/${k}-${n}">条目 ${k}-${n} 的详细说明页面</a></li>`,
        )
        .join("")}</ul>`,
  )
  .join("")}`;
const site = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const body = path === "/list" ? LIST : path === "/huge" ? HUGE : null;
  if (body === null) {
    res.writeHead(404, { "content-type": "text/plain" }).end("nf");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
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
const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((p) => p.text ?? "").join("");
const userText = (body) =>
  (body.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => textOf(m.content))
    .join("\n");
/** 带行号快照里某个元素的编号：`link "条目 7" [ref=e12]` */
const refIn = (text, role, name) =>
  new RegExp(`${role} "${name}"[^\\n]*?\\[ref=(\\w+)\\]`).exec(text)?.[1];

// 辅助调用：按提示词里的任务回 JSON 指针；intent 含 garbage 的回一段不是 JSON 的话
const auxReply = (body) => {
  const system = textOf(body.messages?.[0]?.content);
  if (!system.includes("page-reading component")) return null;
  const text = userText(body);
  if (text.includes("INTENT: garbage")) return "this is not json at all";
  const total = Number(/\((\d+) lines;/.exec(text)?.[1] ?? 1);
  if (text.includes("INTENT:")) {
    return JSON.stringify({
      groups: [{ refs: [refIn(text, "link", "条目 7")] }],
      unresolved: "",
    });
  }
  return JSON.stringify({
    gist: "条目列表页",
    parts: [
      {
        caption: "条目列表",
        lines: [1, total],
        refs: [refIn(text, "link", "条目 3")],
        quote: [],
      },
    ],
  });
};

const fake = await startFakeModel(
  [
    // 先「启动服务」：命令输出里出现这个端口，之后 browser_open 才不用批准
    {
      tools: [
        {
          name: "bash",
          args: { command: `echo "ready on http://localhost:${sitePort}/"` },
        },
      ],
    },
    {
      tools: [
        { name: "browser_open", args: { target: `server:${sitePort}/list` } },
      ],
    },
    {
      tools: [
        {
          name: "browser_snapshot",
          args: (m) => ({
            pageId: pageIdOf(m),
            intent: "找到条目 7 的链接",
          }),
        },
      ],
    },
    {
      tools: [
        {
          name: "browser_snapshot",
          args: (m) => ({ pageId: pageIdOf(m), intent: "garbage" }),
        },
      ],
    },
    {
      tools: [
        { name: "browser_open", args: { target: `server:${sitePort}/huge` } },
      ],
    },
    // 下一轮是内置阅读 agent 的：它拿到的任务里有结构视图，交出指针
    {
      tools: [
        {
          name: "deliver",
          args: (m) => {
            const text = userText({ messages: m });
            const total = Number(/file has (\d+) lines/.exec(text)?.[1] ?? 1);
            return {
              summary: "done",
              report: JSON.stringify({
                gist: "巨型目录",
                parts: [
                  {
                    caption: "第二个分类",
                    lines: [1, total],
                    refs: [refIn(text, "heading", "分类 2")],
                    quote: [],
                  },
                ],
              }),
            };
          },
        },
      ],
    },
    { text: "读完了。" },
  ],
  { delay: 20, aux: auxReply },
);

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

/** 在一个会话里发一句话，审批卡片一律通过，跑到 run.ended。 */
async function runSession(sessionId, text) {
  const frames = [];
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
    const pick =
      f.data.options.find((o) => o.id === "allow") ?? f.data.options[0];
    send("answer_prompt", { promptId: f.data.promptId, optionId: pick.id });
  };
  send("send_message", { text });
  const ended = await until(
    async () => frames.some((f) => f.type === "run.ended"),
    240_000,
  );
  sock.close();
  return {
    ended: !!ended,
    failed: frames.find((f) => f.type === "run.failed"),
  };
}

/** 主对话最后一次请求里的全部工具结果（按顺序）。 */
const toolResults = () => {
  const main = fake.requests.filter((r) => r.main);
  return (main.at(-1)?.body.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
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

  const providerId = (
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
    })
  ).json.id;
  const put = await api("PUT", "/defaults", {
    auxModel: { provider: providerId, model: "fake", thinking: null },
  });
  if (put.status !== 200)
    throw new Error(
      `设不了辅助模型：${put.status} ${JSON.stringify(put.json)}`,
    );
  const ws = (
    await api("POST", "/workspaces", {
      name: "内容",
      directories: [{ path: `${work}/proj` }],
    })
  ).json;
  const session = (await api("POST", "/sessions", { workspaceId: ws.id })).json;
  const run = await runSession(session.id, "读一下这几个页面。");
  check(
    "会话跑完（run.ended）",
    run.ended,
    run.failed ? String(run.failed.data?.message ?? "").slice(0, 200) : "",
  );
  if (!run.ended) return;

  const t = toolResults();
  check(
    "主对话的工具结果一共 5 条（bash + 2 次 open + 2 次 snapshot）",
    t.length === 5,
    `${t.length} 条`,
  );
  const [, opened, intent, garbage, huge] = t;

  const auxCalls = fake.requests.filter(
    (r) =>
      !r.main &&
      textOf(r.body.messages?.[0]?.content).includes("page-reading component"),
  );
  check(
    "辅助模型被调用：概述 1 次、intent 1 次、回不出 JSON 的重试共 2 次",
    auxCalls.length === 4,
    `${auxCalls.length} 次`,
  );

  // 1) 概述
  check(
    "open（没有 intent）：概述带 gist、部分标题、全文文件",
    opened.includes("PAGE: 条目库") &&
      opened.includes("条目列表页") &&
      opened.includes("model-written, navigation only") &&
      opened.includes("FULL TEXT"),
    opened.slice(0, 300).replace(/\n/g, " ⏎ "),
  );
  check(
    "概述里的代表元素是原树展开的原文（链接名与目标），不是模型复述",
    /e\d+ link "条目 3" → \/i\/3/.test(opened),
    opened.slice(0, 500).replace(/\n/g, " ⏎ "),
  );

  // 2) intent
  check(
    "intent：只展开指认的元素",
    /e\d+ link "条目 7" → \/i\/7/.test(intent) && !intent.includes("条目 20"),
    intent.slice(0, 300).replace(/\n/g, " ⏎ "),
  );

  // 3) 回落
  check(
    "回不出 JSON：回落成机械层全文，最前面是 NOTE",
    /NOTE:/.test(intent === garbage ? "" : garbage) &&
      garbage.includes("条目 20") &&
      garbage.includes("条目 60"),
    garbage.slice(0, 300).replace(/\n/g, " ⏎ "),
  );

  // 4) 大页面
  const readerRequests = fake.requests.filter(
    (r) => r.main && userText(r.body).includes("PAGE TEXT FILE:"),
  );
  check(
    "大页面：起了内置阅读 agent，它拿到全文文件与结构视图",
    readerRequests.length >= 1 &&
      userText(readerRequests[0].body).includes("STRUCTURE VIEW:") &&
      userText(readerRequests[0].body).includes("[attach_file]"),
    `${readerRequests.length} 次请求`,
  );
  const readerTools = (readerRequests[0]?.body.tools ?? []).map(
    (x) => x.function?.name,
  );
  check(
    "阅读 agent 是只读的：有 read、grep、deliver，没有写文件、命令、浏览器这类会改东西的工具",
    ["read", "grep", "deliver"].every((n) => readerTools.includes(n)) &&
      !readerTools.some((n) =>
        /^(bash|write|edit|ls|find|browser_|canvas_|switch_)/.test(n),
      ),
    JSON.stringify(readerTools),
  );
  check(
    "大页面结果按 agent 交出的指针展开：分类 2 的标题，没有 NOTE",
    huge.includes("巨型目录") &&
      /e\d+ heading "分类 2"/.test(huge) &&
      !huge.includes("NOTE:"),
    huge.slice(0, 400).replace(/\n/g, " ⏎ "),
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
  `\n页面内容管线：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
