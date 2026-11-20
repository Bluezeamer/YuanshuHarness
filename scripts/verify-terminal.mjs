// 终端生命周期的真机验收（docs/model/terminal.md 的 R1–R9）：起一个真实 Server（真 PTY、真 WS），
// 逐条断言并打印结论。前提：已 `pnpm --filter ./packages/server build`。
// 用法：node scripts/verify-terminal.mjs [--idle <秒>]   （--idle 是 R1 的真实空闲等待，默认 20）
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WebSocket = createRequire(join(root, "packages/server/package.json"))(
  "ws",
);
const idleArg = process.argv.indexOf("--idle");
const IDLE_S = idleArg > 0 ? Number(process.argv[idleArg + 1]) : 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "verify-terminal-token-0123456789abcdef";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

mkdirSync(join(root, "tmp"), { recursive: true });
const dataDir = mkdtempSync(join(root, "tmp", "term-verify-"));
const port = 17500 + Math.floor(Math.random() * 400);
let proc = null;

async function start({ token = null, maxTerminals = 3 } = {}) {
  const args = [
    join(root, "packages/server/dist/bin.js"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--data-dir",
    dataDir,
    "--max-terminals",
    String(maxTerminals),
  ];
  proc = spawn("node", args, {
    env: { ...process.env, ...(token ? { YUANSHU_TOKEN: token } : {}) },
    stdio: "ignore",
  });
  for (let i = 0; i < 600; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
}
async function stop() {
  if (!proc) return;
  const p = proc;
  proc = null;
  p.kill("SIGTERM");
  await new Promise((r) => p.on("exit", r));
}

const api = (path, init = {}, token = null) =>
  fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
const create = async (token = null) => {
  const r = await api(
    "/terminals",
    {
      method: "POST",
      body: JSON.stringify({ environmentId: "local", cols: 100, rows: 30 }),
    },
    token,
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const list = async () => (await (await api("/terminals")).json()).terminals;

// 附着：收集全部输出文本；ready 帧带回终端 id
function attach(id, token = null) {
  const url = `ws://127.0.0.1:${port}/api/v1/terminals/${id}/stream`;
  const ws = new WebSocket(
    url,
    token ? ["yuanshu.v1", `bearer.${token}`] : ["yuanshu.v1"],
  );
  const c = { ws, out: "", ready: null, closed: false };
  ws.on("message", (data, isBinary) => {
    if (isBinary) c.out += data.toString();
    else {
      const m = JSON.parse(data.toString());
      if (m.type === "ready") c.ready = m;
    }
  });
  ws.on("close", () => {
    c.closed = true;
  });
  c.opened = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
    ws.on("unexpected-response", (_q, s) =>
      rej(new Error(`HTTP ${s.statusCode}`)),
    );
  });
  c.input = (text) => ws.send(JSON.stringify({ type: "input", data: text }));
  c.waitFor = async (needle, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (c.out.includes(needle)) return true;
      await sleep(50);
    }
    return false;
  };
  return c;
}

try {
  await start();

  // R1 + R4(服务端部分)：无客户端不回收，接回同一 id，shell 仍是原来那个
  const { body: t1 } = await create();
  const id = t1.id;
  const c0 = attach(id);
  await c0.opened;
  c0.input("MARK=survived-$$\n");
  await sleep(300);
  c0.ws.close();
  await sleep(IDLE_S * 1000);
  const afterIdle = (await list()).find((t) => t.id === id);
  check(
    `R1 无客户端空闲 ${IDLE_S}s 后终端仍在列表里`,
    !!afterIdle && afterIdle.attached === 0,
  );
  const c1 = attach(id);
  await c1.opened;
  c1.input('echo "mark=$MARK"\n');
  const sameShell = await c1.waitFor("mark=survived-");
  check(
    "R4 接回同一 id，且仍是原来的 shell（环境变量还在）",
    c1.ready?.id === id && sameShell,
  );

  // R2：多客户端附着，关闭其中一个只 detach
  const c2 = attach(id);
  await c2.opened;
  c1.input("echo both-see-this\n");
  const both =
    (await c1.waitFor("both-see-this")) && (await c2.waitFor("both-see-this"));
  c2.ws.close();
  await sleep(300);
  check("R2 两个客户端同时附着都能收到输出", both);
  const afterDetach = (await list()).find((t) => t.id === id);
  check(
    "R2 关闭一个连接只 detach（终端在、附着数 1）",
    !!afterDetach && afterDetach.attached === 1,
  );

  // R3：无人消费时 PTY 暂停而不是杀 shell；接回后恢复，shell 仍响应
  c1.input("yes pad-line-pad-line-pad-line | head -n 3000000\n");
  await sleep(200);
  c1.ws.close();
  await sleep(2500);
  const paused = (await list()).find((t) => t.id === id);
  check(
    "R3 无人消费时 PTY 被暂停（paused=true），终端仍在",
    !!paused && paused.paused === true && paused.attached === 0,
  );
  const c3 = attach(id);
  await c3.opened;
  await c3.waitFor("pad-line", 5000);
  await sleep(3000);
  c3.input("\x03");
  await sleep(300);
  c3.out = "";
  c3.input("echo after-pause-$((20+22))\n");
  check(
    "R3 接回并消费后恢复；shell 没被杀，仍响应输入",
    await c3.waitFor("after-pause-42", 10000),
  );
  const resumed = (await list()).find((t) => t.id === id);
  check("R3 恢复后 paused=false", !!resumed && resumed.paused === false);

  // R5：列表字段与显式关闭
  const row = (await list()).find((t) => t.id === id);
  const fields = [
    "id",
    "environmentId",
    "cwd",
    "cols",
    "rows",
    "attached",
    "createdAt",
  ];
  check(
    `R5 列表含 ${fields.join("/")}`,
    fields.every((f) => row && f in row),
  );
  c3.ws.close();
  const orphan = (await create()).body.id;
  check(
    "R5 没有任何引用/附着的终端也能在列表里看到",
    !!(await list()).find((t) => t.id === orphan),
  );
  const del = await api(`/terminals/${orphan}`, { method: "DELETE" });
  check(
    "R5 显式关闭后从列表消失",
    del.status === 204 && !(await list()).find((t) => t.id === orphan),
  );

  // R7：上限（本次为 3）返回 429，提示可操作
  await create();
  const nowN = (await list()).length;
  for (let i = nowN; i < 3; i++) await create();
  const over = await create();
  check(
    "R7 超过上限返回 429 且带提示",
    over.status === 429,
    JSON.stringify(over.body).slice(0, 120),
  );

  // R6（服务端部分）：重启后旧 id 不存在，既不静默新建也不复用
  await stop();
  await start();
  const gone = await api(`/terminals/${id}`);
  let wsStatus = "opened";
  try {
    await attach(id).opened;
  } catch (e) {
    wsStatus = String(e.message);
  }
  check(
    "R6 Server 重启后旧 id：REST 404、WS 升级被拒（404）",
    gone.status === 404 && wsStatus.includes("404"),
    `rest=${gone.status} ws=${wsStatus}`,
  );
  check("R6 重启后没有静默新建终端", (await list()).length === 0);

  // R9：认证不退化（带令牌启动：无令牌 401，WS 无令牌被拒，带令牌可用）
  await stop();
  await start({ token: TOKEN });
  const noAuth = await api("/terminals", {
    method: "POST",
    body: JSON.stringify({ environmentId: "local", cols: 80, rows: 24 }),
  });
  const authed = await create(TOKEN);
  let wsNoToken = "opened";
  try {
    await attach(authed.body.id).opened;
  } catch (e) {
    wsNoToken = String(e.message);
  }
  const cAuth = attach(authed.body.id, TOKEN);
  await cAuth.opened;
  cAuth.input("echo auth-ok\n");
  check(
    "R9 认证：无令牌创建 401、WS 无令牌被拒、带令牌可用",
    noAuth.status === 401 &&
      authed.status === 201 &&
      wsNoToken.includes("401") &&
      (await cAuth.waitFor("auth-ok")),
    `create=${noAuth.status} ws=${wsNoToken}`,
  );
  cAuth.ws.close();
} finally {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
