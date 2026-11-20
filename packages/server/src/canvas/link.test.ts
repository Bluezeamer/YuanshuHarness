import { expect, test } from "vitest";
import {
  decodeEntities,
  LinkService,
  parseHtmlMeta,
  parseHttpUrl,
} from "./link.js";

const page = (head: string) =>
  `<!doctype html><html><head>${head}</head><body>x</body></html>`;

test("parseHttpUrl：只放行 http 与 https", () => {
  expect(parseHttpUrl("https://a.com/x?y=1")?.hostname).toBe("a.com");
  expect(parseHttpUrl("http://localhost:3000")?.port).toBe("3000");
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///a",
    "ftp://a",
    "a.com",
    "",
  ])
    expect(parseHttpUrl(bad)).toBeNull();
});

test("decodeEntities：命名与数字实体，不认识的原样留着", () => {
  expect(
    decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x4e2d;"),
  ).toBe(`a & b <c> "d" 'e' 中`);
  expect(decodeEntities("&unknown; &#0; &#x110000;")).toBe(
    "&unknown; &#0; &#x110000;",
  );
});

test("parseHtmlMeta：og 优先于 twitter 优先于普通 meta 与 <title>，相对地址换成绝对的", () => {
  const m = parseHtmlMeta(
    page(`
      <title> 普通 &amp; 标题 </title>
      <meta name="description" content="普通摘要">
      <meta property="og:title" content="OG 标题">
      <meta property="og:description" content='OG 摘要'>
      <meta property="og:image" content="/cover.png">
      <meta property="og:site_name" content="某站">
      <link rel="shortcut icon" href="/static/i.ico">`),
    "https://a.com/p/q",
  );
  expect(m).toEqual({
    title: "OG 标题",
    description: "OG 摘要",
    image: "https://a.com/cover.png",
    icon: "https://a.com/static/i.ico",
    site: "某站",
  });
});

test("parseHtmlMeta：只有 <title> 时取它（折叠空白、解实体）；没有图标声明就用 /favicon.ico；危险协议的图片丢掉", () => {
  const m = parseHtmlMeta(
    page(`<title>
      Tom &amp;  Jerry </title><meta property="og:image" content="javascript:alert(1)">`),
    "https://b.org/x",
  );
  expect(m).toMatchObject({
    title: "Tom & Jerry",
    description: null,
    image: null,
    icon: "https://b.org/favicon.ico",
  });
});

const html = (body: string, type = "text/html; charset=utf-8") =>
  new Response(body, { headers: { "content-type": type } });

test("LinkService：抓到的缓存起来，同一个地址并发只抓一次；失败不缓存", async () => {
  let hits = 0;
  let fail = true;
  const svc = new LinkService({
    fetchImpl: async () => {
      hits += 1;
      if (fail) throw new Error("down");
      return html(page("<title>好</title>"));
    },
  });
  expect((await svc.get("https://a.com/")).failed).toBe(true);
  fail = false;
  const [a, b] = await Promise.all([
    svc.get("https://a.com/"),
    svc.get("https://a.com/"),
  ]);
  expect(a.title).toBe("好");
  expect(b).toBe(a);
  expect(hits).toBe(2);
  await svc.get("https://a.com/");
  expect(hits).toBe(2);
});

test("LinkService：缓存过期后重抓；条数满了淘汰最早的", async () => {
  let t = 0;
  let hits = 0;
  const svc = new LinkService({
    now: () => t,
    ttlMs: 100,
    maxEntries: 2,
    fetchImpl: async () => {
      hits += 1;
      return html(page("<title>x</title>"));
    },
  });
  await svc.get("https://a.com/1");
  await svc.get("https://a.com/2");
  await svc.get("https://a.com/3");
  expect(hits).toBe(3);
  await svc.get("https://a.com/1");
  expect(hits).toBe(4);
  t = 500;
  await svc.get("https://a.com/3");
  expect(hits).toBe(5);
});

test("LinkService：非 2xx 算失败；非 HTML 不解析，图片自己当封面；按页面声明的编码解码", async () => {
  const svc = new LinkService({
    fetchImpl: async (u) => {
      const url = String(u);
      if (url.endsWith("/404")) return new Response("nope", { status: 404 });
      if (url.endsWith("/p.png"))
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      if (url.endsWith("/data.json")) return html("{}", "application/json");
      // gbk 的「中文」
      return new Response(
        new Uint8Array([
          ...Buffer.from('<head><meta charset="gbk"><title>'),
          0xd6,
          0xd0,
          0xce,
          0xc4,
          ...Buffer.from("</title></head>"),
        ]),
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  expect((await svc.get("https://a.com/404")).failed).toBe(true);
  expect(await svc.get("https://a.com/p.png")).toMatchObject({
    image: "https://a.com/p.png",
    title: null,
    failed: false,
  });
  expect(await svc.get("https://a.com/data.json")).toMatchObject({
    image: null,
    title: null,
    failed: false,
  });
  expect((await svc.get("https://a.com/gbk")).title).toBe("中文");
});

test("LinkService：只读页面开头一段，看到 </head> 就停（不把整页拉下来）", async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode(page("<title>头</title>"));
  const rest = new Uint8Array(64 * 1024).fill(97);
  const svc = new LinkService({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled += 1;
            c.enqueue(pulled === 1 ? chunk : rest);
          },
        }),
        { headers: { "content-type": "text/html" } },
      ),
  });
  expect((await svc.get("https://a.com/")).title).toBe("头");
  expect(pulled).toBeLessThanOrEqual(2);
});
