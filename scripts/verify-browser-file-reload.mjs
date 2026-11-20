// agent 页上 HTML 文件变化自动刷新的真机检查：真实 Server（临时数据目录，真 Chromium 当 agent 浏览器），
// 只走接口，不开用户侧浏览器、不用模型。接线问题（把文件监听中枢交给浏览器服务、页面事件接到监听）单测测不出，这里用真 Server 验。
//  1) agent 控制的文件页：改页面所在目录里的 HTML，页面自己刷新（标题变成新内容）
//  2) 同目录的别的文件（样式、脚本、图片）变了也刷新：页面里引用的资源一起新
//  3) 你在操作的页面（手动态）：同样的改动不刷新，免得冲掉你填的东西；交还 agent 之后，下一次改动又会刷新
//  4) 页面关掉之后改文件不出错、其余页面照常
// 前提：已构建 server（packages/server/dist）。浏览器取 YUANSHU_BROWSER 指向的可执行文件；没设时用上面装的那份，再没有就由引擎自己下载（镜像见 PLAYWRIGHT_DOWNLOAD_HOST）。
// 用法：node scripts/verify-browser-file-reload.mjs
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(150);
    v = await fn();
  }
  return v;
}

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-file-reload-"));
const work = `${realpathSync(base)}/work`;
const proj = `${work}/proj`;
mkdirSync(proj, { recursive: true });

// 页面标题 = 当前版本号；样式文件里的颜色写进 #probe 的内联脚本读出来，也写进标题，这样样式变了标题也变
const html = (v) =>
  `<!doctype html><meta charset=utf-8><title>v${v}</title><p id=probe>x</p>`;
const page = join(proj, "index.html");
writeFileSync(page, html(1));
const withCss = join(proj, "styled.html");
const css = join(proj, "style.js");
writeFileSync(css, `window.ver = "a";`);
writeFileSync(
  withCss,
  `<!doctype html><meta charset=utf-8><title>loading</title><script src="style.js"></script><script>document.title = "js-" + window.ver;</script>`,
);

const port = 19400 + Math.floor(Math.random() * 90);
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

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");

  const ws = (
    await api("POST", "/workspaces", {
      name: "文件刷新",
      directories: [{ path: proj }],
    })
  ).json;
  const pagesOf = async () =>
    (await api("GET", `/workspaces/${ws.id}/browser`)).json.pages;
  const titleOf = async (id) =>
    (await pagesOf()).find((p) => p.id === id)?.title ?? null;
  /** 用户（接口）开一个文件页：新页面一开始是手动操作，再「交给 agent」。 */
  const openFile = async (path, controller) => {
    const r = await api("POST", `/workspaces/${ws.id}/browser/pages`, {
      target: `server:${path}`,
    });
    if (r.status !== 201) throw new Error(`开页面失败 ${r.status}`);
    const id = r.json.page.id;
    if (controller === "agent")
      await api("POST", `/workspaces/${ws.id}/browser/pages/${id}/control`, {
        mode: "agent",
      });
    return id;
  };

  // 1) agent 控制的文件页：改 HTML，页面自己刷新
  const a = await openFile(page, "agent");
  check(
    "agent 控制的文件页打开，标题是 v1",
    !!(await until(async () => (await titleOf(a)) === "v1")),
    String(await titleOf(a)),
  );
  // 等监听挂稳（页面状态事件到监听订阅有一小段时间），再改文件
  await sleep(800);
  writeFileSync(page, html(2));
  check(
    "改所在目录里的 HTML：页面自己刷新，标题变成 v2",
    !!(await until(async () => (await titleOf(a)) === "v2", 15000)),
    String(await titleOf(a)),
  );

  // 2) 同目录里被引用的别的文件变了也刷新
  const b = await openFile(withCss, "agent");
  check(
    "引用了同目录脚本的页面：标题是 js-a",
    !!(await until(async () => (await titleOf(b)) === "js-a")),
    String(await titleOf(b)),
  );
  await sleep(800);
  writeFileSync(css, `window.ver = "b";`);
  check(
    "只改被引用的脚本：页面也刷新，标题变成 js-b",
    !!(await until(async () => (await titleOf(b)) === "js-b", 15000)),
    String(await titleOf(b)),
  );

  // 3) 你在操作的页面：不刷新；交还 agent 之后，下一次改动会刷新
  const m = await openFile(page, "user");
  await until(async () => (await titleOf(m)) === "v2");
  await sleep(800);
  writeFileSync(page, html(3));
  // agent 的那一页（a）会刷新到 v3；等它刷新完说明这一轮改动已经被监听处理过，再看手动态那一页
  await until(async () => (await titleOf(a)) === "v3", 15000);
  await sleep(1200);
  check(
    "你在操作的页面：同一次改动没有刷新，标题还是 v2",
    (await titleOf(m)) === "v2",
    String(await titleOf(m)),
  );
  await api("POST", `/workspaces/${ws.id}/browser/pages/${m}/control`, {
    mode: "agent",
  });
  await sleep(800);
  writeFileSync(page, html(4));
  check(
    "交还 agent 之后，下一次改动刷新了它：标题变成 v4",
    !!(await until(async () => (await titleOf(m)) === "v4", 15000)),
    String(await titleOf(m)),
  );

  // 4) 页面关掉之后改文件不出错，其余页面照常
  const closed = await api(
    "POST",
    `/workspaces/${ws.id}/browser/pages/${a}/close`,
    {},
  );
  if (closed.status !== 204) throw new Error(`关页面失败 ${closed.status}`);
  await sleep(500);
  writeFileSync(page, html(5));
  check(
    "关掉一个页面后再改文件：不出错，其余页面照常刷新（v5）",
    !!(await until(async () => (await titleOf(m)) === "v5", 15000)) &&
      (await pagesOf()).every((p) => p.id !== a),
    String(await titleOf(m)),
  );
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
  `\n文件变化自动刷新：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
