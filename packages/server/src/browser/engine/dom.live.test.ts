// readDom 的真浏览器端到端：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 直接用 Playwright 起浏览器（不经引擎与代理）：夹具就在本机 http 站点上。
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readDom } from "./dom.js";
import type { DomCapture, DomElement, DomGroup, DomText } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";

// 夹具：懒加载图（占位 src + data-src）、无标签的 video、热区、open shadow root 里的 video、
// 同源 iframe、form、download 链接、很长的行内脚本。
const PAGE = `<!doctype html><meta charset=utf-8><title>DOM 页</title>
<img id="lazy" alt="懒加载图" width="120" height="80"
     src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
     data-src="/real.png">
<video id="trailer" src="/movie.mp4" poster="/poster.jpg" width="320" height="180"></video>
<img id="map-img" alt="热区图" src="/map.png" usemap="#areas">
<map name="areas"><area shape="rect" coords="0,0,10,10" href="/hot" alt="热区"></map>
<div id="host"></div>
<iframe id="frame" src="/inner" width="300" height="100"></iframe>
<form id="search" action="/search" method="post"><input name="q" value="猫"></form>
<a id="dl" href="/file.zip" download="资料.zip">下载资料</a>
<style>${".pad { color: red }".repeat(20)}</style>
<svg id="icon" width="20" height="20"><rect width="20" height="20"></rect><circle r="3"></circle></svg>
<template id="tpl"><p>模板内容</p></template>
<script>${"const pad = 1;".repeat(200)}</script>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = '<video id="inner-video" src="/shadow.mp4" controls></video>';
</script>`;
const INNER = `<!doctype html><meta charset=utf-8><title>框里</title>
<img id="inner-img" alt="框里的图" src="/inner.png" width="40" height="40">
<p>框里的字</p>`;

// 节点上限：25000 个 <i>。
const MANY = `<!doctype html><meta charset=utf-8><title>很多节点</title>
<body>${"<i>x</i>".repeat(25_000)}</body>`;

// 递归深度：250 层嵌套 div，超过上限的子树只留一句 depth limit。
const DEEP = `<!doctype html><meta charset=utf-8><title>深页</title>
<body>${"<div>".repeat(250)}底${"</div>".repeat(250)}</body>`;

const OVER_200 = `<!doctype html><meta charset=utf-8><title>很多图</title>
<body>${Array.from({ length: 250 }, (_, i) => `<img alt="图 ${i}" src="/img-${i}.png">`).join("")}</body>`;

interface Site {
  port: number;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const pages: Record<string, string> = {
    "/": PAGE,
    "/inner": INNER,
    "/many": MANY,
    "/deep": DEEP,
    "/over": OVER_200,
  };
  // 图片与视频都给一小段真字节：readDom 不读字节，但 naturalWidth 要能取到。
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    if (path in pages) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(pages[path]);
      return;
    }
    if (path.endsWith(".png")) {
      res.setHeader("content-type", "image/png");
      res.end(PNG);
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe.skipIf(!enabled)("readDom（真实 Chromium）", () => {
  let browser: Browser;
  let site: Site;
  let page: Page;
  const url = (path = "/") => `http://127.0.0.1:${site.port}${path}`;

  beforeAll(async () => {
    if (!enabled) return;
    site = await startSite();
    browser = await chromium.launch({ executablePath: EXE });
    page = await browser.newPage();
    await page.goto(url());
    // 等图片加载完，naturalWidth 才是真的。
    await page.waitForLoadState("load");
  });

  afterAll(async () => {
    if (!enabled) return;
    await browser?.close().catch(() => {});
    await site?.close().catch(() => {});
  });

  /** 把一棵树拍平成元素列表（递归，含 shadow 内容）。 */
  const flatten = (nodes: (DomElement | DomText)[]) => {
    const out: DomElement[] = [];
    const walk = (list: (DomElement | DomText)[]) => {
      for (const n of list)
        if ("tag" in n) {
          out.push(n);
          walk(n.kids);
          walk(n.shadow ?? []);
        }
    };
    walk(nodes);
    return out;
  };

  /** 一个 group 里所有 tag 匹配的元素。 */
  const find = (group: DomGroup, tag: string) =>
    flatten(group.roots).filter((e) => e.tag === tag);

  /** 第一个 group（用例都断言它存在）。 */
  const group = (capture: DomCapture): DomGroup => {
    const g = capture.groups[0];
    if (!g) throw new Error("没有读到 group");
    return g;
  };

  test("selector：每个 frame 各查一遍，主 frame 在前，iframe 里的命中单独一组", async () => {
    const capture = await readDom(page, {
      selector: "img, video, area, form, a[download]",
    });
    expect(capture.groups).toHaveLength(2);
    const main = group(capture);
    const inner = capture.groups[1];
    expect(main.frame.main).toBe(true);
    expect(main.frame.url).toBe(url());
    expect(inner?.frame.main).toBe(false);
    expect(inner?.frame.url).toBe(url("/inner"));
    // 主 frame 的命中：懒加载图、video、热区、form、download 链接、shadow 里的 video。
    expect(find(main, "img").length).toBeGreaterThan(0);
    expect(
      find(main, "a").filter((a) =>
        a.attrs.some((x) => x.name === "download" && x.value === "资料.zip"),
      ),
    ).toHaveLength(1);
    expect(find(main, "area")).toHaveLength(1);
    expect(find(main, "form")).toHaveLength(1);
    // open shadow root 里的 video：Playwright 的 CSS 穿透 shadow DOM，它自己就是一条命中。
    expect(
      find(main, "video").some((v) =>
        v.attrs.some((a) => a.name === "src" && a.value === "/shadow.mp4"),
      ),
    ).toBe(true);
    // iframe 里那张图在第二个 group 里。
    if (!inner) throw new Error("没有读到 iframe 的 group");
    const innerImg = find(inner, "img");
    expect(innerImg).toHaveLength(1);
    expect(innerImg[0]?.attrs).toContainEqual({
      name: "alt",
      value: "框里的图",
      length: 4,
    });
  });

  test("selector：data-src 读得到、box 只在根上、懒加载图是真占位", async () => {
    const capture = await readDom(page, { selector: "#lazy" });
    const img = capture.groups[0]?.roots[0];
    expect(img?.tag).toBe("img");
    expect(img?.attrs).toContainEqual({
      name: "data-src",
      value: "/real.png",
      length: 9,
    });
    // 只断言尺寸与左边缘：纵向位置跟行盒基线有关，不是这里要验的东西。
    expect(img?.box).toMatchObject({ x: 8, width: 120, height: 80 });
    // 占位图：src 是 data:，currentSrc 与它不同也照样给（describeSrc 在渲染层处理）。
    expect(img?.natural).toEqual({ width: 1, height: 1 });
  });

  test("selector：形式与热区的属性都在", async () => {
    const capture = await readDom(page, { selector: "#search" });
    const form = capture.groups[0]?.roots[0];
    expect(form?.attrs).toContainEqual({
      name: "action",
      value: "/search",
      length: 7,
    });
    expect(form?.attrs).toContainEqual({
      name: "method",
      value: "post",
      length: 4,
    });
    const areas = await readDom(page, { selector: "area" });
    expect(areas.groups[0]?.roots[0]?.attrs).toContainEqual({
      name: "href",
      value: "/hot",
      length: 4,
    });
  });

  test("ref：先取快照编号，再读该元素的子树，不给 @box 以外的后代 box", async () => {
    const snap = await page.ariaSnapshot({ mode: "ai", timeout: 5000 });
    const line = snap.split("\n").find((l) => l.includes("热区图"));
    const ref = line ? /\[ref=(\w+)\]/.exec(line)?.[1] : undefined;
    expect(ref).toBeTruthy();
    const capture = await readDom(page, { ref: ref as string });
    expect(capture.groups).toHaveLength(1);
    expect(capture.groups[0]?.total).toBe(1);
    const root = capture.groups[0]?.roots[0];
    expect(root?.tag).toBe("img");
    expect(root?.box).toBeDefined();
    expect(root?.attrs).toContainEqual({
      name: "usemap",
      value: "#areas",
      length: 6,
    });
  });

  test("ref：编号格式不对与元素不存在各给一句中文", async () => {
    expect((await readDom(page, { ref: "x1" }).catch((e) => e)).message).toBe(
      "编号格式不对（x1），请用 browser_snapshot 给出的编号。",
    );
    expect(
      (await readDom(page, { ref: "e9999" }).catch((e) => e)).message,
    ).toContain("该编号已失效");
  });

  test("document：根是 html，script 有 summary、iframe 只有元素没有内容", async () => {
    const capture = await readDom(page, null);
    expect(capture.groups).toHaveLength(1);
    const g = group(capture);
    expect(g.frame.main).toBe(true);
    expect(g.total).toBe(1);
    const html = g.roots[0];
    expect(html?.tag).toBe("html");
    expect(html?.box).toBeDefined();
    const inline = find(g, "script").find((s) =>
      s.summary?.startsWith("inline script, "),
    );
    expect(inline?.summary).toMatch(/^inline script, \d+ chars$/);
    expect(find(g, "iframe")[0]?.attrs.some((a) => a.name === "src")).toBe(
      true,
    );
    // 不进入 iframe：里面那句「框里的字」不会出现在 document 读到的文字里。
    const texts: string[] = [];
    const walk = (nodes: (DomElement | DomText)[]) => {
      for (const n of nodes)
        if ("tag" in n) {
          walk(n.kids);
          walk(n.shadow ?? []);
        } else texts.push(n.text);
    };
    walk(g.roots);
    expect(texts).not.toContain("框里的字");
  });

  test("document：open shadow root 展开、svg / style / template 只给 summary", async () => {
    const g = group(await readDom(page, null));
    const host = find(g, "div").find((d) =>
      d.attrs.some((a) => a.name === "id" && a.value === "host"),
    );
    expect(
      (host?.shadow ?? []).some(
        (n) =>
          "tag" in n &&
          n.tag === "video" &&
          n.attrs.some((a) => a.name === "src" && a.value === "/shadow.mp4"),
      ),
    ).toBe(true);
    expect(find(g, "svg")[0]?.summary).toBe("svg: 2 elements");
    expect(find(g, "style")[0]?.summary).toMatch(/^\d+ chars$/);
    expect(find(g, "template")[0]?.summary).toBe("template content");
  });

  test("ref：iframe 里的编号也能读，group 标明不是主 frame", async () => {
    const snap = await page.ariaSnapshot({ mode: "ai", timeout: 5000 });
    const line = snap.split("\n").find((l) => l.includes("框里的图"));
    const ref = line ? /\[ref=(\w+)\]/.exec(line)?.[1] : undefined;
    expect(ref).toMatch(/^f\d+e\d+$/);
    const capture = await readDom(page, { ref: ref as string });
    expect(capture.groups[0]?.frame.main).toBe(false);
    expect(capture.groups[0]?.frame.url).toBe(url("/inner"));
    expect(capture.groups[0]?.roots[0]?.tag).toBe("img");
  });

  test("选择器语法错误：抛「选择器无法解析：…」", async () => {
    const err = (await readDom(page, { selector: "img[" }).catch(
      (e) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message.startsWith("选择器无法解析：")).toBe(true);
    // 只取 Playwright 报错的第一行。
    expect(err.message).toContain("while parsing css selector");
    expect(err.message).not.toContain("\n");
  });

  test("命中超过 200：只读前 200 个，total 仍是真实总数", async () => {
    await page.goto(url("/over"));
    const capture = await readDom(page, { selector: "img" });
    const group = capture.groups[0];
    expect(group?.total).toBe(250);
    expect(group?.roots).toHaveLength(200);
  });

  test("递归深度上限：超过 200 层的子树只给一句 depth limit", async () => {
    await page.goto(url("/deep"));
    const g = group(await readDom(page, null));
    const summaries = flatten(g.roots)
      .map((e) => e.summary)
      .filter((x) => x !== undefined);
    expect(summaries).toContain("depth limit");
    // 深度没用完的部分照常读到底：html 与 body 占掉两层，第 199 个 div 正好到上限。
    expect(flatten(g.roots).filter((e) => e.tag === "div").length).toBe(199);
  });

  test("节点上限：25000 个节点的页面把 nodeCapHit 置位", async () => {
    await page.goto(url("/many"));
    const capture = await readDom(page, null);
    expect(capture.nodeCapHit).toBe(true);
  }, 30_000);
});
