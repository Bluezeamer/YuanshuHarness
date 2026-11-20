// 真 Chromium 的端到端：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 页面全部经测试自己的代理加载（site.test 只有代理认识），顺带验证「流量确实走了代理」。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { Engine } from "./engine.js";
import type { BrowserCtx, PageFileChooser, PageHandle } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";
const SITE = "site.test";
const INNER_SITE = "inner.test"; // 与 SITE 不同源：给跨源 iframe 用
// 剪贴板夹具要用 loopback 的来源：Chromium 只把 loopback 与 https 当安全上下文，而
// `navigator.clipboard` 只在安全上下文里存在。这里的端口是假的：请求由测试代理回环给出，不连本机端口。
const CLIP_ORIGIN = "http://127.0.0.1:18080";
const CLIP_INNER_ORIGIN = "http://127.0.0.1:18081"; // 端口不同 → 跨源

const PAGE = `<!doctype html><meta charset=utf-8><title>计数页</title>
<button id="inc">加一</button><div id="count">0</div>
<button id="redraw">重画</button>
<input id="text" value="旧内容"><div id="out">未提交</div>
<button id="log">写日志</button>
<button id="boom">抛异常</button>
<button id="fail">失败请求</button>
<button id="popup">开新页</button>
<button id="push">同页导航</button>
<button id="hit" style="position:absolute;left:600px;top:300px;width:120px;height:40px">坐标按钮</button>
<input id="ime" style="position:absolute;left:600px;top:400px;width:200px;height:30px">
<div id="box" style="position:absolute;left:0;top:600px;width:200px;height:100px;background:#c33"></div>
<script>
  const $ = (id) => document.getElementById(id);
  $("inc").onclick = () => { $("count").textContent = String(Number($("count").textContent) + 1) };
  $("redraw").onclick = () => {
    document.body.innerHTML = '<button id="after">新按钮</button><div id="count">99</div>';
  };
  $("text").addEventListener("keydown", (e) => { if (e.key === "Enter") $("out").textContent = "提交:" + e.target.value });
  $("log").onclick = () => console.log("日志 " + location.origin + "/cb?token=abc");
  $("boom").onclick = () => { throw new Error("页面里的异常") };
  $("fail").onclick = () => { fetch("http://blocked.test/fail?token=abc").catch(() => {}) };
  $("popup").onclick = () => { window.open("/child", "_blank") };
  $("push").onclick = () => { history.pushState({}, "", "/pushed") };
  $("hit").onclick = () => { $("count").textContent = "42" };
  let x = 0;
  setInterval(() => { x = (x + 7) % 300; $("box").style.transform = "translateX(" + x + "px)" }, 16);
</script>`;

const PROBE = `<!doctype html><meta charset=utf-8><title>探针</title><div id="out"></div>
<script>
  document.getElementById("out").textContent =
    "webdriver=" + navigator.webdriver + " ua=" + navigator.userAgent;
</script>`;

// 静止页面：合成器不会自己出帧，专门用来验证推流在页面不动时也有首帧、变化后也有新帧。
const STILL = `<!doctype html><meta charset=utf-8><title>静止页</title>
<button id="b" style="width:300px;height:100px" onclick="document.body.style.background='#9c9'">变色</button>`;

// 三处都能划选：正文、输入框、跨源 iframe；位置写死，用鼠标三击选中一整段 / 一整行。
const SELECT = `<!doctype html><meta charset=utf-8><title>选区页</title>
<p style="position:absolute;left:20px;top:20px;margin:0">页面正文一段</p>
<input style="position:absolute;left:20px;top:80px;width:200px;height:30px" value="输入框里的字">
<iframe src="http://${INNER_SITE}/inner" style="position:absolute;left:20px;top:140px;width:300px;height:60px;border:0"></iframe>`;
const INNER = `<!doctype html><meta charset=utf-8><p style="margin:0;padding:8px">跨源框里的字</p>`;

const STORE = `<!doctype html><meta charset=utf-8><title>存登录态</title><div id="out">setting</div>
<script>
  document.cookie = "sid=abc123; path=/";
  localStorage.setItem("k", "v");
  const req = indexedDB.open("db1", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("s");
  req.onsuccess = () => {
    const tx = req.result.transaction("s", "readwrite");
    tx.objectStore("s").put("idbval", "key");
    tx.oncomplete = () => { document.getElementById("out").textContent = "done"; };
  };
</script>`;

const READ = `<!doctype html><meta charset=utf-8><title>读登录态</title><div id="out">reading</div>
<script>
  localStorage.setItem("probe", "1");
  const req = indexedDB.open("db1", 1);
  req.onsuccess = () => {
    let idb = "none";
    try {
      const tx = req.result.transaction("s", "readonly");
      const get = tx.objectStore("s").get("key");
      get.onsuccess = () => {
        idb = String(get.result);
        document.getElementById("out").textContent =
          "cookie=" + document.cookie + " ls=" + localStorage.getItem("k") + " idb=" + idb;
      };
    } catch {
      idb = "error";
    }
  };
</script>`;

// 读回 seed 补进去的登录态：cookie 与 localStorage 都写进 DOM。
const SEEDED = `<!doctype html><meta charset=utf-8><title>补登录态后</title>
<div id="out"></div>
<script>
  document.getElementById("out").textContent =
    "cookie=" + document.cookie + " ls=" + localStorage.getItem("seed-k") + "," + localStorage.getItem("seed-k2");
</script>`;

// 下载夹具：固定字节（逐字节比对用，含不可打印字节与非 ASCII 文件名）。
const DOWNLOAD_BYTES = Buffer.from(
  "PK\x03\x04yuanshu-download-\u0000\u0001\u00ff-tail",
);
// 上传夹具：可见的多文件 input、隐藏 input + 按钮、只收一个文件的 input、不是上传入口的按钮。
// change 里把文件名与内容（base64）写进 DOM，用来断言浏览器拿到的是原文件名与原字节。
const UPLOAD_BYTES = Buffer.from("\x00\x01yuanshu-upload-\u00ff-tail");
const UPLOAD = `<!doctype html><meta charset=utf-8><title>上传页</title>
<input id="multi" type="file" multiple aria-label="多文件上传">
<input id="hidden" type="file" style="display:none">
<button id="trigger" onclick="document.getElementById('hidden').click()">选隐藏的文件</button>
<input id="single" type="file" aria-label="单文件上传">
<div style="position:relative;display:inline-block">
  <input id="covered" type="file" aria-label="被盖住的上传">
  <div style="position:absolute;inset:0;background:rgba(0,0,0,.1)"></div>
</div>
<button id="plain">不是上传入口</button>
<button id="late" onclick="lateRead()">稍后读取</button>
<button id="redraw" onclick="document.body.replaceChildren(document.createTextNode('重画完毕'))">重画</button>
<div id="out"></div>
<script>
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  // 选完文件、稍后才读（真实表单的提交就是这样）：此时源文件可能早已不在磁盘上
  const lateRead = async () => {
    const f = document.getElementById("multi").files[0];
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      document.getElementById("out").textContent = "late:" + f.name + "|" + b64(buf);
    } catch (e) {
      document.getElementById("out").textContent = "late-error:" + e.name;
    }
  };
  for (const id of ["multi", "hidden", "single", "covered"]) {
    document.getElementById(id).addEventListener("change", async (e) => {
      const parts = [];
      for (const f of e.target.files) {
        const buf = new Uint8Array(await f.arrayBuffer());
        parts.push(f.name + "|" + b64(buf) + "|" + f.type);
      }
      document.getElementById("out").textContent = id + ":" + parts.join(",");
    });
  }
</script>`;

const DOWNLOAD = `<!doctype html><meta charset=utf-8><title>下载页</title>
<a id="att" href="/file/attachment">下载附件</a>
<button id="blob">存一份 blob</button>
<script>
  document.getElementById("blob").onclick = async () => {
    const res = await fetch("/file/blob");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "blob.bin";
    document.body.appendChild(a);
    a.click();
  };
</script>`;

// 动作夹具：悬停出子项、内部可滚动容器、远处按钮（验证 ref 会先滚进视口）、页面底部。
// 滚动位置写进标题，测试靠 title() 读（快照里的数字不好稳定解析）。
const ACTION = `<!doctype html><meta charset=utf-8><title>动作页</title>
<body style="margin:0">
<div id="menu" role="button" tabindex="0" aria-label="悬停菜单" style="position:absolute;left:100px;top:100px;width:200px;height:40px">悬停菜单</div>
<div id="sub" style="display:none;position:absolute;left:100px;top:150px"><a href="/child">子项一</a></div>
<div id="scroller" aria-label="内部容器" style="position:absolute;left:500px;top:100px;width:300px;height:200px;overflow:auto">
  <div style="height:1500px">容器里的长内容</div>
</div>
<button id="push" aria-label="页内跳转" style="position:absolute;left:0;top:200px" onclick="history.pushState({}, '', '/pushed')">页内跳转</button>
<div role="button" tabindex="0" aria-label="远处按钮" style="position:absolute;left:0;top:3000px;width:200px;height:40px" onmouseenter="document.getElementById('tip').textContent='远处被悬停'">远处按钮</div>
<div id="tip" aria-label="提示" style="position:absolute;left:0;top:3080px">未悬停</div>
<div id="bottom" aria-label="底部" style="position:absolute;left:0;top:3500px;width:1280px;height:100px">底部</div>
<script>
  document.getElementById("menu").addEventListener("mouseenter", () => {
    document.getElementById("sub").style.display = "block";
  });
  const show = () => {
    document.title = "y:" + window.scrollY + " box:" + document.getElementById("scroller").scrollTop;
  };
  // 元素的 scroll 事件不冒泡，用捕获阶段收。
  addEventListener("scroll", show, true);
  show();
</script>
</body>`;

// 点击夹具：双击区、一段文字（三击选中）、右键区。
const CLICK = `<!doctype html><meta charset=utf-8><title>点击页</title>
<body style="margin:0">
<div id="dbl" role="button" tabindex="0" aria-label="双击区" style="position:absolute;left:20px;top:20px;width:200px;height:60px">双击区</div>
<p id="para" style="position:absolute;left:20px;top:120px;width:300px;margin:0">三击选中整段文字</p>
<div id="ctx" role="button" tabindex="0" aria-label="右键区" style="position:absolute;left:20px;top:220px;width:200px;height:60px">右键区</div>
<div id="out" aria-label="输出">双击:0 右键:0</div>
<script>
  const counts = { dblclick: 0, contextmenu: 0 };
  const show = () => { document.getElementById("out").textContent = "双击:" + counts.dblclick + " 右键:" + counts.contextmenu; };
  document.getElementById("dbl").addEventListener("dblclick", () => { counts.dblclick++; show() });
  document.getElementById("ctx").addEventListener("contextmenu", (e) => { e.preventDefault(); counts.contextmenu++; show() });
</script>`;

// 输入夹具：统计输入框上的 keydown / keyup / input 次数，回车写提交结果。
const TYPE = `<!doctype html><meta charset=utf-8><title>输入页</title>
<input id="a" aria-label="输入框甲" value="旧内容">
<div id="keys" aria-label="按键统计">keydown:0 keyup:0 input:0</div>
<div id="out" aria-label="提交结果">未提交</div>
<script>
  const keys = { keydown: 0, keyup: 0, input: 0 };
  const show = () => { document.getElementById("keys").textContent = "keydown:" + keys.keydown + " keyup:" + keys.keyup + " input:" + keys.input };
  const el = document.getElementById("a");
  el.addEventListener("keydown", (e) => {
    keys.keydown++;
    if (e.key === "Enter") document.getElementById("out").textContent = "提交:" + el.value;
    show();
  });
  el.addEventListener("keyup", () => { keys.keyup++; show() });
  el.addEventListener("input", () => { keys.input++; show() });
</script>`;

// 拖放夹具：两列原生拖放互换；range 滑块。
const DRAG = `<!doctype html><meta charset=utf-8><title>拖动页</title>
<div id="cols" style="display:flex;gap:20px;padding:20px">
  <div class="col" id="a" draggable="true" role="button" aria-label="列甲" style="width:120px;height:120px">甲</div>
  <div class="col" id="b" draggable="true" role="button" aria-label="列乙" style="width:120px;height:120px">乙</div>
</div>
<div id="order" aria-label="顺序">顺序:甲乙</div>
<input id="range" type="range" min="1" max="5" value="1" aria-label="滑块" style="position:absolute;left:40px;top:300px;width:400px">
<div id="val" aria-label="滑块值">值:1</div>
<script>
  const cols = document.getElementById("cols");
  const show = () => { document.getElementById("order").textContent = "顺序:" + [...cols.children].map((c) => c.textContent).join(""); };
  for (const c of cols.children) {
    c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", c.id); });
    c.addEventListener("dragover", (e) => e.preventDefault());
    c.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = document.getElementById(e.dataTransfer.getData("text/plain"));
      const to = e.currentTarget;
      if (from === to) return;
      cols.insertBefore(from, to.nextSibling);
      show();
    });
  }
  const r = document.getElementById("range");
  r.addEventListener("input", () => { document.getElementById("val").textContent = "值:" + r.value; });
</script>`;

// 图片地址夹具：普通图、data: 占位图（带 data-src，懒加载前 src 是占位）、svg role=img、<picture>。
// 页脚按钮把占位图的 src 换成 /b.png，用来验证「地址变了」。
const IMG = `<!doctype html><meta charset=utf-8><title>图片页</title>
<img alt="普通图" src="/a.png">
<img id="lazy" alt="占位图" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="/b.png">
<svg role="img" aria-label="矢量图" width="20" height="20"><rect width="20" height="20"></rect></svg>
<picture><source srcset="/c.webp" type="image/webp"><img alt="picture 里的图" src="/c.png"></picture>
<button onclick="document.getElementById('lazy').src = '/b.png'">换成真图</button>`;

// 控制台夹具：刷屏同一句、一条 error、一条未捕获异常（带位置）。
const CONSOLE = `<!doctype html><meta charset=utf-8><title>控制台页</title>
<button id="flood" onclick="for (let i = 0; i < 60; i++) console.warn('poll failed'); console.error('boom'); setTimeout(() => { throw new Error('定时器炸了') }, 0)">刷屏</button>`;

// 剪贴板夹具：六种复制路径 + 跨源 iframe 里的复制 + 没授权时读剪贴板。
// 每个可点元素的名字都互不包含，测试靠快照里的名字取编号。
const CLIP = `<!doctype html><meta charset=utf-8><title>剪贴板页</title>
<button id="w" onclick="navigator.clipboard.writeText('写剪贴板的结果')">写剪贴板</button>
<textarea id="ta">文本域内容</textarea><button id="sel" onclick="ta.select();document.execCommand('copy')">复制文本域</button>
<button id="ev" onclick="document.addEventListener('copy',e=>{e.clipboardData.setData('text/plain','事件改写的结果');e.preventDefault()},{once:true});document.execCommand('copy')">复制事件改写</button>
<p id="para" style="margin:0">正文一段</p>
<button id="ci" onclick="navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['ClipboardItem 的结果'],{type:'text/plain'})})])">写 ClipboardItem</button>
<button id="late" onclick="setTimeout(()=>navigator.clipboard.writeText('稍后写的结果'),1500)">稍后写</button>
<button id="rd" onclick="navigator.clipboard.readText().then(t=>{out.textContent='读剪贴板:成功 '+t},e=>{out.textContent='读剪贴板:拒绝 '+e.name})">读剪贴板</button>
<div id="out"></div>
<iframe src="${CLIP_INNER_ORIGIN}/clip-inner" style="position:absolute;left:600px;top:400px;width:300px;height:60px;border:0"></iframe>`;
const CLIP_INNER = `<!doctype html><meta charset=utf-8><body style="margin:0"><button id="in" style="width:300px;height:40px" onclick="navigator.clipboard.writeText('跨源框里的结果')">框里复制</button>`;

// 整页截图夹具：比视口高的页面 / 超过 30000 的页面；长快照夹具（>4 万字符）。
const TALL = `<!doctype html><meta charset=utf-8><title>高页</title><body style="margin:0"><div style="height:3000px">很长</div><div aria-label="结尾">结尾</div></body>`;
const HUGE = `<!doctype html><meta charset=utf-8><title>超高页</title><body style="margin:0"><div style="height:45000px">超高</div></body>`;
// 区域截图夹具：文档 y=700–760 是一条红带，滚到 y=700 之后视口顶部就是红带。
const REGION = `<!doctype html><meta charset=utf-8><title>区域页</title><body style="margin:0"><div style="height:700px">上</div><div style="height:60px;background:rgb(204,0,0)">红带</div><div style="height:3000px">下</div></body>`;
const LONG = `<!doctype html><meta charset=utf-8><title>长页</title><ul>${Array.from(
  { length: 1500 },
  (_, i) => `<li><button>第 ${i} 项 文字填充填充填充填充</button></li>`,
).join("")}</ul>`;

interface Harness {
  proxyPort: number;
  sitePort: number;
  proxied: number;
  close(): Promise<void>;
}

// 最简 HTTP 代理：只转发明文 HTTP。site.test、inner.test 与 loopback（剪贴板夹具）→ 本地测试站点，
// blocked.test → 直接掐断（造失败的请求），其余 502。
async function startHarness(): Promise<Harness> {
  const pages: Record<string, string> = {
    "/child": "<title>子页</title><p>child</p>",
    "/action": ACTION,
    "/click": CLICK,
    "/type": TYPE,
    "/drag": DRAG,
    "/tall": TALL,
    "/huge": HUGE,
    "/region": REGION,
    "/long": LONG,
    "/download": DOWNLOAD,
    "/upload": UPLOAD,
    "/probe": PROBE,
    "/still": STILL,
    "/select": SELECT,
    "/inner": INNER,
    "/store": STORE,
    "/read": READ,
    "/seeded": SEEDED,
    "/deny": PAGE,
    "/console": CONSOLE,
    "/img": IMG,
    "/clip": CLIP,
    "/clip-inner": CLIP_INNER,
  };
  // 下载端点：/file/attachment 带 Content-Disposition；/file/blob 给 JS 里 a.click() 用。
  const file = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/file/attachment") {
      res.writeHead(200, {
        "content-type": "application/zip",
        // HTTP 头只能放 ASCII：中文名用 RFC 5987 的 filename*
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("报告.zip")}`,
      });
      res.end(DOWNLOAD_BYTES);
      return true;
    }
    if (req.url === "/file/blob") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(DOWNLOAD_BYTES);
      return true;
    }
    return false;
  };
  const site = http.createServer((req, res) => {
    if (file(req, res)) return;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[req.url ?? "/"] ?? PAGE);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  const sitePort = (site.address() as AddressInfo).port;

  let proxied = 0;
  const proxy = http.createServer((req, res) => {
    proxied++;
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.hostname === "blocked.test") {
      req.socket.destroy();
      return;
    }
    if (
      url.hostname !== SITE &&
      url.hostname !== INNER_SITE &&
      url.hostname !== "127.0.0.1"
    ) {
      res.writeHead(502).end("unknown host");
      return;
    }
    const up = http.request(
      {
        host: "127.0.0.1",
        port: sitePort,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, {
          ...r.headers,
          ...(url.pathname === "/deny"
            ? { "x-yuanshu-deny": "internal-address" }
            : {}),
        });
        r.pipe(res);
      },
    );
    up.on("error", () => res.writeHead(502).end("upstream"));
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    proxyPort,
    sitePort,
    get proxied() {
      return proxied;
    },
    close: async () => {
      proxy.closeAllConnections();
      site.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await new Promise<void>((r) => site.close(() => r()));
    },
  };
}

// 本进程直接起的浏览器主进程（/proc 里父进程是 vitest worker、可执行文件是 EXE）。
function browserPids(): number[] {
  const out: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const status = readFileSync(`/proc/${d}/status`, "utf8");
      if (Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]) !== process.pid)
        continue;
      const cmd =
        readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0")[0] ?? "";
      if (cmd === EXE) out.push(Number(d));
    } catch {
      // 进程刚退：跳过
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 浏览器临时目录（playwright 每次启动建一个）里的文件名：取消后要看有没有留下下载的文件。
function artifactFiles(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith("playwright-artifacts")) continue;
    for (const f of readdirSync(path.join(tmpdir(), name))) out.push(f);
  }
  return out;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(30);
  }
  return false;
}

const refOf = (snap: string, label: string): string => {
  const line = snap.split("\n").find((l) => l.includes(label));
  const ref = line ? /\[ref=(\w+)\]/.exec(line)?.[1] : undefined;
  if (!ref) throw new Error(`快照里找不到「${label}」的编号：\n${snap}`);
  return ref;
};

/** 解出 PNG 的像素（用于验证区域截图真的截到了那块）：只认 8 位、非隔行的 RGB / RGBA。 */
function pngPixels(png: Buffer): {
  width: number;
  height: number;
  at(x: number, y: number): number[];
} {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const parts: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const kind = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error("只支持 8 位 PNG");
      colorType = data[9] ?? 0;
    } else if (kind === "IDAT") parts.push(data);
    else if (kind === "IEND") break;
    off += 12 + len;
  }
  if (colorType !== 2 && colorType !== 6)
    throw new Error(`不支持的 PNG 颜色类型 ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(parts));
  const out = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++] ?? 0;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev =
      y === 0
        ? Buffer.alloc(stride)
        : out.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      const x = line[i] ?? 0;
      cur[i] =
        filter === 0
          ? x
          : filter === 1
            ? (x + a) & 0xff
            : filter === 2
              ? (x + b) & 0xff
              : filter === 3
                ? (x + ((a + b) >> 1)) & 0xff
                : (x + paeth(a, b, c)) & 0xff;
    }
  }
  return {
    width,
    height,
    at(x, y) {
      const i = (y * width + x) * bpp;
      return [out[i] ?? 0, out[i + 1] ?? 0, out[i + 2] ?? 0];
    },
  };
}

describe.skipIf(!enabled)("引擎（真实 Chromium）", () => {
  let engine: Engine;
  let harness: Harness;
  let ctx: BrowserCtx;

  const ctxOptions = () => ({
    proxy: {
      server: `http://127.0.0.1:${harness.proxyPort}`,
      username: "ctx-token",
      password: "proxy-pass",
    },
  });

  const openCtx = (
    storageState?: Awaited<ReturnType<BrowserCtx["storageState"]>>,
  ) =>
    engine.context({
      ...ctxOptions(),
      ...(storageState ? { storageState } : {}),
    });

  const page = async (path = "/"): Promise<PageHandle> => {
    const p = await ctx.newPage();
    await p.goto(`http://${SITE}${path}`);
    return p;
  };

  /** 剪贴板夹具用 loopback 源（只有它才是安全上下文），页面同样由测试代理给。 */
  const clipPage = async (): Promise<PageHandle> => {
    const p = await ctx.newPage();
    await p.goto(`${CLIP_ORIGIN}/clip`);
    return p;
  };

  beforeAll(async () => {
    if (!enabled) return;
    harness = await startHarness();
    engine = new Engine({
      dataDir: makeTmpDir("ys-engine-live-"),
      env: { ...process.env, YUANSHU_BROWSER: EXE },
      log: () => {},
    });
    ctx = await engine.context(ctxOptions());
  });

  afterAll(async () => {
    if (!enabled) return;
    await ctx?.close().catch(() => {});
    await engine?.close().catch(() => {});
    await harness?.close().catch(() => {});
  });

  test("① 启动成功、报告沙箱状态、页面经代理加载", async () => {
    const state = engine.state();
    expect(state.status).toBe("ready");
    expect(state.executable).toBe(EXE);
    expect(state.sandbox).not.toBeNull();
    console.log("沙箱状态：", JSON.stringify(state.sandbox));
    const p = await page();
    expect(await p.title()).toBe("计数页");
    expect(harness.proxied).toBeGreaterThan(0);
  });

  test("② ensure() 并发只启动一次", async () => {
    const before = browserPids().length;
    const fresh = new Engine({
      dataDir: makeTmpDir("ys-engine-live-"),
      env: { ...process.env, YUANSHU_BROWSER: EXE },
      log: () => {},
    });
    try {
      await Promise.all([
        fresh.ensure(),
        fresh.ensure(),
        fresh.ensure(),
        fresh.ensure(),
      ]);
      expect(fresh.state().status).toBe("ready");
      expect(browserPids()).toHaveLength(before + 1);
    } finally {
      await fresh.close();
    }
    expect(browserPids()).toHaveLength(before);
  });

  test("③ 带编号快照 → click 点到（计数器变了）", async () => {
    const p = await page();
    const snap = await p.snapshot();
    expect(snap).toMatch(/\[ref=e\d+\]/);
    await p.click(refOf(snap, "加一"));
    expect(await p.snapshot()).toContain('"1"');
    await p.click(refOf(await p.snapshot(), "加一"));
    expect(await p.snapshot()).toContain('"2"');
  });

  test("④ 页面变化后旧编号在 2 秒内报「编号已失效」", async () => {
    const p = await page();
    const snap = await p.snapshot();
    const inc = refOf(snap, "加一");
    await p.click(refOf(snap, "重画"));
    await sleep(200);
    const t = Date.now();
    const err = (await p.click(inc).catch((e) => e)) as Error;
    const ms = Date.now() - t;
    expect(err.message).toContain("编号已失效");
    expect(ms).toBeLessThan(2000);
  }, 15_000);

  test("⑤ type 替换内容并回车提交，空串清空", async () => {
    const p = await page();
    const ref = refOf(await p.snapshot(), "旧内容");
    await p.type(ref, "新内容", { submit: true, perKey: false });
    const after = await p.snapshot();
    expect(after).toContain("提交:新内容");
    expect(after).not.toContain("旧内容");
    await p.type(ref, "", { submit: true, perKey: false });
    const cleared = await p.snapshot();
    expect(cleared).toContain("提交:");
    expect(cleared).not.toContain("提交:新内容");
  });

  test("⑥ 控制台缓冲收到 console.log、未捕获异常、失败请求，令牌打码", async () => {
    const p = await page();
    const snap = await p.snapshot();
    await p.click(refOf(snap, "写日志"));
    await p.click(refOf(snap, "抛异常"));
    await p.click(refOf(snap, "失败请求"));
    expect(
      await waitFor(() =>
        p
          .console()
          .some((e) => e.kind === "console" && e.text.includes("日志")),
      ),
    ).toBe(true);
    expect(
      await waitFor(() => p.console().some((e) => e.kind === "error")),
    ).toBe(true);
    expect(
      await waitFor(() => p.console().some((e) => e.kind === "request-failed")),
    ).toBe(true);
    const all = p.console();
    const log = all.find(
      (e) => e.kind === "console" && e.text.includes("日志"),
    );
    expect(log?.level).toBe("log");
    expect(log?.text).toContain("token=***");
    expect(log?.text).not.toContain("abc");
    const failed = all.find((e) => e.kind === "request-failed");
    expect(failed?.url).toContain("token=***");
    expect(failed?.url).not.toContain("abc");
    // 按时间升序
    const ts = all.map((e) => e.ts);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  test("⑥b 控制台折叠：同一句刷屏只占一组并计数，页面异常带首帧位置", async () => {
    const p = await page("/console");
    await p.click(refOf(await p.snapshot(), "刷屏"));
    expect(
      await waitFor(() =>
        p.console().some((e) => e.kind === "error" && e.url !== undefined),
      ),
    ).toBe(true);
    const list = p.console();
    const flood = list.find((e) => e.text === "poll failed");
    expect(flood).toMatchObject({ kind: "console", level: "warn", count: 60 });
    expect(flood?.firstTs).toBeLessThanOrEqual(flood?.ts ?? 0);
    // 组编号唯一
    expect(new Set(list.map((e) => e.id)).size).toBe(list.length);
    const err = list.find((e) => e.kind === "error");
    expect(err?.text).toContain("定时器炸了");
    expect(err?.url).toMatch(/^http:\/\/site\.test\/console:\d+$/);
    // console.error 与页面异常是两组（级别 / 类别不同），刷屏也没把它们挤掉
    expect(
      list.some(
        (e) => e.kind === "console" && e.level === "error" && e.text === "boom",
      ),
    ).toBe(true);
    expect(p.consoleEvicted()).toBe(0);
  }, 20_000);

  test("⑥c onConsole 在计数增加时也回调，payload 是组当前状态", async () => {
    const p = await page("/console");
    const counts: number[] = [];
    const off = p.onConsole((e) => {
      if (e.text === "poll failed") counts.push(e.count);
    });
    await p.click(refOf(await p.snapshot(), "刷屏"));
    expect(await waitFor(() => counts.length > 0)).toBe(true);
    await waitFor(() => counts.at(-1) === 60);
    off();
    expect(counts[0]).toBe(1);
    // 同一个组编号贯穿始终
    expect(counts.at(-1)).toBe(60);
  }, 20_000);

  test("⑥d 剪贴板：writeText / execCommand / copy 事件改写 / 真实 Ctrl+C / ClipboardItem / 异步写 / 跨源 iframe 都能读到", async () => {
    const p = await clipPage();
    expect(await p.copied()).toBeNull();
    const text = async () => (await p.copied())?.text ?? null;
    /** 跑一次动作，等复制读到想要的文字（异步写的场景要等）。 */
    const untilCopied = async (
      run: () => Promise<void>,
      want: string | ((t: string | null) => boolean),
    ) => {
      await run();
      for (let i = 0; i < 100; i++) {
        const t = await text();
        if (typeof want === "string" ? t === want : want(t)) return true;
        await sleep(50);
      }
      return false;
    };
    const click = async (label: string, count: 1 | 2 | 3 = 1) =>
      p.click(refOf(await p.snapshot(), label), { count });

    expect(await untilCopied(() => click("写剪贴板"), "写剪贴板的结果")).toBe(
      true,
    );
    expect(await untilCopied(() => click("复制文本域"), "文本域内容")).toBe(
      true,
    );
    expect(
      await untilCopied(() => click("复制事件改写"), "事件改写的结果"),
    ).toBe(true);
    // 真实 Ctrl+C：三击选中整段正文
    expect(
      await untilCopied(
        async () => {
          await click("正文一段", 3);
          await p.press("Control+C");
        },
        (t) => t?.startsWith("正文一段") ?? false,
      ),
    ).toBe(true);
    expect(
      await untilCopied(
        () => click("写 ClipboardItem"),
        "ClipboardItem 的结果",
      ),
    ).toBe(true);
    // 点完 1.5 秒才异步写：等它到达
    expect(await untilCopied(() => click("稍后写"), "稍后写的结果")).toBe(true);
    // 跨源 iframe 里的复制：鼠标真点进那个框
    expect(
      await untilCopied(async () => {
        for (const action of ["down", "up"] as const)
          await p.input({
            type: "mouse",
            action,
            x: 650,
            y: 420,
            button: "left",
            clickCount: 1,
          });
      }, "跨源框里的结果"),
    ).toBe(true);
  }, 60_000);

  test("⑥e 上下文没有剪贴板权限：页面自己读剪贴板被拒绝", async () => {
    const p = await clipPage();
    await p.click(refOf(await p.snapshot(), "读剪贴板"));
    for (let i = 0; i < 100; i++) {
      if ((await p.snapshot()).includes("读剪贴板:拒绝")) break;
      await sleep(50);
    }
    expect(await p.snapshot()).toContain("读剪贴板:拒绝 NotAllowedError");
  });

  test("⑦ startScreencast 限帧、关闭后不再来帧", async () => {
    const p = await page();
    let frames = 0;
    await p.startScreencast(
      { maxWidth: 1280, maxHeight: 800, maxFps: 5, quality: 50 },
      (jpeg) => {
        expect(jpeg.length).toBeGreaterThan(0);
        frames++;
      },
    );
    await sleep(3000);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(20);
    await p.stopScreencast();
    const stopped = frames;
    await sleep(1000);
    expect(frames).toBe(stopped);
  }, 15_000);

  test("⑦b 静止页面：开推后有首帧，页面变化后补发新帧", async () => {
    const p = await page("/still");
    // 页面早已画完才开推：这是用户打开页面后才连上画面流的真实时序
    await sleep(800);
    let frames = 0;
    await p.startScreencast(
      { maxWidth: 1280, maxHeight: 800, maxFps: 5, quality: 50 },
      () => {
        frames++;
      },
    );
    expect(await waitFor(() => frames >= 1)).toBe(true);
    await sleep(500);
    const settled = frames;
    await p.input({ type: "mouse", action: "move", x: 100, y: 50 });
    await p.input({
      type: "mouse",
      action: "down",
      x: 100,
      y: 50,
      button: "left",
      clickCount: 1,
    });
    await p.input({
      type: "mouse",
      action: "up",
      x: 100,
      y: 50,
      button: "left",
      clickCount: 1,
    });
    expect(await waitFor(() => frames > settled)).toBe(true);
    await p.stopScreencast();
  }, 15_000);

  test("⑧ input 的鼠标坐标与中文 insertText", async () => {
    const p = await page();
    await p.input({ type: "mouse", action: "move", x: 660, y: 320 });
    await p.input({
      type: "mouse",
      action: "down",
      x: 660,
      y: 320,
      button: "left",
      clickCount: 1,
    });
    await p.input({
      type: "mouse",
      action: "up",
      x: 660,
      y: 320,
      button: "left",
      clickCount: 1,
    });
    expect(await p.snapshot()).toContain("42");
    await p.input({ type: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 10 });
    await p.click(refOf(await p.snapshot(), "旧内容"));
    await p.input({ type: "text", text: "中文测试abc" });
    expect(await p.snapshot()).toContain("中文测试abc");
  });

  test("⑧c selection：正文、输入框、跨源 iframe 里选中的文字；没选中是空串；只认焦点所在的文档", async () => {
    const p = await page("/select");
    expect(await p.selection()).toBe("");
    const triple = async (x: number, y: number) => {
      for (const action of ["down", "up"] as const)
        await p.input({
          type: "mouse",
          action,
          x,
          y,
          button: "left",
          clickCount: 3,
        });
    };
    await triple(40, 28);
    expect(await p.selection()).toBe("页面正文一段");
    await triple(60, 95);
    expect(await p.selection()).toBe("输入框里的字");
    await triple(60, 160);
    expect(await p.selection()).toBe("跨源框里的字");
    // 焦点回到主文档：iframe 里留着的旧选区不能再出来
    await triple(40, 28);
    expect(await p.selection()).toBe("页面正文一段");
  });

  test("⑧b 没有前置 move 的点击：先移到目标位置再按下（位置没变才省掉这次移动）", async () => {
    const p = await page();
    const at = { x: 700, y: 415 }; // 输入框 ime 的中间
    const click = async () => {
      for (const action of ["down", "up"] as const)
        await p.input({
          type: "mouse",
          action,
          ...at,
          button: "left",
          clickCount: 1,
        });
    };
    await click();
    await p.input({ type: "text", text: "直接点" });
    expect(await p.snapshot()).toContain("直接点");
  });

  test("⑨ navigator.webdriver 不为 true，UA 不含 Headless", async () => {
    const p = await page("/probe");
    const snap = await p.snapshot();
    expect(snap).toContain("webdriver=false");
    expect(snap).not.toContain("Headless");
    expect(snap).toContain("Chrome/");
  });

  test("⑩ window.open 触发 onPopup，opener 正确", async () => {
    const popups: PageHandle[] = [];
    const off = ctx.onPopup((p) => popups.push(p));
    const p = await page();
    await p.click(refOf(await p.snapshot(), "开新页"));
    expect(await waitFor(() => popups.length > 0)).toBe(true);
    off();
    const popup = popups[0];
    expect(popup?.opener).toBe(p);
    expect(await waitFor(() => popup?.url().endsWith("/child") ?? false)).toBe(
      true,
    );
    expect(await popup?.title()).toBe("子页");
  }, 15_000);

  test("⑪ goto 带回代理的 deny 头", async () => {
    const p = await page();
    const r = await p.goto(`http://${SITE}/deny`);
    expect(r.status).toBe(200);
    expect(r.deny).toBe("internal-address");
  });

  test("⑭ 页内 pushState 不会让加载状态卡在 loading", async () => {
    const p = await page();
    await p.click(refOf(await p.snapshot(), "同页导航"));
    expect(await waitFor(() => p.url().endsWith("/pushed"))).toBe(true);
    await sleep(300);
    expect(p.loading()).toBe(false);
  });

  // —— 动作原语：鼠标位置、move、scroll、drag、click、type、截图、后退前进 ——

  const scrollState = async (p: PageHandle) => {
    const t = await p.title();
    return {
      y: Number(/y:(\d+)/.exec(t)?.[1] ?? -1),
      box: Number(/box:(\d+)/.exec(t)?.[1] ?? -1),
    };
  };

  test("㉝ 鼠标位置：初始 null，move 后有值；页内跳转不清，主框架导航后清空", async () => {
    const p = await page("/action");
    expect(p.mouse()).toBeNull();
    await p.move({ x: 10, y: 20 });
    expect(p.mouse()).toEqual({ x: 10, y: 20 });
    // 页内跳转（pushState）不清
    await p.click(refOf(await p.snapshot(), "页内跳转"));
    expect(await waitFor(() => p.url().endsWith("/pushed"))).toBe(true);
    expect(p.mouse()).not.toBeNull();
    await p.move({ x: 30, y: 40 });
    await sleep(300);
    expect(p.mouse()).toEqual({ x: 30, y: 40 });
    // 主框架整页导航清空
    await p.goto(`http://${SITE}/action`);
    expect(p.mouse()).toBeNull();
  }, 20_000);

  test("㉞ move：hover 出菜单的子项；ref 在视口外会先滚进来", async () => {
    const p = await page("/action");
    const snap = await p.snapshot();
    expect(snap).not.toContain("子项一");
    await p.move({ ref: refOf(snap, "悬停菜单") });
    expect(await p.snapshot()).toContain("子项一");
    // 远处按钮在 top:3000：ref 先滚到可见处，mouseenter 改了提示文字
    await p.move({ ref: refOf(await p.snapshot(), "远处按钮") });
    expect(await p.snapshot()).toContain("远处被悬停");
    expect((await scrollState(p)).y).toBeGreaterThan(0);
  }, 20_000);

  test("㉟ scroll：to 把底部滚进视口；direction 缺省滚一屏；at 指容器时滚容器不滚页面", async () => {
    const p = await page("/action");
    await p.scroll({ to: refOf(await p.snapshot(), "底部") });
    expect(await p.snapshot()).toContain("底部");
    expect((await scrollState(p)).y).toBeGreaterThan(0);

    await p.goto(`http://${SITE}/action`);
    await p.scroll({ direction: "down" });
    const one = await scrollState(p);
    expect(one.y).toBeGreaterThan(700);
    expect(one.y).toBeLessThan(900);
    expect(one.box).toBe(0);

    await p.goto(`http://${SITE}/action`);
    await p.scroll({
      direction: "down",
      at: { ref: refOf(await p.snapshot(), "内部容器") },
    });
    const inner = await scrollState(p);
    expect(inner.box).toBeGreaterThan(0);
    expect(inner.y).toBe(0);
  }, 30_000);

  test("㊱ drag：HTML5 原生拖放两列互换；range 滑块拖到约 80%", async () => {
    const p = await page("/drag");
    const snap = await p.snapshot();
    expect(snap).toContain("顺序:甲乙");
    await p.drag({ ref: refOf(snap, "列甲") }, { ref: refOf(snap, "列乙") });
    expect(await p.snapshot()).toContain("顺序:乙甲");

    // 滑块：从元素中心拖到轨道宽度的 80% 处（滑块从左端跟过去，值约 4/5）
    // 夹具里滑块在 left:40 top:300 宽 400，所以终点是 (360, ~310)。
    const before = await p.snapshot();
    expect(before).toContain("值:1");
    await p.drag({ ref: refOf(before, "滑块") }, { x: 360, y: 310 });
    const value = Number(/值:(\d)/.exec(await p.snapshot())?.[1] ?? "0");
    expect(value).toBeGreaterThanOrEqual(4);
  }, 30_000);

  test("㊲ drag：起点或终点不在视口内报错", async () => {
    const p = await page("/drag");
    const err = (await p
      .drag({ ref: refOf(await p.snapshot(), "列甲") }, { x: 100, y: 5000 })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("不在视口内");
  }, 20_000);

  test("㊳ click：双击 / 三击选中 / 右键；点 ref 后鼠标位置是元素中心", async () => {
    const p = await page("/click");
    const snap = await p.snapshot();
    await p.click(refOf(snap, "双击区"), { count: 2 });
    expect(await p.snapshot()).toContain("双击:1");
    // 双击区在 left:20 top:20 宽 200 高 60：点完鼠标位置是它的中心。
    expect(p.mouse()).toEqual({ x: 120, y: 50 });

    await p.click(refOf(await p.snapshot(), "三击选中整段文字"), { count: 3 });
    expect(await p.selection()).toBe("三击选中整段文字");

    await p.click(refOf(await p.snapshot(), "右键区"), { button: "right" });
    expect(await p.snapshot()).toContain("右键:1");
  }, 30_000);

  test("㊴ clickAt：点当前鼠标位置与坐标；没有位置时报错", async () => {
    const p = await page("/click");
    const err = (await p.clickAt(null).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("还没有鼠标位置");
    await p.move({ ref: refOf(await p.snapshot(), "双击区") });
    await p.clickAt(null, { count: 2 });
    expect(await p.snapshot()).toContain("双击:1");
    // 右键区在 left:20 top:220 宽 200 高 60
    await p.clickAt({ x: 100, y: 250 }, { button: "right" });
    expect(await p.snapshot()).toContain("右键:1");
    expect(p.mouse()).toEqual({ x: 100, y: 250 });
  }, 20_000);

  const counts = (snap: string) => ({
    keydown: Number(/keydown:(\d+)/.exec(snap)?.[1] ?? -1),
    keyup: Number(/keyup:(\d+)/.exec(snap)?.[1] ?? -1),
    input: Number(/input:(\d+)/.exec(snap)?.[1] ?? -1),
  });

  test("㊵ type：带 ref 逐键每个字符都有 keydown / keyup，并且替换内容；fill 只触发 input", async () => {
    const p = await page("/type");
    const ref = refOf(await p.snapshot(), "输入框甲");
    await p.type(ref, "abc", { submit: false, perKey: true });
    const after = await p.snapshot();
    expect(after).toContain("abc");
    expect(after).not.toContain("旧内容");
    // 逐键 3 个字符 + 全选的 Control+a（两个 keydown / keyup）
    expect(counts(after)).toMatchObject({ keydown: 5, keyup: 5, input: 3 });

    // 整段：只触发 input，不触发 keydown / keyup（缺省路径的已知行为）
    await p.type(ref, "整段", { submit: false, perKey: false });
    const filled = await p.snapshot();
    expect(filled).toContain("整段");
    expect(counts(filled)).toMatchObject({ keydown: 5, keyup: 5, input: 4 });
  }, 30_000);

  test("㊶ type：不带 ref 逐键输入到聚焦元素；带 ref 空串逐键是清空", async () => {
    const p = await page("/type");
    const ref = refOf(await p.snapshot(), "输入框甲");
    await p.click(ref);
    await p.type(null, "追加", { submit: false, perKey: true });
    expect(await p.snapshot()).toContain("旧内容追加");
    await p.type(ref, "", { submit: false, perKey: true });
    expect(await p.snapshot()).not.toContain("旧内容");
  }, 30_000);

  test("㊷ screenshotFull：比视口高的页面报真实高度；超过 30000 只截 30000", async () => {
    const tall = await page("/tall");
    const shot = await tall.screenshotFull();
    expect(shot.fullHeight).toBeGreaterThan(3000);
    expect(shot.fullHeight).toBe(shot.height);
    expect(shot.width).toBe(1280);
    expect(shot.bytes.length).toBeGreaterThan(0);

    const huge = await page("/huge");
    const capped = await huge.screenshotFull();
    expect(capped.fullHeight).toBeGreaterThan(30_000);
    expect(capped.height).toBe(30_000);
    expect(capped.bytes.length).toBeGreaterThan(0);
  }, 60_000);

  test("㊷ screenshotRect：clip 是视口坐标，滚到 y=700 后 (0,0)-(49,39) 截到红带", async () => {
    const p = await page("/region");
    const moved = await p.scroll({ direction: "down", amount: 700 });
    expect(moved.after.y).toBe(700);
    const png = await p.screenshotRect({ x: 0, y: 0, width: 50, height: 40 });
    const px = pngPixels(png);
    expect(px.width).toBe(50);
    expect(px.height).toBe(40);
    // 红带落在文档 y=700–760：视口顶部就是它，中心像素应为红
    const [r, g, b] = px.at(25, 20) as [number, number, number];
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  }, 30_000);

  test("㊷b scroll 返回页面位置：高页面一屏 700，文档高度对得上", async () => {
    const p = await page("/action");
    const { before, after } = await p.scroll({
      direction: "down",
      amount: 700,
    });
    expect(before.y).toBe(0);
    expect(after.y).toBe(700);
    expect(after.height).toBeGreaterThan(3500);
    expect(after.viewHeight).toBe(800);
    expect(after.viewWidth).toBe(1280);
    expect(after.width).toBe(1280);
  }, 30_000);

  test("㊷c 鼠标落在内部滚动容器上：页面 y 不变（只验返回值）", async () => {
    const p = await page("/action");
    const at = refOf(await p.snapshot(), "内部容器");
    const { before, after } = await p.scroll({
      direction: "down",
      amount: 700,
      at: { ref: at },
    });
    expect(before.y).toBe(0);
    expect(after.y).toBe(0);
    expect(await p.snapshot()).toContain("容器里的长内容");
  }, 30_000);

  test("㊸ back / forward：没有历史返回 false 且页面不变；有历史返回 true；页内跳转也算", async () => {
    const p = await page("/action");
    await p.goto(`http://${SITE}/click`);
    expect(await p.back()).toBe(true); // → /action
    expect(p.url()).toContain("/action");
    expect(await p.forward()).toBe(true); // → /click
    expect(p.url()).toContain("/click");
    expect(await p.back()).toBe(true); // → /action
    // 再退就是 goto 之前的 about:blank：不算上一页，页面不动
    expect(await p.back()).toBe(false);
    expect(p.url()).toContain("/action");

    // 页内跳转（pushState）也进历史
    await p.goto(`http://${SITE}/action`);
    await p.click(refOf(await p.snapshot(), "页内跳转"));
    expect(await waitFor(() => p.url().endsWith("/pushed"))).toBe(true);
    expect(await p.back()).toBe(true);
    expect(await waitFor(() => p.url().endsWith("/action"))).toBe(true);
  }, 30_000);

  test("㊹ snapshot 不截断：长页面（>4 万字符）原样返回", async () => {
    const p = await page("/long");
    const snap = await p.snapshot();
    expect(snap.length).toBeGreaterThan(40_000);
    expect(snap).not.toContain("快照已截断");
  }, 30_000);

  test("㊹b snapshot 给 img 节点写地址：普通图带绝对地址、占位图是 data: 描述、svg 没有 /src 行；换了 src 之后地址变了", async () => {
    const p = await page("/img");
    const snap = await p.snapshot();
    expect(snap).toContain(`- img "普通图" [ref=e2]:`);
    expect(snap).toContain(`- /src: http://${SITE}/a.png`);
    // data: 占位图只写 mime 与长度，不写 base64
    expect(snap).toMatch(
      /- img "占位图" \[ref=e3\]:\n\s+- \/src: data:image\/gif \(\d+ chars\)/,
    );
    // svg role=img 不是 <img>：没有地址，也就没有 /src 行
    const svg = snap.split("\n").find((l) => l.includes("矢量图")) ?? "";
    expect(svg).not.toContain("/src");
    // <picture> 里的 <img> 照写它此刻的 currentSrc
    expect(snap).toMatch(
      new RegExp(
        `- img "picture 里的图" [^\\n]*:\\n\\s+- /src: http://${SITE}/c\\.(webp|png)`,
      ),
    );
    expect(snap.match(/- \/src: /g)).toHaveLength(3);

    // 懒加载把占位图换成真图：再取快照，地址跟着变。刚换完时浏览器可能还没解析出 currentSrc，
    // 这时读到的是属性里的相对地址（读取规则就是 currentSrc 优先、退回 src 属性），两种都算变了。
    await p.click(refOf(snap, "换成真图"));
    const after = await p.snapshot();
    expect(after).toMatch(
      new RegExp(
        `- img "占位图" \\[ref=e3\\]:\\n\\s+- /src: (http://${SITE})?/b\\.png`,
      ),
    );
    expect(after).not.toContain("data:image/gif");
  }, 30_000);

  // —— 下载 ——

  /** 等页面上下一次 download 事件（订阅 unwrap 由调用方持有）。 */
  const nextDownload = (p: PageHandle) =>
    new Promise<Parameters<Parameters<PageHandle["onDownload"]>[0]>[0]>(
      (resolve) => {
        const off = p.onDownload((d) => {
          off();
          resolve(d);
        });
      },
    );

  test("⑯ 点链接下载（Content-Disposition: attachment）：订阅者收到，存出来的字节与站点发出的逐字节相同", async () => {
    const p = await page("/download");
    const waiting = nextDownload(p);
    await p.click(refOf(await p.snapshot(), "下载附件"));
    const d = await waiting;
    expect(d.filename).toBe("报告.zip");
    expect(d.url).toContain(`http://${SITE}/file/attachment`);
    const dest = `${makeTmpDir("ys-engine-dl-")}/got.bin`;
    expect(await d.saveTo(dest, { maxBytes: 1 << 20, timeoutMs: 10_000 })).toBe(
      DOWNLOAD_BYTES.length,
    );
    expect(readFileSync(dest).equals(DOWNLOAD_BYTES)).toBe(true);
  }, 30_000);

  test("⑰ JS 里 a.click() 触发的 blob 下载：同样收到并可存", async () => {
    const p = await page("/download");
    const waiting = nextDownload(p);
    await p.click(refOf(await p.snapshot(), "存一份 blob"));
    const d = await waiting;
    expect(d.filename).toBe("blob.bin");
    const dest = `${makeTmpDir("ys-engine-dl-")}/blob.bin`;
    await d.saveTo(dest, { maxBytes: 1 << 20, timeoutMs: 10_000 });
    expect(readFileSync(dest).equals(DOWNLOAD_BYTES)).toBe(true);
  }, 30_000);

  test("⑱ goto 直接打开下载地址：不抛错、返回 { status: null }，订阅者在 goto 返回前就收到", async () => {
    const p = await page();
    const got: string[] = [];
    let seenBeforeReturn = false;
    const off = p.onDownload((d) => {
      got.push(d.filename);
      seenBeforeReturn = !returned;
    });
    let returned = false;
    const r = await p.goto(`http://${SITE}/file/attachment`);
    returned = true;
    off();
    expect(r).toEqual({ status: null, deny: null });
    expect(got).toEqual(["报告.zip"]);
    expect(seenBeforeReturn).toBe(true);
    // loading 照常复位
    expect(p.loading()).toBe(false);
  }, 30_000);

  test("⑲ 没有订阅者：下载被取消，控制台缓冲里留一条「已取消下载」", async () => {
    const p = await page();
    // 没有订阅者时 goto 不会等下载，直接返回
    expect(await p.goto(`http://${SITE}/file/attachment`)).toEqual({
      status: null,
      deny: null,
    });
    expect(
      await waitFor(() =>
        p.console().some((e) => e.text.startsWith("已取消下载 报告.zip")),
      ),
    ).toBe(true);
    const entry = p
      .console()
      .find((e) => e.text.startsWith("已取消下载 报告.zip"));
    expect(entry?.level).toBe("warn");
    expect(entry?.text).toContain("没有人处理下载");
  }, 30_000);

  test("⑳ 超过 maxBytes：丢弃并抛「文件太大」，订阅者拿不到字节", async () => {
    const p = await page("/download");
    const waiting = nextDownload(p);
    await p.click(refOf(await p.snapshot(), "下载附件"));
    const d = await waiting;
    const dest = `${makeTmpDir("ys-engine-dl-")}/small.bin`;
    const err = (await d
      .saveTo(dest, { maxBytes: 4, timeoutMs: 10_000 })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("文件太大");
    expect(existsSync(dest)).toBe(false);
  }, 30_000);

  test("㉑ cancel 之后：文件没有留在磁盘上，再 saveTo 抛错", async () => {
    const p = await page("/download");
    const waiting = nextDownload(p);
    const before = artifactFiles();
    await p.click(refOf(await p.snapshot(), "下载附件"));
    const d = await waiting;
    await d.cancel("用户没有批准");
    expect(
      await waitFor(() => artifactFiles().every((f) => before.includes(f))),
    ).toBe(true);
    const err = (await d
      .saveTo(`${makeTmpDir("ys-engine-dl-")}/late.bin`, {
        maxBytes: 1 << 20,
        timeoutMs: 10_000,
      })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("已取消");
    expect(
      p.console().some((e) => e.text === "已取消下载 报告.zip：用户没有批准"),
    ).toBe(true);
  }, 30_000);

  // —— 上传 ——

  /** 交给 upload 的文件：内容固定、名字按用例给。 */
  const file = (name: string, bytes = UPLOAD_BYTES) => ({
    name,
    buffer: bytes,
  });
  const b64 = (bytes: Buffer) => bytes.toString("base64");

  /** 等快照里出现某个串：change 处理是异步读文件的，发完文件不能立刻断言。 */
  const shown = async (p: PageHandle, needle: string): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      if ((await p.snapshot()).includes(needle)) return true;
      await sleep(30);
    }
    return false;
  };

  test("㉒ 可见的 <input type=file>：upload 后页面收到原文件名与原字节", async () => {
    const p = await page("/upload");
    await p.upload(refOf(await p.snapshot(), "多文件上传"), [file("报告.bin")]);
    expect(await shown(p, `multi:报告.bin|${b64(UPLOAD_BYTES)}|`)).toBe(true);
  });

  test("㉒b 上传之后源文件被删：页面稍后再读，内容仍在（不能只记路径）", async () => {
    const p = await page("/upload");
    // 模拟「调用方交完文件就把源文件删掉」：内容已交出去，页面之后读仍要拿到原字节。
    const src = file("稍后.bin");
    await p.upload(refOf(await p.snapshot(), "多文件上传"), [src]);
    src.buffer = Buffer.alloc(0);
    await p.click(refOf(await p.snapshot(), "稍后读取"));
    expect(await shown(p, `late:稍后.bin|${b64(UPLOAD_BYTES)}`)).toBe(true);
  }, 20_000);

  test("㉓ 隐藏的 input：ref 指按钮，走「点击 + 选择框」路径", async () => {
    const p = await page("/upload");
    await p.upload(refOf(await p.snapshot(), "选隐藏的文件"), [
      file("藏着的.bin"),
    ]);
    expect(await shown(p, `hidden:藏着的.bin|${b64(UPLOAD_BYTES)}|`)).toBe(
      true,
    );
  }, 20_000);

  test("㉓b 被别的元素盖住的 input：ref 指到 input 本身时直接设文件（点它不会弹选择框）", async () => {
    const p = await page("/upload");
    await p.upload(refOf(await p.snapshot(), "被盖住的上传"), [
      file("盖住的.bin"),
    ]);
    expect(await shown(p, `covered:盖住的.bin|${b64(UPLOAD_BYTES)}|`)).toBe(
      true,
    );
  }, 20_000);

  test("㉔ ref 指到不是上传入口的元素：报没有文件选择框，不超过 6 秒", async () => {
    const p = await page("/upload");
    const ref = refOf(await p.snapshot(), "不是上传入口");
    const t = Date.now();
    const err = (await p
      .upload(ref, [file("a.bin")])
      .catch((e: unknown) => e)) as Error;
    const ms = Date.now() - t;
    expect(err.message).toContain("没有出现文件选择框");
    expect(ms).toBeLessThan(6000);
  }, 20_000);

  test("㉕ 多个文件交给只收一个的入口：报只接受一个文件", async () => {
    const p = await page("/upload");
    const ref = refOf(await p.snapshot(), "单文件上传");
    const err = (await p
      .upload(ref, [file("a.bin"), file("b.bin")])
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("只接受一个文件");
  });

  test("㉖ 编号失效：先报编号已失效", async () => {
    const p = await page("/upload");
    const ref = refOf(await p.snapshot(), "多文件上传");
    await p.click(refOf(await p.snapshot(), "重画"));
    const err = (await p
      .upload(ref, [file("a.bin")])
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("编号已失效");
  });

  test("㉗ .txt 文件：mimeType 留空时浏览器按扩展名推断出 text/plain", async () => {
    const p = await page("/upload");
    await p.upload(refOf(await p.snapshot(), "多文件上传"), [
      file("说明.txt", Buffer.from("纯文本")),
    ]);
    expect(await shown(p, "multi:说明.txt|")).toBe(true);
    const snap = await p.snapshot();
    expect(snap).toContain(
      `|${Buffer.from("纯文本").toString("base64")}|text/plain`,
    );
  });

  // —— 用户页上的文件选择（用户自己点「选择文件」）——

  /** 等一次 filechooser 事件：订阅后点页面上的上传入口。 */
  const nextChooser = (p: PageHandle) =>
    new Promise<PageFileChooser>((resolve) => {
      const off = p.onFileChooser((c) => {
        off();
        resolve(c);
      });
    });

  test("㉘ 用户页：接住选择框交两个文件（含中文名），页面收到原名字与逐字节相同的内容", async () => {
    const p = await page("/upload");
    const waiting = nextChooser(p);
    await p.click(refOf(await p.snapshot(), "多文件上传"));
    const chooser = await waiting;
    expect(chooser.multiple).toBe(true);
    const one = Buffer.from("第一份内容");
    const two = Buffer.from([0, 1, 255]);
    await chooser.setFiles([
      { name: "报告.txt", buffer: one },
      { name: "第二份.bin", buffer: two },
    ]);
    expect(await shown(p, "multi:")).toBe(true);
    const out = await p.snapshot();
    expect(out).toContain(`报告.txt|${b64(one)}|`);
    expect(out).toContain(`第二份.bin|${b64(two)}|`);
  }, 20_000);

  test("㉙ 订阅了但不交文件（用户取消）：页面保持没有文件", async () => {
    const p = await page("/upload");
    const seen: PageFileChooser[] = [];
    const off = p.onFileChooser((c) => void seen.push(c));
    await p.click(refOf(await p.snapshot(), "多文件上传"));
    expect(await waitFor(() => seen.length === 1)).toBe(true);
    // 选择框就这么关掉（没人调 setFiles）；页面不该有任何 change。
    await sleep(300);
    expect(await p.snapshot()).not.toContain("multi:");
    off();
  }, 20_000);

  test("㉚ 没有订阅者：点上传入口不报错，页面照旧", async () => {
    const p = await page("/upload");
    await p.click(refOf(await p.snapshot(), "多文件上传"));
    await sleep(300);
    expect(await p.snapshot()).not.toContain("multi:");
  }, 20_000);

  test("⑫ 杀掉浏览器进程触发 onCrash，再 context() 能重启", async () => {
    let crashed = 0;
    const off = engine.onCrash(() => crashed++);
    const pids = browserPids();
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) process.kill(pid, "SIGKILL");
    expect(await waitFor(() => crashed > 0, 10_000)).toBe(true);
    off();
    expect(engine.state().status).toBe("idle");
    ctx = await openCtx();
    const p = await page();
    expect(await p.title()).toBe("计数页");
  }, 30_000);

  test("⑬ storageState 拿到 cookie 与 localStorage，并能注入新上下文", async () => {
    await page("/store");
    await sleep(300);
    const state = await ctx.storageState();
    expect(
      state.cookies.some((c) => c.name === "sid" && c.value === "abc123"),
    ).toBe(true);
    const origin = state.origins.find((o) => o.origin === `http://${SITE}`);
    expect(
      origin?.localStorage.some((e) => e.name === "k" && e.value === "v"),
    ).toBe(true);
    // playwright-core 1.65 的 BrowserContext.storageState 类型里 origins 没有 indexedDB
    // （只有 APIRequestContext 那份有），运行时确实带，这里按运行时的形状断言。
    const idb = (origin as { indexedDB?: unknown[] } | undefined)?.indexedDB;
    expect(idb?.length ?? 0).toBeGreaterThan(0);

    const ctx2 = await openCtx(state);
    try {
      const read = await ctx2.newPage();
      await read.goto(`http://${SITE}/read`);
      expect(await waitFor(() => read.url().endsWith("/read"))).toBe(true);
      await sleep(500);
      const snap = await read.snapshot();
      expect(snap).toContain("cookie=sid=abc123");
      expect(snap).toContain("ls=v");
      expect(snap).toContain("idb=idbval");
    } finally {
      await ctx2.close();
    }
  }, 20_000);

  test("㉛ seed：登录态补进已存在的上下文，临时页不被收养、不留下页面", async () => {
    const target = await openCtx();
    try {
      // 临时页按源开、请求不出网：这里数一数 onPopup 有没有被叫过。
      let popups = 0;
      const off = target.onPopup(() => popups++);
      await target.seed({
        cookies: [
          {
            name: "seeded",
            value: "yes",
            domain: SITE,
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [
          {
            origin: `http://${SITE}`,
            localStorage: [
              { name: "seed-k", value: "v1" },
              { name: "seed-k2", value: "v2" },
            ],
          },
        ],
      });
      await sleep(300);
      expect(popups).toBe(0);

      const p = await target.newPage();
      await p.goto(`http://${SITE}/seeded`);
      expect(await waitFor(() => p.url().endsWith("/seeded"))).toBe(true);
      await sleep(300);
      expect(await p.snapshot()).toContain("cookie=seeded=yes");
      expect(await p.snapshot()).toContain("ls=v1,v2");
      // seed 之后上下文照常能开页面（临时页已经关掉了），也没多出被收养的页面
      expect(popups).toBe(0);
      off();
    } finally {
      await target.close();
    }
  }, 20_000);

  test("㉜ seed：空状态什么都不做、不抛错", async () => {
    const target = await openCtx();
    try {
      await expect(
        target.seed({ cookies: [], origins: [] }),
      ).resolves.toBeUndefined();
      await expect(
        target.seed({
          cookies: [],
          origins: [{ origin: `http://${SITE}`, localStorage: [] }],
        }),
      ).resolves.toBeUndefined();
    } finally {
      await target.close();
    }
  }, 20_000);
});
