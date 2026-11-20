// 真实模型端到端冒烟：起一个真实 Server，用 tmp/model 里的真实模型跑一次完整对话，
// 覆盖 工具调用 + 人工审批 + 子代理 spawn/wait + 终端附着 + 审计落库，逐条断言并打印结论。
// 不用 fake；模型地址与密钥只从文件读取，不会打印。前提：已构建 server（pnpm --filter ./packages/server build）。
// 用法：node scripts/e2e-real-model.mjs [--model <models.json 路径，默认 tmp/model>]
// 真实小模型有随机性，偶尔会不调工具直接作答；失败时先看 run.failed/工具调用数再重跑（E2E_VERBOSE=1 打印事件类型）。
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WebSocket = createRequire(join(root, "packages/server/package.json"))(
  "ws",
);
const argModel = process.argv.indexOf("--model");
const MODEL_FILE =
  argModel > 0 ? process.argv[argModel + 1] : join(root, "tmp", "model");
if (!existsSync(MODEL_FILE)) {
  console.error(
    `缺少模型配置：${MODEL_FILE}（pi models.json 形状，已被 gitignore）`,
  );
  process.exit(2);
}
const provider = Object.values(
  JSON.parse(readFileSync(MODEL_FILE, "utf8")).providers,
)[0];
const model = provider.models[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 文件里的内容只是一个验收码：提示词里别用「暗号 / secret」这类字眼，真实模型会把它当成套取机密而拒绝执行子代理那一步
const SECRET = `E2E-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "e2e-real-"));
const work = join(base, "work");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "marker.txt"), `${SECRET}\n`);
const port = 17900 + Math.floor(Math.random() * 90);
const http = `http://127.0.0.1:${port}/api/v1`;

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
const call = async (method, path, body) => {
  const r = await fetch(`${http}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
  return text ? JSON.parse(text) : undefined;
};

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");

  // 登记真实模型并设为默认
  const m = await call("POST", "/models", {
    name: "e2e",
    api: provider.api,
    baseUrl: provider.baseUrl,
    modelId: model.id,
    reasoning: Boolean(model.reasoning),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevelMap: model.thinkingLevelMap,
    compat: provider.compat,
    apiKey: provider.apiKey,
  });
  await call("PATCH", `/models/${m.id}`, { isDefault: true });

  const ws = await call("POST", "/directories", {
    path: work,
    environmentId: "local",
  });
  const agents = (await call("GET", "/agents")).agents;
  const agent = agents.find((a) => a.name === "coder-full") ?? agents[0];
  const session = await call("POST", "/sessions", {
    agentId: agent.id,
    directoryId: ws.id,
    name: "e2e-real-model",
  });

  // 会话流：收集事件，遇到审批弹窗按「仅此次通过」作答（人工审批路径）
  const frames = [];
  const approvals = [];
  const sock = new WebSocket(
    `ws://127.0.0.1:${port}/api/v1/sessions/${session.id}/stream`,
    ["yuanshu.v1"],
  );
  let n = 0;
  const send = (type, extra = {}) =>
    sock.send(JSON.stringify({ id: `c${++n}`, type, ...extra }));
  sock.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "ack") return;
    frames.push(f);
    if (f.type === "prompt.requested" && f.data.source === "approval") {
      approvals.push(f.data);
      const allow =
        f.data.options.find((o) => o.id === "allow") ?? f.data.options[0];
      send("answer_prompt", { promptId: f.data.promptId, optionId: allow.id });
    }
  });
  await new Promise((res, rej) => {
    sock.once("open", res);
    sock.once("error", rej);
  });

  send("send_message", {
    text:
      "请严格按顺序完成：" +
      "(1) 用 bash 工具执行 `touch approved.txt && ls -l approved.txt`；" +
      "(2) 用 spawn_subagent 派发一个子代理，任务是读取当前目录的 marker.txt（里面只有一个测试用的验收码）并把内容原样作为它的最终回复，再用 wait_subagent 等它完成；" +
      "(3) 在你的最终回复里原样写出子代理返回的验收码。",
  });
  const deadline = Date.now() + 360_000;
  while (!frames.some((f) => f.type === "run.ended") && Date.now() < deadline)
    await sleep(200);
  check(
    "一次完整对话在真实模型上跑完（run.ended）",
    frames.some((f) => f.type === "run.ended"),
  );
  const failedRun = frames.find((f) => f.type === "run.failed");
  if (failedRun)
    console.log(
      `      run.failed: ${String(failedRun.data.message).slice(0, 200)}`,
    );
  if (process.env.E2E_VERBOSE) console.log(frames.map((f) => f.type).join(" "));

  const ended = frames.filter((f) => f.type === "tool.ended");
  const tool = (name) => ended.find((f) => f.data.toolName === name);
  check(
    "工具调用：bash 执行成功",
    tool("bash")?.data.isError === false,
    `共 ${ended.length} 次工具调用`,
  );
  check(
    "人工审批：弹窗已广播并被作答后工具继续执行",
    approvals.length >= 1 && frames.some((f) => f.type === "prompt.resolved"),
    `审批弹窗 ${approvals.length} 个`,
  );
  check(
    "子代理：spawn_subagent 成功",
    tool("spawn_subagent")?.data.isError === false,
  );
  check(
    "子代理：wait_subagent 取回的结果含验收码",
    String(tool("wait_subagent")?.data.output ?? "").includes(SECRET),
  );
  const lastAssistant = frames
    .filter((f) => f.type === "message.ended" && f.data.role === "assistant")
    .at(-1);
  check(
    "父会话最终回复里复述了验收码",
    JSON.stringify(lastAssistant?.data ?? "").includes(SECRET),
  );
  // 失败时要能看出是模型没调工具、工具被拒，还是回复里没写验收码
  const brief = (v) =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 160);
  console.log(
    `      工具调用：${ended
      .map((f) => `${f.data.toolName}${f.data.isError ? "(错误)" : ""}`)
      .join(" → ")}`,
  );
  for (const name of ["spawn_subagent", "wait_subagent"]) {
    const t = tool(name);
    if (t) console.log(`      ${name} 输出：${brief(t.data.output)}`);
  }
  console.log(
    `      父会话最终回复：${brief(lastAssistant?.data?.text ?? JSON.stringify(lastAssistant?.data))}`,
  );
  sock.terminate();

  const topo = (await call("GET", "/topology")).nodes;
  check(
    "拓扑里是一父一子，子代理已完成",
    topo.length === 2 &&
      topo.some((x) => x.parentId === session.id && x.state === "done"),
  );
  const list = (await call("GET", "/sessions")).sessions;
  check(
    "子代理会话不进会话库列表",
    list.length === 1 && list[0].id === session.id,
  );

  // 终端附着：同一会话的工作目录下开终端，读到同一份验收码
  const term = await call("POST", "/terminals", {
    environmentId: "local",
    cwd: work,
    cols: 100,
    rows: 30,
    sessionId: session.id,
  });
  const tws = new WebSocket(
    `ws://127.0.0.1:${port}/api/v1/terminals/${term.id}/stream`,
    ["yuanshu.v1"],
  );
  let out = "";
  tws.on("message", (d, bin) => {
    if (bin) out += d.toString();
  });
  await new Promise((res, rej) => {
    tws.once("open", res);
    tws.once("error", rej);
  });
  tws.send(
    JSON.stringify({
      type: "input",
      data: "cat marker.txt && test -f approved.txt && echo FILE-OK-$((6*7))\n",
    }),
  );
  for (
    let i = 0;
    i < 100 && !(out.includes(SECRET) && out.includes("FILE-OK-42"));
    i++
  )
    await sleep(100);
  check(
    "终端附着：能读到验收码，并看到 bash 工具创建的文件",
    out.includes(SECRET) && out.includes("FILE-OK-42"),
  );
  tws.terminate();
  await call("DELETE", `/terminals/${term.id}`);

  // 审计：每次模型请求（含子代理）都有记录，响应带 usage
  const calls = (await call("GET", `/sessions/${session.id}/calls`)).calls;
  check(
    "审计：父会话的模型请求已落库，且带 token 用量与 stop_reason",
    Array.isArray(calls) &&
      calls.length >= 3 &&
      calls.every((c) => c.tokens && c.stopReason),
    `${calls?.length ?? 0} 条`,
  );
}

try {
  await main();
} catch (e) {
  check("脚本执行未抛错", false, String(e.message));
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
