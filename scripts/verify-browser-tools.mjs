// 工具面重设计的真机检查：真 Chromium + 本地假站点，进程内直接用构建产物里的模块（同 verify-browser.mjs），不起 Server、不用模型。
//  1) move：悬停才出现的菜单，移上去后内容里多出链接，移开后消失；
//  2) scroll：滚到底触发懒加载，新增的条目出现在 diff 里；ACTION 行写页面位置，到底 / 没动都如实说；
//     加载要 700ms 的无限滚动：滚动之后有限等内容变化，新条目在同一次返回里、耗时远小于上限；
//  3) drag：拖滑块，值变了；
//  4) click：count=3 选中整段文字（页面里的 selection 为证）；无目标点当前鼠标位置；
//  5) type：缺省整段插入触发不了只听 keyup 的页面，perKey 能；
//  6) nav：后退 / 前进 / 刷新，最前面没有上一页时报错；地址变了写 URL 行；
//  7) 统一机制：点击后无变化给 NO CHANGES，有变化给确定性 diff，`ACTION:` 行与 PAGE ID 行；
//  8) 页面剪贴板：页面写剪贴板后下一次返回内容带 CLIPBOARD 行，只带一次；
//  9) 控制台：相同消息折叠成 ×n，level 过滤；
// 10) 截图：视口截图是 1280×800 的 JPEG 且不压缩，元素与区域是 PNG（区域宽高含两端、角点先后任意），整页是 JPEG；read=false 不给图；
// 11) 展示：browser_show 广播给订阅的界面，没有订阅者时如实说没送达；handoff 按页面操作者定方向。
// 12) 快照里的图片地址与链接目标：占位图 / 普通图带当前地址，换图与换链接目标都进 diff；browser_dom 按 selector / ref / 整个文档读原始 DOM
//     （data-src、无标签 video、热区、shadow、iframe、form action、download），并且不动 diff 基线；
// 13) browser_network：列表 / 过滤 / after 游标 / 单条详情（地址与头原样）、请求体与响应体（文本、二进制附件）、失败请求、不存在的编号。
// 19) browser_emulate 与 browser_cdp：深色 / 语言 / 时区 / UA 模拟在页面里读得到、整页刷新后仍生效、reset 恢复；cdp 发 Runtime.evaluate、不存在的方法给一行报错。
// 18) browser_route：mock 让接口返回造出来的 500、block 让图片失败、patch 替换真实响应里的文字并去掉头、list 的命中次数、remove 后恢复。
// 17) browser_request：带页面的 cookie 与出口发请求、不自动加头、3xx 不跟随与 follow、命名身份的隔离罐。
// 16) 开发调试组：browser_exec 读页面变量 / 序列化 / 抛异常 / 带 ref；browser_storage 读 HttpOnly Cookie（页面脚本读不到）、写删 Cookie、Web 存储。
// 前提：已构建 server（packages/server/dist）。浏览器取 YUANSHU_BROWSER；没设时用 playwright-core 装的那份，再没有就由引擎自己下载。
// 用法：node scripts/verify-browser-tools.mjs   （SHOW=1 顺带打印每一步工具的返回）
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentChromePath } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/server/dist");
const load = (p) => import(join(dist, p));

const guard = setTimeout(() => {
  console.error("verify-browser-tools 超时（240 秒）");
  process.exit(2);
}, 240_000);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "browser-tools-"));
mkdirSync(join(base, "data"), { recursive: true });

// —— 假站点 ——
const pages = {
  "/hover": `<!doctype html><title>悬停</title>
    <div id="m" style="padding:20px" onmouseenter="document.getElementById('menu').hidden=false" onmouseleave="document.getElementById('menu').hidden=true">
      <button>菜单</button>
      <ul id="menu" hidden><li><a href="/p1">个人资料</a></li></ul>
    </div>
    <p>页面其余内容</p>`,
  "/scroll": `<!doctype html><title>懒加载</title>
    <style>body{margin:0} .row{height:120px;border-bottom:1px solid #ccc;font:20px sans-serif}</style>
    <div id="list"></div>
    <script>
      let n = 0;
      const add = () => { for (let i = 0; i < 10; i++) { const d = document.createElement('div'); d.className = 'row'; d.textContent = '条目 ' + (++n); document.getElementById('list').appendChild(d); } };
      add();
      addEventListener('scroll', () => { if (n < 30 && scrollY + innerHeight >= document.body.scrollHeight - 100) add(); });
    </script>`,
  // 加载慢：滚到底后 fetch 700ms 才回来，回来才追加（滚动之后有限等内容，新内容要在同一次返回里）
  "/scroll-slow": `<!doctype html><title>慢加载</title>
    <style>body{margin:0} .row{height:120px;border-bottom:1px solid #ccc;font:20px sans-serif}</style>
    <div id="list"></div>
    <script>
      let n = 0, loading = false;
      const add = (texts) => { for (const t of texts) { const d = document.createElement('div'); d.className = 'row'; d.textContent = t; document.getElementById('list').appendChild(d); } };
      add(Array.from({ length: 10 }, () => '条目 ' + (++n)));
      addEventListener('scroll', () => {
        if (loading || scrollY + innerHeight < document.body.scrollHeight - 100) return;
        loading = true;
        fetch('/api/more?ms=700').then((r) => r.json()).then(() => { add(Array.from({ length: 10 }, () => '条目 ' + (++n))); loading = false; });
      });
    </script>`,
  "/drag": `<!doctype html><title>拖滑块</title>
    <input id="r" type="range" min="0" max="5" value="0" aria-label="进度" style="position:absolute;left:40px;top:300px;width:400px">
    <p id="out" style="position:absolute;top:100px">值 0</p>
    <script>
      const r = document.getElementById('r');
      r.addEventListener('input', () => { document.getElementById('out').textContent = '值 ' + r.value; });
    </script>`,
  "/click3": `<!doctype html><title>三击</title>
    <p id="p1">第一段：这是一整段需要三击选中的文字。</p>
    <p id="p2">第二段：另一段文字。</p>`,
  "/keyup": `<!doctype html><title>只认按键</title>
    <input id="q" aria-label="搜索词">
    <button id="go" disabled>搜索</button>
    <script>
      // 只听 keyup：整段插入不会触发它，逐键才会。
      document.getElementById('q').addEventListener('keyup', (e) => {
        document.getElementById('go').disabled = e.target.value.length === 0;
      });
    </script>`,
  "/nav-a": `<!doctype html><title>页 A</title><h1>这是页 A</h1><a href="/nav-b">去页 B</a>`,
  "/nav-b": `<!doctype html><title>页 B</title><h1>这是页 B</h1>`,
  "/diff": `<!doctype html><title>变化</title>
    <button id="add" onclick="const d=document.createElement('p');d.textContent='新增的一行：'+(++window.k);document.body.appendChild(d)">添加</button>
    <p>固定内容</p>
    <script>window.k = 0;</script>`,
  "/clip": `<!doctype html><title>分享</title>
    <button id="share" onclick="navigator.clipboard.writeText('https://example.test/share/abc123')">分享</button>`,
  "/console": `<!doctype html><title>控制台</title><h1>刷屏</h1>
    <script>
      for (let i = 0; i < 60; i++) console.error("重复的报错");
      console.warn("一条警告");
      console.log("一条普通日志");
    </script>`,
  "/tall": `<!doctype html><title>长页</title>
    <style>body{margin:0} div{height:2400px;background:linear-gradient(#fff,#9cf)}</style>
    <h1 id="t">很长的页面</h1><div></div>`,
  // 快照读不到的东西：懒加载图（占位 src + data-src）、无标签的 video、热区、shadow、iframe、form action、download、会变的链接目标。
  "/dom": `<!doctype html><title>DOM 页</title>
    <img id="lazy" alt="懒加载图" width="120" height="80" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="/real.png">
    <img id="plain" alt="普通图" width="40" height="40" src="/a.png">
    <img alt="" width="1" height="1" src="/missing.gif">
    <video id="trailer" src="/movie.mp4" poster="/poster.jpg" width="320" height="180"></video>
    <img alt="热区图" src="/a.png" usemap="#areas"><map name="areas"><area shape="rect" coords="0,0,10,10" href="/hot" alt="热区"></map>
    <div id="host"></div>
    <iframe id="frame" src="/dom-inner" width="300" height="100"></iframe>
    <form id="search" action="/search" method="post"><input name="q" aria-label="搜索"></form>
    <a id="dl" href="/file.zip" download="资料.zip">下载资料</a>
    <a id="next" href="/list?page=2">下一页</a>
    <button id="swap" onclick="document.getElementById('lazy').src='/b.png';document.getElementById('next').href='/list?page=3'">换成真图</button>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<video id="inner-video" src="/shadow.mp4" controls></video>';
      fetch('/api/items?token=abc123').then((r) => r.json());
    </script>`,
  "/dom-inner": `<!doctype html><title>框里</title><img alt="框里的图" src="/a.png" width="40" height="40">`,
  // 开发调试：页面变量与 localStorage；服务端另下发一个 HttpOnly 与一个普通 Cookie（见 fixture）。
  "/dev": `<!doctype html><title>开发页</title>
    <button id="go">按钮</button>
    <script>
      window.__state = { a: 1, list: [1, 2], when: 10n ** 3n };
      localStorage.setItem("cart", "3");
    </script>`,
  // 拦截：一张图、一个接口，由 browser_exec 里的 fetch 取。
  "/route": `<!doctype html><title>拦截页</title><img id="pic" src="/a.png" width="20" height="20" alt="图">`,
  // JS 对话框：点按钮弹出 confirm / prompt，把回答写进标题；外加一个 target=_blank 的链接。
  "/dialogs": `<!doctype html><title>对话框</title>
    <button id="del" onclick="document.title = '删除:' + confirm('确定删除吗？')">删除</button>
    <button id="ask" onclick="document.title = '名字:' + prompt('你的名字？', '小明')">改名</button>
    <a href="/nav-b" target="_blank">新窗口打开</a>`,
  // 原生下拉框：单选（带「请选择」空值项与一个禁用项）与多选，选中后把值写进页面。
  "/form": `<!doctype html><title>下拉框</title>
    <select id="city" aria-label="城市">
      <option value="">请选择</option><option value="bj">北京</option><option value="sh">上海</option><option value="gz" disabled>广州</option>
    </select>
    <select id="tags" aria-label="标签" multiple>
      <option value="a">甲</option><option value="b">乙</option><option value="c">丙</option>
    </select>
    <p id="out">未选</p>
    <script>
      const show = () => { document.getElementById('out').textContent = '城市:' + city.value + ' 标签:' + [...tags.selectedOptions].map((o) => o.value).join(','); };
      city.addEventListener('change', show); tags.addEventListener('change', show);
    </script>`,
};
// 1×1 的 PNG：让图片真的加载完成（natural 尺寸、状态码都有）。
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const fixture = http.createServer((req, res) => {
  const path = req.url?.split("?")[0] ?? "/";
  if (path.endsWith(".png")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
    return;
  }
  if (path === "/api/more") {
    const ms = Number(
      new URL(req.url ?? "/", "http://x").searchParams.get("ms") ?? 0,
    );
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    }, ms);
    return;
  }
  if (path === "/api/echo") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          cookie: req.headers.cookie ?? null,
          contentType: req.headers["content-type"] ?? null,
          referer: req.headers.referer ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    return;
  }
  if (path === "/api/login") {
    res.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": "sid=bob-session; Path=/",
    });
    res.end("ok");
    return;
  }
  if (path === "/api/redir") {
    res.writeHead(302, { location: "/api/echo" });
    res.end();
    return;
  }
  if (path === "/api/items") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"items":[1,2]}');
    return;
  }
  const body = pages[path];
  if (!body) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nf");
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    ...(path === "/dev"
      ? {
          "set-cookie": [
            "sid=s3cr3t-http-only; HttpOnly; Path=/",
            "theme=dark; Path=/",
          ],
        }
      : {}),
  });
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
const dirs = () => [{ environmentId: "local", path: base }];
const service = new BrowserService({
  dataDir: join(base, "data"),
  db,
  masterKey: Buffer.alloc(32, 7),
  engine,
  proxy: {
    env: (id) => (id === "local" ? new LocalEnv() : null),
    onDeny: () => {},
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
const saved = [];
const shown = [];
const unsubscribe = service.show.subscribe("w1", (s) => shown.push(s));
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
      return answers.shift() ?? { outcome: "answered", optionId: "done" };
    },
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
    saveAsset: async ({ name, bytes }) => {
      saved.push({ name, size: bytes.length });
      return { marker: `[attach_file] ${name}` };
    },
    // 没有隐私变量：落文件的文字原样放行。
    mask: (text) => text,
    // 压缩设置在这里不参与：视口截图不该走它，其余原样放行。
    modelImage: async (bytes, mimeType) => ({
      mimeType,
      data: bytes.toString("base64"),
    }),
    show: (args) =>
      service.show.publish("w1", { sessionId: "s1", by: "会话 s1", ...args }),
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
const open = async (path) => {
  const r = await run("browser_open", { target: `server:${sitePort}${path}` });
  const pageId = /PAGE ID: (p[a-z0-9]+) · HTTP/.exec(r.text)?.[1];
  return { pageId, text: r.text };
};
const refOf = (text, role, name) =>
  new RegExp(`${role}[^\\n]*"${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(
    text,
  )?.[1] ?? new RegExp(`(e\\d+)[^\\n]*${role}[^\\n]*"${name}"`).exec(text)?.[1];
const handleOf = (pageId) => service.registry.peek(pageId);
const jpegSize = (buf) => {
  // 找 SOF0/SOF2 段：高、宽各两字节。
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3)
      return {
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
      };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
};

try {
  // 1) move：悬停菜单
  {
    const { pageId, text } = await open("/hover");
    const btn = refOf(text, "button", "菜单");
    check("hover 页能取到菜单按钮的编号", Boolean(btn), text.slice(0, 300));
    const moved = (await run("browser_move", { pageId, ref: btn })).text;
    check(
      "move：ACTION 行写 move to <ref>",
      moved.includes(`ACTION: move to ${btn}`),
    );
    check(
      "move：悬停后新增了「个人资料」链接（diff）",
      /\+ e\d+ link "个人资料" → \/p1/.test(moved),
      moved.slice(0, 300),
    );
    const away = (await run("browser_move", { pageId, x: 900, y: 600 })).text;
    check(
      "move：移开后链接消失",
      /- list "个人资料"/.test(away),
      away.slice(0, 300),
    );
    const noMouse = await open("/hover");
    const err = await fails("browser_click", { pageId: noMouse.pageId });
    check(
      "click 无目标且没动过鼠标：报错并提示先 move",
      /browser_move/.test(String(err)),
      String(err),
    );
    await run("browser_move", { pageId: noMouse.pageId, x: 30, y: 30 });
    const atMouse = (await run("browser_click", { pageId: noMouse.pageId }))
      .text;
    check(
      "click 无目标：点当前鼠标位置，ACTION 写出坐标",
      /ACTION: click at mouse \(30,30\)/.test(atMouse),
      atMouse.slice(0, 200),
    );
  }

  // 2) scroll：懒加载
  {
    const { pageId, text } = await open("/scroll");
    check(
      "scroll 页一开始有 10 条",
      text.includes("条目 10") && !text.includes("条目 11"),
      text.slice(-200),
    );
    const scrolled = (
      await run("browser_scroll", { pageId, direction: "down", amount: 3000 })
    ).text;
    check(
      "scroll：ACTION 行带页面位置（y 从 0 滚到哪、总高）",
      /ACTION: scroll down 3000px \(page y 0 → \d+ of \d+\)/.test(scrolled),
      scrolled.slice(0, 200),
    );
    check(
      "scroll：懒加载的新条目出现在内容里",
      scrolled.includes("条目 11"),
      scrolled.slice(0, 300),
    );
    // 这个页面每滚到底部就追加内容（会长高），一次滚不到底：滚到页面不再长高为止，最后一次才是真到底。
    let bottom = "";
    for (let i = 0; i < 6 && !/, at bottom\)/.test(bottom); i++)
      bottom = (
        await run("browser_scroll", { pageId, direction: "down", amount: 3000 })
      ).text;
    check(
      "scroll：滚到底写 at bottom",
      /\(page y \d+ → \d+ of \d+, at bottom\)/.test(bottom),
      bottom.slice(0, 200),
    );
    const stuck = (
      await run("browser_scroll", { pageId, direction: "down", amount: 500 })
    ).text;
    check(
      "scroll：已经到底再滚，写 did not move（不让 agent 以为滚动成功了）",
      /did not move, at bottom/.test(stuck),
      stuck.slice(0, 200),
    );
    const bad = await fails("browser_scroll", {
      pageId,
      to: "e1",
      direction: "down",
    });
    check(
      "scroll：to 与 direction 同给报错",
      /只给一个/.test(String(bad)),
      String(bad),
    );
  }

  // 2b) scroll：加载慢（700ms）的无限滚动，新内容在同一次返回里，不是晚一拍的 NO CHANGES
  {
    const { pageId, text } = await open("/scroll-slow");
    check(
      "慢加载页一开始有 10 条",
      text.includes("条目 10") && !text.includes("条目 11"),
    );
    const t0 = Date.now();
    const slow = (await run("browser_scroll", { pageId, direction: "down" }))
      .text;
    const took = Date.now() - t0;
    check(
      "scroll：加载要 700ms 的无限滚动，新条目就在这一次返回里",
      slow.includes("条目 11") && !slow.includes("NO CHANGES"),
      slow.slice(0, 300),
    );
    check(
      "scroll：等待是有限的（这一页约 1 秒，远小于 2.5 秒上限）",
      took < 2200,
      `${took} ms`,
    );
  }

  // 3) drag：滑块
  {
    const { pageId } = await open("/drag");
    const dragged = (
      await run("browser_drag", {
        pageId,
        fromX: 45,
        fromY: 310,
        toX: 360,
        toY: 310,
      })
    ).text;
    check(
      "drag：ACTION 行",
      dragged.includes("ACTION: drag (45,310) to (360,310)"),
    );
    check(
      "drag：滑块的值变了（diff 里是 0 → 1..5，旁边的文字也跟着变）",
      /~ e\d+ slider "进度": "0" → "[1-5]"/.test(dragged) &&
        /~ paragraph: 值 0 → 值 [1-5]/.test(dragged),
      dragged.slice(0, 300),
    );
  }

  // 4) click count=3：选中整段
  {
    const { pageId } = await open("/click3");
    const handle = handleOf(pageId);
    await run("browser_move", { pageId, x: 120, y: 30 });
    const r = (await run("browser_click", { pageId, x: 120, y: 30, count: 3 }))
      .text;
    check("click：ACTION 行带 ×3", r.includes("click (120,30) ×3"));
    const sel = await handle.selection();
    check(
      "三击选中了整段文字",
      sel.includes("第一段：这是一整段需要三击选中的文字。"),
      JSON.stringify(sel),
    );
    check("三击只选中第一段", !sel.includes("第二段"), JSON.stringify(sel));
  }

  // 5) type perKey
  {
    const { pageId, text } = await open("/keyup");
    const input = refOf(text, "textbox", "搜索词");
    const whole = (
      await run("browser_type", { pageId, ref: input, text: "abc" })
    ).text;
    check(
      "整段输入：只听 keyup 的页面没反应（按钮仍禁用）",
      /button "搜索"[^\n]*\[disabled\]/.test(whole) ||
        !/~ .*button "搜索"/.test(whole),
      whole.slice(0, 300),
    );
    const per = (
      await run("browser_type", {
        pageId,
        ref: input,
        text: "abc",
        perKey: true,
      })
    ).text;
    check("perKey：ACTION 行带 per-key", per.includes("per-key"));
    check(
      "perKey：按钮被启用",
      /button "搜索"/.test(per) &&
        /\[disabled\] → \[-\]|~ e\d+ button "搜索"/.test(per),
      per.slice(0, 400),
    );
    const tooLong = await fails("browser_type", {
      pageId,
      ref: input,
      text: "x".repeat(201),
      perKey: true,
    });
    check(
      "perKey 超 200 字符报错",
      /200/.test(String(tooLong)),
      String(tooLong),
    );
  }

  // 6) nav
  {
    const { pageId, text } = await open("/nav-a");
    const none = await fails("browser_nav", { pageId, action: "back" });
    check(
      "没有上一页时后退报错",
      /没有上一页/.test(String(none)),
      String(none),
    );
    const link = refOf(text, "link", "去页 B");
    const clicked = (await run("browser_click", { pageId, ref: link })).text;
    check(
      "点链接换页：写 URL 行并给完整内容",
      /URL: .*nav-a → .*nav-b/.test(clicked) && clicked.includes("这是页 B"),
      clicked.slice(0, 300),
    );
    const back = (await run("browser_nav", { pageId, action: "back" })).text;
    check(
      "后退：回到页 A，ACTION 写 back",
      back.includes("ACTION: back") && back.includes("这是页 A"),
      back.slice(0, 300),
    );
    const fwd = (await run("browser_nav", { pageId, action: "forward" })).text;
    check("前进：回到页 B", fwd.includes("这是页 B"));
    const re = (await run("browser_nav", { pageId, action: "reload" })).text;
    check(
      "刷新：地址不变，没变化给 NO CHANGES",
      re.includes("ACTION: reload") && re.includes("NO CHANGES"),
      re.slice(0, 300),
    );
  }

  // 7) 统一机制：diff 与 NO CHANGES
  {
    const { pageId, text } = await open("/diff");
    check(
      "open 的外壳：PAGE、ACTION、PAGE ID",
      /^PAGE: 变化 \| /.test(text) &&
        text.includes(`ACTION: open `) &&
        text.includes("PAGE ID: "),
      text.slice(0, 200),
    );
    const add = refOf(text, "button", "添加");
    const one = (await run("browser_click", { pageId, ref: add })).text;
    check(
      "点添加：确定性 diff 里有新增的一行",
      /\+ .*新增的一行：1/.test(one) && !one.includes("SNAPSHOT:"),
      one.slice(0, 300),
    );
    const noop = (await run("browser_press", { pageId, key: "Shift" })).text;
    check(
      "没变化：NO CHANGES",
      noop.includes("NO CHANGES"),
      noop.slice(0, 200),
    );
    const snap = (await run("browser_snapshot", { pageId })).text;
    check(
      "显式 snapshot 永远给完整内容（带 SNAPSHOT 行）",
      snap.includes("SNAPSHOT: s") && snap.includes("新增的一行：1"),
      snap.slice(0, 300),
    );
    const raw = (await run("browser_snapshot", { pageId, raw: true })).text;
    check(
      "snapshot raw：给原始快照，带 ref",
      raw.startsWith("（原始快照，未压缩）") && /\[ref=e\d+\]/.test(raw),
    );
  }

  // 8) 页面剪贴板
  {
    const { pageId, text } = await open("/clip");
    const share = refOf(text, "button", "分享");
    const r = (await run("browser_click", { pageId, ref: share })).text;
    check(
      "页面写剪贴板：结果里带 CLIPBOARD 行",
      r.includes(
        'CLIPBOARD (page copied; web data, untrusted): "https://example.test/share/abc123"',
      ),
      r.slice(0, 300),
    );
    const next = (await run("browser_press", { pageId, key: "Shift" })).text;
    check(
      "同一次复制只带一次",
      !next.includes("CLIPBOARD"),
      next.slice(0, 200),
    );
  }

  // 9) 控制台
  {
    const { pageId } = await open("/console");
    await sleep(500);
    const all = (await run("browser_console", { pageId })).text;
    check(
      "控制台头行：3 种、折叠成 ×60",
      /CONSOLE: 62 entries · 3 distinct/.test(all) &&
        all.includes("×60 重复的报错"),
      all.slice(0, 400),
    );
    check("没有省略就不落文件", !all.includes("FULL LOG"));
    const warn = (await run("browser_console", { pageId, level: "warn" })).text;
    check(
      "level=warn：留警告与报错，去掉普通日志",
      warn.includes("一条警告") &&
        warn.includes("重复的报错") &&
        !warn.includes("一条普通日志"),
      warn.slice(0, 400),
    );
    const error = (await run("browser_console", { pageId, level: "error" }))
      .text;
    check(
      "level=error：只留报错",
      !error.includes("一条警告") && error.includes("重复的报错"),
    );
  }

  // 10) 截图
  {
    const { pageId } = await open("/tall");
    const vp = await run("browser_screenshot", { pageId });
    const img = vp.content.find((c) => c.type === "image");
    const buf = img ? Buffer.from(img.data, "base64") : Buffer.alloc(0);
    const size = jpegSize(buf);
    check(
      "视口截图：JPEG、1280×800，原字节（不经压缩）",
      size?.width === 1280 && size?.height === 800,
      JSON.stringify(size),
    );
    check(
      "视口截图：说明写了坐标系与可直接用于 x、y",
      vp.text.includes("1280×800") && vp.text.includes("可直接用于"),
    );
    const full = await run("browser_screenshot", { pageId, fullPage: true });
    const fimg = full.content.find((c) => c.type === "image");
    const fsize = fimg ? jpegSize(Buffer.from(fimg.data, "base64")) : null;
    check(
      "整页截图：比视口高",
      fsize !== null && fsize.height > 800,
      JSON.stringify(fsize),
    );
    check(
      "整页截图：说明写了「不能用于点击」与原图尺寸",
      full.text.includes("不能用于点击") && /原图 1280×\d+/.test(full.text),
      full.text.slice(0, 200),
    );
    const snap = (await run("browser_snapshot", { pageId })).text;
    const h1 = refOf(snap, "heading", "很长的页面");
    const el = await run("browser_screenshot", { pageId, ref: h1 });
    const eimg = el.content.find((c) => c.type === "image");
    check(
      "元素截图：PNG",
      eimg?.mimeType === "image/png" &&
        Buffer.from(eimg.data, "base64").subarray(1, 4).toString() === "PNG",
      String(eimg?.mimeType),
    );
    check("元素截图：说明写了不是视口截图", el.text.includes("这不是视口截图"));
    const before = saved.length;
    const noRead = await run("browser_screenshot", { pageId, read: false });
    check(
      "read=false：不给图，仍存附件",
      !noRead.content.some((c) => c.type === "image") &&
        saved.length === before + 1,
    );
    const both = await fails("browser_screenshot", {
      pageId,
      ref: h1,
      fullPage: true,
    });
    check(
      "ref 与 fullPage 同给报错",
      /只能给一个/.test(String(both)),
      String(both),
    );

    // 区域：两个视口坐标框一块矩形（角点先后任意），PNG，宽高含两端像素
    const region = await run("browser_screenshot", {
      pageId,
      fromX: 339,
      fromY: 219,
      toX: 100,
      toY: 100,
    });
    const rimg = region.content.find((c) => c.type === "image");
    const rbuf = rimg ? Buffer.from(rimg.data, "base64") : Buffer.alloc(0);
    const isPng = rbuf.subarray(1, 4).toString() === "PNG";
    const rsize = isPng
      ? { width: rbuf.readUInt32BE(16), height: rbuf.readUInt32BE(20) }
      : null;
    check(
      "区域截图：PNG，240×120（角点反序也行）",
      rimg?.mimeType === "image/png" &&
        rsize?.width === 240 &&
        rsize?.height === 120,
      JSON.stringify(rsize),
    );
    check(
      "区域截图：说明写了视口坐标与偏移",
      region.text.includes("视口坐标 (100,100)–(339,219)") &&
        region.text.includes("加上 (100,100)"),
      region.text.slice(0, 200),
    );
    const partial = await fails("browser_screenshot", {
      pageId,
      fromX: 1,
      fromY: 1,
    });
    check(
      "区域缺角报错",
      /同时给 fromX/.test(String(partial)),
      String(partial),
    );
    const mixed = await fails("browser_screenshot", {
      pageId,
      fromX: 1,
      fromY: 1,
      toX: 9,
      toY: 9,
      fullPage: true,
    });
    check(
      "区域与 fullPage 同给报错",
      /只能给一个/.test(String(mixed)),
      String(mixed),
    );
  }

  // 11) 展示与 handoff 方向
  {
    const { pageId } = await open("/nav-a");
    const r = (await run("browser_show", { pageId, note: "看看这个" })).text;
    check("show：送达 1 个界面", r.includes("1 个在线界面"), r);
    check(
      "show：订阅者收到页面信息与说明",
      shown.at(-1)?.pageId === pageId &&
        shown.at(-1)?.note === "看看这个" &&
        shown.at(-1)?.by === "会话 s1",
      JSON.stringify(shown.at(-1)),
    );
    unsubscribe();
    const none = (await run("browser_show", { pageId })).text;
    check(
      "show：没有在线界面时如实说没送达",
      none.includes("没有在线的界面"),
      none,
    );

    // handoff：agent 的页面 → 请用户操作；用户的页面 → agent 请求使用
    answers.push({ outcome: "answered", optionId: "done" });
    const operate = (
      await run("browser_handoff", { pageId, reason: "需要登录" })
    ).text;
    check(
      "handoff（agent 的页面）：卡片是请用户接管",
      asks.at(-1)?.title?.includes("请你接管"),
      asks.at(-1)?.title,
    );
    check(
      "handoff（agent 的页面）：ACTION 写 user finished",
      operate.includes("ACTION: handoff: user finished and returned the page"),
    );
    service.registry.control(pageId, "user");
    answers.push({ outcome: "answered", optionId: "done" });
    const claim = (
      await run("browser_handoff", { pageId, reason: "要继续帮你填表" })
    ).text;
    check(
      "handoff（用户的页面）：卡片是请求使用",
      asks.at(-1)?.title?.includes("请求使用"),
      asks.at(-1)?.title,
    );
    check(
      "handoff（用户的页面）：用户点「交给 agent」后切回 agent",
      service.registry.get(pageId).controller === "agent" &&
        claim.includes("handed the page to the agent"),
      claim.slice(0, 200),
    );
  }

  // 12) 快照里的图片地址与链接目标；browser_dom
  {
    check("26 个浏览器工具都已注册", tools.size === 26, String(tools.size));
    const { pageId, text } = await open("/dom");
    await sleep(400);
    const snap = (await run("browser_snapshot", { pageId })).text;
    check(
      "快照：img 带当前地址（占位图写 mime 与长度，普通图写根相对）",
      /img "懒加载图"[^\n]*→ data:image\/gif \(\d+ chars\)/.test(snap) &&
        /img "普通图"[^\n]*→ \/a\.png/.test(snap),
      snap.slice(0, 600),
    );

    const query = "img, video, area, form, a[download]";
    const bySel = (await run("browser_dom", { pageId, selector: query })).text;
    check(
      "dom selector：data-src 在，占位图的 data: 被写成说明，@natural 能看出是 1x1",
      bySel.includes('data-src="/real.png"') &&
        /src="data:image\/gif \(\d+ chars\)"/.test(bySel) &&
        bySel.includes("@natural=1x1"),
      bySel.slice(0, 800),
    );
    check(
      "dom selector：无标签的 video（src 与 poster）、热区、form action、download 都读得到",
      bySel.includes(
        '<video id="trailer" src="/movie.mp4" poster="/poster.jpg"',
      ) &&
        bySel.includes('<area shape="rect"') &&
        bySel.includes('<form id="search" action="/search" method="post">') &&
        bySel.includes('download="资料.zip"'),
      bySel.slice(0, 1200),
    );
    check(
      "dom selector：穿透 open shadow（shadow 里的 video），并且在 iframe 里另查一遍",
      bySel.includes('<video id="inner-video" src="/shadow.mp4"') &&
        /FRAME \S+\/dom-inner \(positions are inside the frame\):/.test(
          bySel,
        ) &&
        bySel.includes('<img alt="框里的图"'),
      bySel.slice(-700),
    );
    check(
      "dom selector：@box 只在根上、外壳声明规整规则",
      /@box=\d+,\d+,\d+,\d+/.test(bySel) &&
        bySel.includes("NORMALIZED: comments dropped"),
    );

    const next = refOf(text, "link", "下一页");
    const byRef = (await run("browser_dom", { pageId, ref: next })).text;
    check(
      "dom ref：读该元素本身，没有 FRAME 行与 [n] 编号",
      byRef.includes('<a id="next" href="/list?page=2">下一页</a>') &&
        !byRef.includes("FRAME") &&
        !byRef.includes("[1] "),
      byRef.slice(0, 400),
    );

    const whole = (await run("browser_dom", { pageId })).text;
    check(
      "dom 整个文档：有 <html> 与 #shadow-root，iframe 元素在、内容不跟进去",
      whole.includes("QUERY: document") &&
        whole.includes("<html>") &&
        whole.includes("#shadow-root") &&
        whole.includes('<iframe id="frame"') &&
        !whole.includes("框里的图"),
      whole.slice(0, 600),
    );
    check("dom：没有省略就不落文件", !whole.includes("FULL DOM"));
    const syntax = await fails("browser_dom", { pageId, selector: "div[" });
    check(
      "dom：选择器语法错误说人话",
      syntax?.includes("选择器无法解析"),
      syntax ?? "没报错",
    );
    const both = await fails("browser_dom", {
      pageId,
      selector: "img",
      ref: next,
    });
    check(
      "dom：selector 与 ref 只能给一个",
      both?.includes("只能给一个"),
      both ?? "没报错",
    );

    // 13) browser_network（先取游标，再换图，看新请求）
    const list = (await run("browser_network", { pageId })).text;
    const lastId = Number(/last id (\d+)/.exec(list)?.[1] ?? "0");
    check(
      "network 列表：头行写条数与 last id，令牌参数原样，iframe 里的请求有标记",
      /REQUESTS: \d+ in buffer/.test(list) &&
        lastId > 0 &&
        list.includes("/api/items?token=abc123") &&
        !list.includes("token=***") &&
        /\/dom-inner[^\n]*\n/.test(list),
      list.slice(0, 900),
    );
    const onlyFetch = (await run("browser_network", { pageId, type: "fetch" }))
      .text;
    check(
      "network type 过滤：只留 fetch",
      onlyFetch.includes("/api/items") && !onlyFetch.includes("/a.png"),
      onlyFetch.slice(0, 500),
    );
    const failedOnly = (await run("browser_network", { pageId, failed: true }))
      .text;
    check(
      "network failed 过滤：404 的图在，成功的不在",
      failedOnly.includes("/missing.gif") &&
        failedOnly.includes(" 404 ") &&
        !failedOnly.includes("/api/items"),
      failedOnly.slice(0, 500),
    );
    const apiId = /#(\d+) GET fetch 200[^\n]*\/api\/items/.exec(list)?.[1];
    const detail = (await run("browser_network", { pageId, id: Number(apiId) }))
      .text;
    check(
      "network 详情：状态、头、令牌原样、提示怎么取请求体与响应体",
      detail.includes(`REQUEST #${apiId}:`) &&
        detail.includes("STATUS: 200") &&
        detail.includes("REQUEST HEADERS:") &&
        detail.includes("RESPONSE HEADERS:") &&
        detail.includes("token=abc123") &&
        !detail.includes("token=***") &&
        detail.includes("shown exactly as sent and received") &&
        detail.includes('body="response"'),
      detail.slice(0, 600),
    );
    const jsonBody = (
      await run("browser_network", {
        pageId,
        id: Number(apiId),
        body: "response",
      })
    ).text;
    check(
      "network 响应体：JSON 文本整段内联，带 MIME 与大小",
      jsonBody.includes(`BODY #${apiId} response:`) &&
        jsonBody.includes("MIME: application/json") &&
        jsonBody.includes('{"items":[1,2]}') &&
        !jsonBody.includes("FULL BODY:"),
      jsonBody.slice(0, 400),
    );
    const pngId = /#(\d+) GET image 200[^\n]*\/a\.png/.exec(list)?.[1];
    const pngBody = (
      await run("browser_network", {
        pageId,
        id: Number(pngId),
        body: "response",
      })
    ).text;
    check(
      "network 响应体：二进制不内联，存成附件",
      pngBody.includes("MIME: image/png") &&
        pngBody.includes("binary (not shown)") &&
        pngBody.includes("FULL BODY: [attach_file]"),
      pngBody.slice(0, 400),
    );
    const noReqBody = await fails("browser_network", {
      pageId,
      id: Number(apiId),
      body: "request",
    });
    check(
      "network 请求体：GET 没有请求体时说明原因",
      noReqBody?.includes("没有请求体"),
      noReqBody ?? "没报错",
    );
    const bodyAlone = await fails("browser_network", {
      pageId,
      body: "response",
    });
    check(
      "network：只给 body 不给 id 报错",
      bodyAlone?.includes("body 要和 id 一起给"),
      bodyAlone ?? "没报错",
    );
    const missing = await fails("browser_network", { pageId, id: 99999 });
    check(
      "network：编号不在缓冲里报错",
      missing?.includes("没有编号为 99999"),
      missing ?? "没报错",
    );

    // 换图、换链接目标：DOM 读取没有动基线，所以 diff 仍相对打开页面那次
    const swap = refOf(text, "button", "换成真图");
    const swapped = (await run("browser_click", { pageId, ref: swap })).text;
    await sleep(300);
    check(
      "换图：diff 写出新地址与旧地址（占位图 → 真图）",
      /~ e\d+ img "懒加载图" → \/b\.png \(was data:image\/gif \(\d+ chars\)\)/.test(
        swapped,
      ),
      swapped.slice(0, 600),
    );
    check(
      "链接只改查询串：diff 写 → 新 (was 旧)，不是 NO CHANGES",
      /~ e\d+ link "下一页" → \/list\?page=3 \(was \/list\?page=2\)/.test(
        swapped,
      ),
      swapped.slice(0, 600),
    );
    const after = (await run("browser_network", { pageId, after: lastId }))
      .text;
    check(
      "network after 游标：只看到换图之后的新请求",
      after.includes("/b.png") && !after.includes("/api/items"),
      after.slice(0, 500),
    );
  }

  // 14) browser_assets：清单与保存；browser_type 选原生下拉框
  {
    const { pageId } = await open("/dom");
    await sleep(400);
    const list = (await run("browser_assets", { pageId })).text;
    check(
      "assets 清单：缺省只列图片与媒体，行里有类型、mime、大小、尺寸、alt 与地址",
      list.startsWith("ASSETS: DOM 页 | ") &&
        list.includes("SCOPE: type=image,media") &&
        /#\d+ image image\/png 70 B 1×1 alt「[^」]+」 \S+\/a\.png/.test(list),
      list.slice(0, 700),
    );
    const scripts = (
      await run("browser_assets", { pageId, type: "script,stylesheet" })
    ).text;
    check(
      "assets type 过滤：SCOPE 如实写出，没有命中写 No assets matched.",
      scripts.includes("SCOPE: type=script,stylesheet") &&
        (scripts.includes("No assets matched.") || !scripts.includes("a.png")),
      scripts.slice(0, 300),
    );
    const aUrl = /(\S+\/a\.png)/.exec(list)?.[1] ?? "";
    const saved = (
      await run("browser_assets", {
        pageId,
        urls: [aUrl, "/b.png", "/missing.gif", "ftp://x.test/f.bin"],
      })
    ).text;
    check(
      "assets 保存：缓存里的免审批、页面没加载过的同站地址走新请求、404 与非 http(s) 逐个写原因",
      saved.startsWith("Saved 2 of 4 assets") &&
        /\[attach_file\][^\n]*image\/png[^\n]*\/a\.png\n/.test(saved) &&
        /\[attach_file\][^\n]*\/b\.png {2}\(new request\)/.test(saved) &&
        /FAILED \S+\/missing\.gif: HTTP 404/.test(saved) &&
        /FAILED ftp:\/\/x\.test\/f\.bin: /.test(saved),
      saved,
    );
    const many = await fails("browser_assets", {
      pageId,
      urls: Array.from({ length: 31 }, (_, i) => `/x${i}.png`),
    });
    check(
      "assets：一次最多 30 个地址",
      many?.includes("最多 30"),
      many ?? "没报错",
    );

    const form = await open("/form");
    const city = refOf(form.text, "combobox", "城市");
    const tags = refOf(form.text, "listbox", "标签");
    const pick = (
      await run("browser_type", {
        pageId: form.pageId,
        ref: city,
        text: "北京",
      })
    ).text;
    check(
      "type 选下拉框：ACTION 写 select，页面 change 触发",
      pick.includes('ACTION: select "北京" in ') && pick.includes("城市:bj"),
      pick.slice(0, 400),
    );
    const byValue = (
      await run("browser_type", { pageId: form.pageId, ref: city, text: "sh" })
    ).text;
    check(
      "type 选下拉框：也能按 value 匹配",
      byValue.includes("城市:sh"),
      byValue.slice(0, 300),
    );
    const blank = (
      await run("browser_type", { pageId: form.pageId, ref: city, text: "" })
    ).text;
    check(
      "type 选下拉框：空串选「请选择」",
      blank.includes("城市: "),
      blank.slice(0, 300),
    );
    const multi = (
      await run("browser_type", {
        pageId: form.pageId,
        ref: tags,
        text: "甲\n丙",
      })
    ).text;
    check(
      "type 选多选框：换行分隔多项",
      multi.includes('select "甲", "丙" in ') && multi.includes("标签:a,c"),
      multi.slice(0, 300),
    );
    const none = await fails("browser_type", {
      pageId: form.pageId,
      ref: city,
      text: "深圳",
    });
    check(
      "type 选下拉框：没有匹配项时列出可选项",
      none?.includes(
        "里没有匹配「深圳」的选项。可选：请选择、北京、上海、广州",
      ),
      none ?? "没报错",
    );
    const off = await fails("browser_type", {
      pageId: form.pageId,
      ref: city,
      text: "广州",
    });
    check(
      "type 选下拉框：禁用的选项说明原因",
      off?.includes("被禁用"),
      off ?? "没报错",
    );
  }

  // 15) JS 对话框：挂起、拒绝其它操作、用 browser_dialog 回答；动作后告知新开的标签页
  {
    // 前面的段落留下很多页面：弹窗到页面数上限会被直接关掉，所以先清掉。
    for (const p of service.registry.list("w1"))
      await service.registry.close(p.id, "user");
    const { pageId, text } = await open("/dialogs");
    await sleep(300);
    const del = refOf(text, "button", "删除");
    const ask = refOf(text, "button", "改名");
    const click = (await run("browser_click", { pageId, ref: del })).text;
    check(
      "对话框：点「删除」弹出 confirm，click 立即返回固定外壳（不卡、不取快照）",
      click.includes('BLOCKED BY DIALOG: confirm "确定删除吗？"') &&
        click.includes("ACTION: click"),
      click.slice(0, 400),
    );
    const snapRefused = await fails("browser_snapshot", { pageId });
    check(
      "对话框挂着时快照被拒绝，并提示先用 browser_dialog 回答",
      snapRefused?.includes("browser_dialog") &&
        snapRefused.includes("确定删除吗？"),
      snapRefused ?? "没报错",
    );
    const listed = (await run("browser_pages")).text;
    check(
      "browser_pages 标出 DIALOG: confirm",
      listed.includes("DIALOG: confirm"),
      listed.slice(0, 300),
    );
    const logs = await run("browser_console", { pageId });
    check("对话框挂着时控制台照常能读", typeof logs.text === "string");
    const accepted = (await run("browser_dialog", { pageId, accept: true }))
      .text;
    check(
      "browser_dialog 确定：页面 JS 继续（标题写进 删除:true），返回正常的页面内容",
      accepted.includes("ACTION: accept confirm dialog") &&
        accepted.includes("删除:true"),
      accepted.slice(0, 400),
    );
    await run("browser_click", { pageId, ref: del });
    const dismissed = (await run("browser_dialog", { pageId, accept: false }))
      .text;
    check(
      "browser_dialog 取消：confirm 得到 false",
      dismissed.includes("删除:false"),
      dismissed.slice(0, 300),
    );
    await run("browser_click", { pageId, ref: ask });
    const named = (
      await run("browser_dialog", { pageId, accept: true, text: "小红" })
    ).text;
    check(
      "browser_dialog 回答 prompt：输入带进页面",
      named.includes("名字:小红"),
      named.slice(0, 300),
    );
    const none = await fails("browser_dialog", { pageId, accept: true });
    check(
      "没有对话框时回答报错",
      none?.includes("没有等待回答的对话框"),
      none ?? "没报错",
    );

    const fresh = await open("/dialogs");
    const link = refOf(fresh.text, "link", "新窗口打开");
    const popup = (
      await run("browser_click", { pageId: fresh.pageId, ref: link })
    ).text;
    await sleep(300);
    const popup2 = /NEW PAGE: \w+/.test(popup)
      ? popup
      : (await run("browser_snapshot", { pageId: fresh.pageId })).text;
    check(
      "新开标签页：动作结果里带 NEW PAGE 一行（编号、标题、地址、来源）",
      /NEW PAGE: \w+ "[^"]*" \S+\/nav-b \(opened by \w+\)/.test(popup2),
      popup2.slice(0, 500),
    );
  }

  // 16) 开发调试组：browser_exec 与 browser_storage
  {
    const { pageId, text } = await open("/dev");
    await sleep(300);
    const go = refOf(text, "button", "按钮");
    const state = (
      await run("browser_exec", { pageId, script: "return window.__state" })
    ).text;
    check(
      "exec：读页面变量，bigint 与数组按固定写法序列化",
      state.startsWith("EXEC: 开发页 | ") &&
        /RESULT \(\d+ chars\):/.test(state) &&
        state.includes('"a": 1') &&
        state.includes('"when": "1000n"'),
      state.slice(0, 400),
    );
    const onEl = (
      await run("browser_exec", {
        pageId,
        ref: go,
        script: "return el.tagName + ':' + el.textContent",
      })
    ).text;
    check("exec：给 ref 时函数体里有 el", onEl.includes('"BUTTON:按钮"'), onEl);
    const threw = (
      await run("browser_exec", { pageId, script: 'throw new Error("炸了")' })
    ).text;
    check(
      "exec：脚本抛异常写成 THREW，不让工具失败",
      threw.includes("THREW:\nError: 炸了"),
      threw.slice(0, 300),
    );
    const undef = (await run("browser_exec", { pageId, script: "1" })).text;
    check(
      "exec：不 return 写一行 RESULT: undefined",
      undef.endsWith("RESULT: undefined"),
    );

    const cookies = (await run("browser_storage", { pageId, kind: "cookies" }))
      .text;
    check(
      "storage：读得到 HttpOnly Cookie 与普通 Cookie，值原样",
      cookies.startsWith("STORAGE: cookies · scope page (") &&
        /#\d+ sid {2}\S+ {2}\/ {2}session {2}httpOnly SameSite=Lax {2}value: s3cr3t-http-only/.test(
          cookies,
        ) &&
        /theme .*value: dark/.test(cookies),
      cookies.slice(0, 500),
    );
    const seen = (
      await run("browser_exec", { pageId, script: "return document.cookie" })
    ).text;
    check(
      "页面脚本读不到 HttpOnly 的 sid，只看得到 theme（所以 browser_storage 才有价值）",
      seen.includes("theme=dark") && !seen.includes("s3cr3t"),
      seen,
    );
    const wrote = (
      await run("browser_storage", {
        pageId,
        kind: "cookies",
        op: "set",
        name: "flag",
        value: "on",
      })
    ).text;
    check(
      "storage：写 Cookie 只回一句，不贴值",
      /^SET cookie flag \(domain \S+, path \/\)$/.test(wrote),
      wrote,
    );
    const flagged = (
      await run("browser_storage", { pageId, kind: "cookies", name: "flag" })
    ).text;
    check(
      "storage：写进去的 Cookie 能读回来",
      /flag .*value: on/.test(flagged),
      flagged,
    );
    const del = (
      await run("browser_storage", {
        pageId,
        kind: "cookies",
        op: "delete",
        name: "flag",
      })
    ).text;
    check(
      "storage：删 Cookie 报条数",
      del === "DELETED 1 cookie (scope page)",
      del,
    );
    const local = (await run("browser_storage", { pageId, kind: "local" }))
      .text;
    check(
      "storage：读 localStorage",
      /^STORAGE: localStorage · http:\/\/\S+ \| 开发页\n#1 cart: 3$/.test(
        local,
      ),
      local,
    );
    const cleared = (
      await run("browser_storage", { pageId, kind: "local", op: "clear" })
    ).text;
    check(
      "storage：清空 localStorage",
      cleared === "CLEARED 1 entries from localStorage",
      cleared,
    );
    const bad = await fails("browser_storage", {
      pageId,
      kind: "local",
      scope: "all",
    });
    check(
      "storage：localStorage 带 scope 报错，不静默忽略",
      bad?.includes("scope 只对 kind=cookies"),
      bad ?? "没报错",
    );
  }

  // 17) browser_request
  {
    const { pageId } = await open("/dev");
    await sleep(300);
    const got = (await run("browser_request", { pageId, url: "/api/echo" }))
      .text;
    check(
      "request：相对地址按页面解析，带页面的 cookie（含 HttpOnly 的 sid），不自动加 Referer",
      got.startsWith(`REQUEST: GET http://`) &&
        got.includes(`(via page ${pageId},`) &&
        got.includes("STATUS: 200 OK") &&
        got.includes("sid=s3cr3t-http-only") &&
        got.includes("theme=dark") &&
        got.includes('"referer":null'),
      got.slice(0, 600),
    );
    const posted = (
      await run("browser_request", {
        pageId,
        url: "/api/echo",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"a":1}',
      })
    ).text;
    check(
      "request：POST 的方法、头、body 服务端原样收到",
      posted.includes('"method":"POST"') &&
        posted.includes('"contentType":"application/json"') &&
        posted.includes('"body":"{\\"a\\":1}"'),
      posted.slice(0, 600),
    );
    const redir = (await run("browser_request", { pageId, url: "/api/redir" }))
      .text;
    check(
      "request：缺省不跟随，302 原样返回并带 location",
      redir.includes("STATUS: 302 Found") &&
        redir.includes("location: /api/echo") &&
        !redir.includes("REDIRECTS:"),
      redir.slice(0, 400),
    );
    const followed = (
      await run("browser_request", { pageId, url: "/api/redir", follow: true })
    ).text;
    check(
      "request：follow 为 true 时逐跳跟随，REDIRECTS 写出每一跳",
      followed.includes("REDIRECTS:") &&
        /302 GET http:\/\/\S+\/api\/redir → \/api\/echo/.test(followed) &&
        followed.includes("STATUS: 200 OK"),
      followed.slice(0, 500),
    );
    const bob = (
      await run("browser_request", {
        pageId,
        url: "/api/login",
        identity: "bob",
      })
    ).text;
    check(
      "request：命名身份发请求，Set-Cookie 进它自己的罐（JAR 行只写名字）",
      bob.includes("(via identity bob,") &&
        bob.includes("JAR bob: 1 cookies (sid)") &&
        !bob.includes("JAR bob: 1 cookies (sid=") &&
        bob.includes("set-cookie: sid=bob-session"),
      bob.slice(0, 500),
    );
    const asBob = (
      await run("browser_request", {
        pageId,
        url: "/api/echo",
        identity: "bob",
      })
    ).text;
    check(
      "request：身份 bob 带自己的 cookie，不带页面罐里的（theme / 页面的 sid）",
      asBob.includes('"cookie":"sid=bob-session"'),
      asBob.slice(0, 500),
    );
    const asCarol = (
      await run("browser_request", {
        pageId,
        url: "/api/echo",
        identity: "carol",
      })
    ).text;
    check(
      "request：身份 carol 的罐是空的，看不到 bob 的",
      asCarol.includes('"cookie":null') && asCarol.includes("JAR carol: none"),
      asCarol.slice(0, 500),
    );
    const pageJar = (await run("browser_storage", { pageId, kind: "cookies" }))
      .text;
    check(
      "页面自己的 cookie 罐没有被 bob 污染",
      pageJar.includes("s3cr3t-http-only") && !pageJar.includes("bob-session"),
      pageJar.slice(0, 400),
    );
    const getWithBody = await fails("browser_request", {
      pageId,
      url: "/api/echo",
      body: "x",
    });
    check(
      "request：GET 带 body 报错",
      getWithBody?.includes("GET 与 HEAD 不能带 body"),
      getWithBody ?? "没报错",
    );
  }

  // 18) browser_route
  {
    const { pageId } = await open("/route");
    await sleep(300);
    const api = (script) =>
      run("browser_exec", { pageId, script }).then((r) => r.text);
    const probe =
      "const r = await fetch('/api/items'); return r.status + ':' + (await r.text()) + ':' + r.headers.get('x-patched');";
    const before = await api(probe);
    check(
      "拦截前：接口 200 与真实内容",
      before.includes('"200:{\\"items\\":[1,2]}:null"'),
      before.slice(0, 300),
    );
    const mock = (
      await run("browser_route", {
        pageId,
        op: "add",
        pattern: "**/api/items",
        action: "mock",
        status: 500,
        headers: { "content-type": "application/json" },
        body: '{"err":"boom"}',
      })
    ).text;
    check(
      "route add mock：回 ADDED 与一行规则摘要",
      /^ADDED rule #1: mock \* \* \*\*\/api\/items → 500 14 chars, 1 headers$/.test(
        mock,
      ),
      mock,
    );
    const mocked = await api(probe);
    check(
      "mock：页面里 fetch 拿到造出来的 500 与内容",
      mocked.includes('"500:{\\"err\\":\\"boom\\"}:null"'),
      mocked.slice(0, 300),
    );
    const patch = (
      await run("browser_route", {
        pageId,
        op: "add",
        pattern: "**/api/items",
        action: "patch",
        headers: { "x-patched": "yes" },
        replace: [{ find: "[1,2]", with: "[9]" }],
      })
    ).text;
    check(
      "route add patch：后加的先匹配",
      patch.startsWith("ADDED rule #2: patch"),
      patch,
    );
    const patched = await api(probe);
    check(
      "patch：真实响应里的文字被替换、响应头被加上",
      patched.includes('"200:{\\"items\\":[9]}:yes"'),
      patched.slice(0, 300),
    );
    const blocked = (
      await run("browser_route", {
        pageId,
        op: "add",
        pattern: "**/*.png",
        action: "block",
      })
    ).text;
    check(
      "route add block",
      blocked.startsWith("ADDED rule #3: block"),
      blocked,
    );
    const img = await api(
      "const i = new Image(); const ok = await new Promise((r) => { i.onload = () => r('loaded'); i.onerror = () => r('failed'); i.src = '/never-loaded.png'; }); return ok;",
    );
    check("block：图片加载失败", img.includes('"failed"'), img.slice(0, 200));
    const list = (await run("browser_route", { pageId })).text;
    check(
      "route list：每条规则带命中次数",
      list.includes("RULES: 3 (max 20)") &&
        /#2 patch \* \* \*\*\/api\/items .*\(hits 1\)/.test(list) &&
        /#3 block \* \* \*\*\/\*\.png error=failed \(hits [1-9]\)/.test(list),
      list,
    );
    await run("browser_route", { pageId, op: "remove", id: 2 });
    const back = await api(probe);
    check(
      "删掉 patch 后 mock 生效（后加的先匹配，删了才轮到先加的）",
      back.includes('"500:'),
      back.slice(0, 300),
    );
    const cleared = (await run("browser_route", { pageId, op: "clear" })).text;
    const restored = await api(probe);
    check(
      "clear：回报清了几条，接口恢复真实响应",
      cleared === "CLEARED 2 rules" &&
        restored.includes('"200:{\\"items\\":[1,2]}:null"'),
      `${cleared} / ${restored.slice(0, 200)}`,
    );
    const noSuch = await fails("browser_route", {
      pageId,
      op: "remove",
      id: 99,
    });
    check(
      "route remove 不存在的编号报错",
      noSuch?.includes("没有编号为 99"),
      noSuch ?? "没报错",
    );
  }

  // 19) browser_emulate 与 browser_cdp
  {
    const { pageId } = await open("/dev");
    await sleep(300);
    const env = async () =>
      (
        await run("browser_exec", {
          pageId,
          script:
            "return [matchMedia('(prefers-color-scheme: dark)').matches, navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.userAgent]",
        })
      ).text.replace(/\s+/g, "");
    const base = await env();
    const view = (await run("browser_emulate", { pageId })).text;
    check(
      "emulate：什么都不给只读当前状态，ACTIVE: none",
      view.endsWith("ACTIVE: none"),
      view,
    );
    const set = (
      await run("browser_emulate", {
        pageId,
        colorScheme: "dark",
        locale: "ja-JP",
        timezone: "Asia/Tokyo",
        userAgent: "YuanshuProbe/1.0",
        latencyMs: 50,
      })
    ).text;
    check(
      "emulate：设几项后返回当前生效的覆盖",
      set.includes(
        "ACTIVE: throttle latency 50 ms / down unlimited / up unlimited",
      ) &&
        set.includes("colorScheme=dark") &&
        set.includes('userAgent="YuanshuProbe/1.0"') &&
        set.includes("locale=ja-JP") &&
        set.includes("timezone=Asia/Tokyo"),
      set,
    );
    const during = await env();
    check(
      "emulate：页面里读到深色、ja-JP、Asia/Tokyo 与新 UA",
      during.includes("true,") &&
        during.includes('"ja-JP"') &&
        during.includes('"Asia/Tokyo"') &&
        during.includes('"YuanshuProbe/1.0"'),
      during,
    );
    await run("browser_nav", { pageId, action: "reload" });
    await sleep(300);
    const reloaded = await env();
    check("emulate：整页刷新之后覆盖仍然生效", reloaded === during, reloaded);
    const reset = (await run("browser_emulate", { pageId, reset: true })).text;
    const after = await env();
    check(
      "emulate reset：撤销全部，页面里的值回到原样",
      reset.endsWith("ACTIVE: none") && after === base,
      `${reset} / ${after}`,
    );
    const bad = await fails("browser_emulate", { pageId, cpuSlowdown: 0.5 });
    check(
      "emulate：cpuSlowdown 小于 1 报错",
      bad?.includes("≥ 1"),
      bad ?? "没报错",
    );

    const cdp = (
      await run("browser_cdp", {
        pageId,
        method: "Runtime.evaluate",
        params: { expression: "6 * 7", returnByValue: true },
      })
    ).text;
    check(
      "cdp：Runtime.evaluate 取回结果，外壳写方法、标题与地址",
      cdp.startsWith("CDP: Runtime.evaluate | 开发页 | ") &&
        /RESULT \(\d+ chars\):/.test(cdp) &&
        cdp.includes('"value": 42'),
      cdp.slice(0, 300),
    );
    const noMethod = await fails("browser_cdp", { pageId, method: "Foo.bar" });
    check(
      "cdp：不存在的方法报一行错",
      noMethod?.includes("'Foo.bar' wasn't found") && !noMethod.includes("\n"),
      noMethod ?? "没报错",
    );
    const badShape = await fails("browser_cdp", { pageId, method: "nodot" });
    check(
      "cdp：method 形状不对报错",
      badShape?.includes("Domain.method"),
      badShape ?? "没报错",
    );
  }
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
