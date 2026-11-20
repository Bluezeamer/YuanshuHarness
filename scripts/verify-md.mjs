// Markdown 里的图片的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，不需要真实模型。
//  1) 文件预览里渲染 md：相对路径（`./.assets/文档/…`，含中文名与编码空格）与 svg 都显示出来，点击放大；
//     读不到的是占位；外链 http(s) 不加载（没有向第三方发请求），只是可点的占位；
//     中文标点紧挨汉字的加粗（`**注意：**正文`）生效，自动识别的网址在中文标点处收尾；
//     选中渲染出来的整段复制，剪贴板里是 Markdown 原文
//  2) 往 md 里粘贴 / 拖入图片：存进 md 所在目录的 `.assets/<名>/`、光标（落点）处插入相对路径链接；截图按日期时间命名，
//     拖入的保留原名、重名加 (2)；带文字的剪贴板照常粘贴文字；非 md 文件不处理；保存后预览里能看到
//  3) 全程没有控制台报错、没有失败的接口请求（读不到的那张图的 404 除外）
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-md.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

// 纯色 PNG，现造：不依赖仓库外的文件
function png(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x66)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="60"><rect width="90" height="60" fill="#3b82f6"/></svg>';

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "md-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(join(dir, ".assets", "文档"), { recursive: true });
writeFileSync(join(dir, ".assets", "文档", "pic.png"), png(120, 80));
writeFileSync(join(dir, ".assets", "文档", "image 1.png"), png(60, 40));
writeFileSync(join(dir, ".assets", "文档", "v.svg"), SVG);
writeFileSync(join(dir, "草稿.md"), "# 草稿\n\n开头\n");
writeFileSync(join(dir, "纯文本.txt"), "plain\n");
writeFileSync(
  join(dir, "文档.md"),
  [
    "# 文档",
    "",
    "![图一](./.assets/文档/pic.png)",
    "",
    "![带空格](./.assets/文档/image%201.png)",
    "",
    "![矢量](./.assets/文档/v.svg)",
    "",
    "![丢了](./.assets/文档/none.png)",
    "",
    "![远程](https://example.com/a.png)",
    "",
    "**注意：**中文标点紧挨汉字也要加粗，网址 https://example.com/doc，到这里为止。",
    "",
  ].join("\n"),
);
const port = 18300 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
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

const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

const problems = [];
const external = [];

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
    name: "占位",
    slug: "placeholder",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "x",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  const ws = await api("POST", "/workspaces", {
    name: "图片",
    directories: [{ path: dir }],
  });
  await api("POST", "/sessions", { workspaceId: ws.id });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error")
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/") && r.status() >= 400)
        problems.push(
          `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
    });
    page.on("request", (r) => {
      if (/^https?:/.test(r.url()) && !r.url().startsWith(origin))
        external.push(r.url());
    });
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "图片" }).click();
    await page.waitForSelector(".ws-fm-row");
    await sleep(800);

    // 1) 预览里渲染图片
    await page
      .locator('.ws-fm-row[data-name="文档.md"] .u-lrow-main')
      .dblclick();
    await page.locator(".ws-pv .cm-content").waitFor();
    await page.getByRole("radio", { name: "预览" }).click();
    await page.locator(".ws-pv-md .md-img img").first().waitFor();
    await page.locator(".ws-pv-md .md-img-note[data-state='fail']").waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".ws-pv-md .md-img img")].every(
        (i) => i.complete && i.naturalWidth > 0,
      ),
    );
    const info = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll(".ws-pv-md .md-img img")];
      const ext = document.querySelector(".ws-pv-md a.ws-pv-img-ph");
      return {
        sizes: imgs.map((i) => [i.naturalWidth, i.naturalHeight]),
        alts: imgs.map((i) => i.getAttribute("alt")),
        fail: document.querySelector(
          ".ws-pv-md .md-img-note[data-state='fail']",
        )?.textContent,
        ext: ext?.getAttribute("href"),
        total: document.querySelectorAll(".ws-pv-md img").length,
        bold: [...document.querySelectorAll(".ws-pv-md strong")].map(
          (e) => e.textContent,
        ),
        links: [
          ...document.querySelectorAll(".ws-pv-md a:not(.ws-pv-img-ph)"),
        ].map((a) => a.getAttribute("href")),
      };
    });
    await shot("md-1-preview");
    check(
      "相对路径的 png（含中文文件夹、%20 的空格）与 svg 都显示出来",
      JSON.stringify(info.sizes) === "[[120,80],[60,40],[90,60]]" &&
        JSON.stringify(info.alts) === '["图一","带空格","矢量"]',
      JSON.stringify(info),
    );
    check(
      "读不到的是占位「[图片：丢了]」；外链是可点的占位、没有 img",
      info.fail?.startsWith("[图片：丢了]") &&
        info.ext === "https://example.com/a.png" &&
        info.total === 3,
      JSON.stringify(info),
    );
    check(
      "中文标点紧挨汉字的加粗生效；网址在中文标点处收尾",
      info.bold.includes("注意：") &&
        info.links.includes("https://example.com/doc") &&
        !info.links.some((u) => u.includes("，")),
      JSON.stringify(info),
    );
    // 复制渲染出来的内容给 Markdown 原文：选中最后一段整块，真触发一次复制，读 copy 事件里写进剪贴板的内容
    const copied = await page.evaluate(() => {
      const ps = [...document.querySelectorAll(".ws-pv-md p")];
      const p = ps.find((e) => e.textContent?.includes("注意："));
      if (!p) return null;
      const sel = getSelection();
      sel.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(p);
      sel.addRange(r);
      let got = null;
      const grab = (e) => {
        got = e.clipboardData.getData("text/plain");
      };
      document.addEventListener("copy", grab);
      document.execCommand("copy");
      document.removeEventListener("copy", grab);
      sel.removeAllRanges();
      return got;
    });
    check(
      "选中渲染出来的整段再复制：剪贴板里是 Markdown 原文（加粗标记还在）",
      typeof copied === "string" && copied.startsWith("**注意：**中文标点"),
      JSON.stringify(copied),
    );
    check(
      "没有向第三方发请求（外链图片不加载）",
      external.length === 0,
      JSON.stringify(external.slice(0, 3)),
    );
    const bigger = await page.evaluate(() => {
      const r = document
        .querySelector(".ws-pv-md .md-img img")
        .getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    });
    check(
      "图片按原尺寸显示（不被放大或拉伸）",
      bigger[0] === 120 && bigger[1] === 80,
      JSON.stringify(bigger),
    );
    await page.locator(".ws-pv-md .md-img").first().click();
    await page.locator(".u-iv-modal").waitFor();
    check("点击图片放大（打开图片查看器）", true);
    await shot("md-2-viewer");
    await page.keyboard.press("Escape");
    await sleep(300);

    // 2) 粘贴 / 拖入
    const cm = () => page.locator(".ws-pv .cm-content");
    const editText = () => cm().innerText();
    const focusFiles = async () => {
      await page.locator(".ws-pn-tab[data-type='files']").first().click();
      await page.waitForSelector(".ws-fm-row");
    };
    const assetNames = () => {
      const d = join(dir, ".assets", "草稿");
      return existsSync(d) ? readdirSync(d).sort() : [];
    };
    // 在编辑器上派发「带文件的」粘贴 / 拖放事件（Chromium 允许自己构造 DataTransfer）
    const sendFiles = (kind, files, text) =>
      page.evaluate(
        ([kind, files, text]) => {
          const dt = new DataTransfer();
          for (const f of files) {
            const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
            dt.items.add(new File([bytes], f.name, { type: f.type }));
          }
          if (text) dt.setData("text/plain", text);
          const el = document.querySelector(".ws-pv .cm-content");
          const r = el.getBoundingClientRect();
          const ev =
            kind === "paste"
              ? new ClipboardEvent("paste", {
                  clipboardData: dt,
                  bubbles: true,
                  cancelable: true,
                })
              : new DragEvent("drop", {
                  dataTransfer: dt,
                  bubbles: true,
                  cancelable: true,
                  clientX: r.left + 20,
                  clientY: r.top + 8,
                });
          el.dispatchEvent(ev);
        },
        [kind, files, text],
      );
    const pngFile = (name, w, h) => ({
      name,
      type: "image/png",
      b64: png(w, h).toString("base64"),
    });

    await page
      .locator('.ws-fm-row[data-name="草稿.md"] .u-lrow-main')
      .dblclick();
    await cm().waitFor();
    await sleep(500);
    await cm().click();
    await page.keyboard.press("Control+End");
    await sendFiles("paste", [pngFile("image.png", 50, 30)]);
    await page.waitForFunction(() =>
      /!\[\]\(\.\/\.assets\/草稿\/image-\d{8}-\d{6}\.png\)/.test(
        document.querySelector(".ws-pv .cm-content").innerText,
      ),
    );
    const afterPaste = await editText();
    check(
      "粘贴截图：资源夹建在 md 所在目录的隐藏文件夹里（.assets/草稿）、不在目录里多出一堆文件夹、文件名是 image-日期时间.png、光标处插入相对路径链接，文件确实写在磁盘上",
      assetNames().length === 1 &&
        /^image-\d{8}-\d{6}\.png$/.test(assetNames()[0]) &&
        afterPaste.includes(`./.assets/草稿/${assetNames()[0]}`),
      JSON.stringify([assetNames(), afterPaste.slice(-60)]),
    );
    check(
      "目录里没有多出可见的文件夹（图片都在隐藏的 .assets/ 里）",
      !readdirSync(dir).some(
        (n) => !n.startsWith(".") && n.endsWith(".assets"),
      ),
      JSON.stringify(readdirSync(dir)),
    );
    check(
      "插入后文件标「未保存」（链接是编辑内容，不是自动存盘）",
      (await page.locator(".ws-pv-dirty").count()) === 1,
    );

    await sendFiles("drop", [
      {
        name: "logo.svg",
        type: "image/svg+xml",
        b64: Buffer.from(SVG).toString("base64"),
      },
      pngFile("a b.png", 40, 20),
      pngFile("a b.png", 40, 20),
    ]);
    await page.waitForFunction(() =>
      document
        .querySelector(".ws-pv .cm-content")
        .innerText.includes("%282%29"),
    );
    const afterDrop = await editText();
    check(
      "拖入多个文件：svg 同样带 !；保留原名、空格在链接里是 %20、同名的第二个加 (2)（括号转义成 %28 %29）",
      afterDrop.includes("![](./.assets/草稿/logo.svg)") &&
        afterDrop.includes("![](./.assets/草稿/a%20b.png)") &&
        afterDrop.includes("![](./.assets/草稿/a%20b%20%282%29.png)") &&
        JSON.stringify(assetNames()) ===
          JSON.stringify(
            [
              "logo.svg",
              "a b.png",
              "a b (2).png",
              assetNames().find((n) => n.startsWith("image-")),
            ].sort(),
          ),
      JSON.stringify([assetNames(), afterDrop.slice(-160)]),
    );

    const before = assetNames().length;
    await cm().click();
    await page.keyboard.press("Control+End");
    await sendFiles("paste", [pngFile("image.png", 10, 10)], "纯文字粘贴");
    await sleep(800);
    check(
      "剪贴板里同时有文字（比如从表格复制）：照常粘贴文字，不存图片",
      (await editText()).includes("纯文字粘贴") &&
        assetNames().length === before,
    );

    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !document.querySelector(".ws-pv-dirty"));
    await page.getByRole("radio", { name: "预览" }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".ws-pv-md .md-img img").length === 4 &&
        [...document.querySelectorAll(".ws-pv-md .md-img img")].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      null,
      { timeout: 10000 },
    );
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll(".ws-pv-md .md-img img")].map((i) => [
        i.naturalWidth,
        i.naturalHeight,
      ]),
    );
    check(
      "保存后切到预览：刚插入的 4 张图（截图、svg、两张同名）都显示出来",
      sizes.length === 4,
      JSON.stringify(sizes),
    );
    await shot("md-3-pasted");

    // 非 md 文件：不处理文件粘贴
    await focusFiles();
    await page
      .locator('.ws-fm-row[data-name="纯文本.txt"] .u-lrow-main')
      .dblclick();
    await page.locator(".ws-pv .cm-content").waitFor();
    await sleep(400);
    await page.locator(".ws-pv .cm-content").click();
    await sendFiles("paste", [pngFile("image.png", 10, 10)]);
    await sleep(800);
    check(
      "非 md 文件：粘贴图片什么都不做（没有 .assets、内容没变）",
      !existsSync(join(dir, ".assets", "纯文本")) &&
        (await editText()).trim() === "plain",
    );

    // 3) 没有报错（读不到的那张图的 404 是预期的）
    const unexpected = problems.filter(
      (p) =>
        !p.startsWith("404 GET") && !p.includes("status of 404 (Not Found)"),
    );
    check(
      "全程没有控制台报错与失败的接口请求（读不到的那张图的 404 除外）",
      unexpected.length === 0,
      unexpected.slice(0, 5).join(" | "),
    );
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  check("脚本异常", false, String(e?.stack ?? e).slice(0, 400));
} finally {
  proc.kill();
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(
  `\nMarkdown 图片：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
