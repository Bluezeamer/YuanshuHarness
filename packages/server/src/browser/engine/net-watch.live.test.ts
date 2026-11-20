// watchNetwork 的真浏览器端到端：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 直接用 Playwright 起浏览器（不经引擎与代理）：夹具就在本机 http 站点上。
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { watchNetwork } from "./net-watch.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";

// 夹具：一个 JSON 接口（带 Authorization 与 Cookie）、一张 404 的图、一个被服务端掐断的接口、
// 一次重定向、一个 POST（JSON）、一个二进制接口、一个永不结束的流式接口、iframe 里自己的请求，
// 以及一张 data: 图（不是网络请求）。
const PAGE = `<!doctype html><meta charset=utf-8><title>网络页</title>
<img id="gone" src="/missing.png" alt="不存在的图">
<img id="inline" alt="内联图" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
<img id="hop" src="/redirect" alt="重定向图">
<iframe id="frame" src="/inner" width="200" height="60"></iframe>
<script>
  document.cookie = "sid=abc123; path=/";
  const h = { authorization: "Bearer secret-token" };
  Promise.all([
    fetch("/api/json", { headers: h }).then((r) => r.json()),
    fetch("/api/post", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }) }).then((r) => r.json()),
    fetch("/binary").then((r) => r.arrayBuffer()),
    fetch("/abort").catch(() => "aborted"),
  ]).then(() => { window.__netDone = true });
  // 永不结束的流式响应：不放进上面那一组，否则 __netDone 永远等不到。
  fetch("/stream").then((r) => r.body.getReader().read()).catch(() => "stream");
</script>`;

const INNER = `<!doctype html><meta charset=utf-8><title>框里</title>
<script>
  fetch("/inner.json").then((r) => r.json());
</script>`;

interface Site {
  port: number;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const pages: Record<string, string> = { "/": PAGE, "/inner": INNER };
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  const json = (res: http.ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    // 查询串不参与路由（地址里的令牌参数要能原样回显）。
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path in pages) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pages[path]);
      return;
    }
    if (path === "/api/json") return json(res, { headers: req.headers });
    if (path === "/inner.json") return json(res, { ok: true });
    if (path === "/api/post") return json(res, { ok: true });
    // 二进制（PNG 头 + 一段非法 UTF-8）：按字节原样取回。
    if (path === "/binary") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.concat([PNG, Buffer.from([0xff, 0xfe, 0x00])]));
      return;
    }
    // 写了头与一段数据但永不结束：浏览器侧是收到了响应头、还没传完。
    if (path === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first chunk");
      return;
    }
    // 收下请求但一直不响应：浏览器侧就是一条 pending 的请求。
    if (path === "/api/hang") return;
    if (path === "/abort") {
      // 直接断开：浏览器侧就是一次失败的请求。
      req.socket.destroy();
      return;
    }
    if (path === "/redirect") {
      res.writeHead(302, { location: "/img.png" });
      res.end();
      return;
    }
    if (path === "/img.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return;
    }
    if (path === "/missing.png") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(30);
  }
  return false;
}

describe.skipIf(!enabled)("watchNetwork（真实 Chromium）", () => {
  let browser: Browser;
  let site: Site;
  let page: Page;
  const url = (path = "/") => `http://127.0.0.1:${site.port}${path}`;

  beforeAll(async () => {
    if (!enabled) return;
    site = await startSite();
    browser = await chromium.launch({ executablePath: EXE });
    page = await browser.newPage();
  });

  afterAll(async () => {
    if (!enabled) return;
    await browser?.close().catch(() => {});
    await site?.close().catch(() => {});
  });

  test("开始记录、回填响应 / 结束 / 失败；data: 不入缓冲，iframe 里的是 sub", async () => {
    const net = watchNetwork(page);
    await page.goto(url());
    await page.waitForFunction("window.__netDone === true");
    // 永不结束的流式请求不算在内；其余各条都要回填到结束。
    const finished = () => net.list().filter((e) => !e.url.includes("/stream"));
    // sizes 在 requestfinished 之后才异步回填，等它落位。
    expect(await waitFor(() => finished().every((e) => e.ms !== null))).toBe(
      true,
    );
    expect(await waitFor(() => finished().some((e) => e.size !== null))).toBe(
      true,
    );
    await sleep(200);

    const all = net.list();
    // 编号每页独立、单调递增，从 1 起。
    expect(all.map((e) => e.id)).toEqual(all.map((_, i) => i + 1));
    // data: 图不是网络请求。
    expect(all.some((e) => e.url.startsWith("data:"))).toBe(false);
    expect(all.some((e) => e.url.includes("inline"))).toBe(false);

    const find = (frag: string) => {
      const hit = all.filter((e) => e.url.includes(frag));
      if (hit.length === 0)
        throw new Error(
          `缓冲里没有 ${frag}：\n${all.map((e) => e.url).join("\n")}`,
        );
      return hit;
    };

    // 主文档与 JSON 接口。
    const doc = find("/");
    expect(doc[0]).toMatchObject({
      method: "GET",
      type: "document",
      frame: "main",
      status: 200,
      mime: "text/html",
      failure: null,
    });
    const api = find("/api/json")[0];
    expect(api).toMatchObject({
      method: "GET",
      type: "fetch",
      frame: "main",
      status: 200,
      mime: "application/json",
      failure: null,
    });
    expect(api?.size).toBeGreaterThan(0);
    expect(api?.ms).toBeGreaterThanOrEqual(0);

    // 404：HTTP 上是成功的响应，没有 failure。
    expect(find("/missing.png")[0]).toMatchObject({
      type: "image",
      status: 404,
      mime: "text/plain",
      failure: null,
    });

    // 被掐断的接口：有 failure 与耗时。
    const aborted = find("/abort")[0];
    expect(aborted?.failure).toBeTruthy();
    expect(aborted?.status).toBeNull();
    expect(aborted?.ms).toBeGreaterThanOrEqual(0);

    // 重定向：两跳各一条。
    expect(find("/redirect")[0]).toMatchObject({ status: 302, type: "image" });
    const hop = all.filter((e) => e.url.includes("/img.png"));
    expect(hop).toHaveLength(1);
    expect(hop[0]).toMatchObject({
      status: 200,
      mime: "image/png",
      type: "image",
    });
    expect(hop[0]?.size).toBeGreaterThan(0);

    // iframe 里自己的请求：frame 是 sub。
    expect(find("/inner.json")[0]).toMatchObject({
      type: "fetch",
      frame: "sub",
      status: 200,
    });

    // POST 的条目：requestBodyBytes 是 JSON 正文的长度。
    const post = find("/api/post")[0];
    const detail = await net.detail(post?.id as number);
    expect(detail?.requestBodyBytes).toBe(17);
  });

  test("detail：请求头与响应头的值原样（含令牌）；地址里的令牌参数也原样；不存在的编号是 null", async () => {
    const net = watchNetwork(page);
    const resp = await page.evaluate(() =>
      fetch("/api/json?token=raw-token-value", {
        headers: { authorization: "Bearer secret-token", "x-trace-id": "t1" },
      }).then((r) => r.status),
    );
    expect(resp).toBe(200);
    expect(
      await waitFor(() => net.list().some((e) => e.url.includes("/api/json"))),
    ).toBe(true);
    const entry = net.list().find((e) => e.url.includes("/api/json"));
    // 条目里的地址原样，不打码查询串。
    expect(entry?.url).toContain("token=raw-token-value");
    const detail = await net.detail(entry?.id as number);
    expect(detail?.entry.id).toBe(entry?.id);
    // 头的值原样给。
    expect(detail?.requestHeaders.authorization).toBe("Bearer secret-token");
    expect(detail?.requestHeaders.cookie).toContain("sid=abc123");
    expect(detail?.requestHeaders.accept).toBe("*/*");
    expect(detail?.responseHeaders?.["content-type"]).toContain(
      "application/json",
    );
    expect(detail?.requestBodyBytes).toBe(0);
    // 编号不在缓冲里。
    expect(await net.detail(9999)).toBeNull();
  });

  test("body：请求体与响应体原样取回；失败的、pending 的、没传完的给出原因", async () => {
    const other = await browser.newPage();
    const net = watchNetwork(other);
    await other.goto(url());
    // 等 post / binary 都结束。
    expect(
      await waitFor(() => {
        const all = net.list();
        const post = all.find((e) => e.url.includes("/api/post"));
        const bin = all.find((e) => e.url.includes("/binary"));
        return post?.ms !== null && bin?.ms !== null;
      }),
    ).toBe(true);
    const find = (frag: string) => {
      const hit = net.list().find((e) => e.url.includes(frag));
      if (!hit) throw new Error(`缓冲里没有 ${frag}`);
      return hit;
    };

    // POST 的请求体与响应体。
    const post = find("/api/post");
    const reqBody = await net.body(post.id, "request");
    expect(reqBody).toMatchObject({ ok: true, mime: "application/json" });
    if (reqBody?.ok !== true) throw new Error("取不到请求体");
    expect(reqBody.bytes.toString("utf8")).toBe('{"hello":"world"}');
    const resBody = await net.body(post.id, "response");
    expect(resBody).toMatchObject({ ok: true, mime: "application/json" });
    if (resBody?.ok !== true) throw new Error("取不到响应体");
    expect(JSON.parse(resBody.bytes.toString("utf8"))).toEqual({ ok: true });

    // 没有请求体的 GET。
    expect(await net.body(find("/api/json").id, "request")).toEqual({
      ok: false,
      reason: "这个请求没有请求体",
    });

    // 二进制响应体：字节原样。
    const bin = find("/binary");
    const binBody = await net.body(bin.id, "response");
    expect(binBody).toMatchObject({ ok: true, mime: "image/png" });
    if (binBody?.ok !== true) throw new Error("取不到二进制响应体");
    expect([...binBody.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect([...binBody.bytes.subarray(-3)]).toEqual([0xff, 0xfe, 0x00]);

    // 302 的第一跳：Playwright 报错，reason 是原文的一行。
    const hopBody = await net.body(find("/redirect").id, "response");
    expect(hopBody?.ok).toBe(false);
    if (hopBody?.ok !== false) throw new Error("重定向的响应体不该取到");
    expect(hopBody.reason.length).toBeGreaterThan(0);
    expect(hopBody.reason).not.toContain("\n");

    // 被掐断的接口。
    const abortedBody = await net.body(find("/abort").id, "response");
    expect(abortedBody?.ok).toBe(false);
    if (abortedBody?.ok !== false) throw new Error("失败的请求不该有响应体");
    expect(abortedBody.reason).toContain("请求失败了");

    // 不存在的编号。
    expect(await net.body(9999, "response")).toBeNull();
    await other.close();
  }, 15_000);

  test("body：永不结束的流式响应立即给出原因，不等 body()", async () => {
    const other = await browser.newPage();
    const net = watchNetwork(other);
    await other.goto(url());
    expect(
      await waitFor(() =>
        net.list().some((e) => e.url.includes("/stream") && e.status !== null),
      ),
    ).toBe(true);
    const stream = net.list().find((e) => e.url.includes("/stream"));
    const result = await net.body(stream?.id as number, "response");
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error("流式响应不该取到内容");
    expect(result.reason).toContain("还没传完");
    await other.close();
  }, 5_000);

  test("body：还没响应的请求给出 pending，不等", async () => {
    const other = await browser.newPage();
    const net = watchNetwork(other);
    await other.goto(url());
    await other.evaluate(() => {
      fetch("/api/hang").catch(() => {});
    });
    expect(
      await waitFor(() => net.list().some((e) => e.url.includes("/api/hang"))),
    ).toBe(true);
    const entry = net.list().find((e) => e.url.includes("/api/hang"));
    const result = await Promise.race([
      net.body(entry?.id as number, "response"),
      sleep(3000).then(() => "timeout" as const),
    ]);
    expect(result).toEqual({ ok: false, reason: "请求还没有响应（pending）" });
    await other.close();
  });

  test("detail：还没响应的请求不去等响应，响应头是 null", async () => {
    const other = await browser.newPage();
    const net = watchNetwork(other);
    await other.goto(url());
    // 不 await fetch：它要一直挂到页面关闭。
    await other.evaluate(() => {
      fetch("/api/hang").catch(() => {});
    });
    expect(
      await waitFor(() => net.list().some((e) => e.url.includes("/api/hang"))),
    ).toBe(true);
    const entry = net.list().find((e) => e.url.includes("/api/hang"));
    expect(entry?.status).toBeNull();
    const result = await Promise.race([
      net.detail(entry?.id as number),
      sleep(3000).then(() => "timeout" as const),
    ]);
    if (result === "timeout") throw new Error("detail 在等一个没有响应的请求");
    expect(result?.responseHeaders).toBeNull();
    // 没有响应时只有 headers()：完整的头（含 cookie）要等响应，这里拿到浏览器此刻已知的那部分。
    expect(result?.requestHeaders.referer).toContain("127.0.0.1");
    await other.close();
  });

  test("超过容量：挤掉最旧的，evicted 增加，被挤出的编号查不到详情", async () => {
    const other = await browser.newPage();
    const net = watchNetwork(other, 2);
    await other.goto(url());
    // 逐条串行，保证顺序可预期。
    for (let i = 0; i < 4; i++)
      await other.evaluate(
        (n) => fetch(`/inner.json?n=${n}`).then((r) => r.text()),
        i,
      );
    expect(
      await waitFor(() => net.list().length === 2 && net.evicted() >= 3),
    ).toBe(true);
    const ids = net.list().map((e) => e.id);
    expect(ids.at(-1) ?? 0).toBeGreaterThan(2);
    // 最旧的那条已经挤出去：详情是 null。
    expect(await net.detail((ids[0] ?? 1) - 1)).toBeNull();
    await other.close();
  });
});
