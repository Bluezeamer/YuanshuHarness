// 原生下拉框：YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件路径> 才跑，默认跳过。
// 站点由测试自己起的本地 HTTP 服务给，经测试自己的代理转发（引擎的上下文只接受走代理）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { Engine } from "./engine.js";
import type { BrowserCtx, PageHandle } from "./types.js";

const EXE = process.env.YUANSHU_TEST_CHROMIUM ?? "";
const enabled = EXE !== "";
const SITE = "site.test";

// 页面把每次 change 的结果写进 DOM：用来断言事件真的触发了。
const PAGE = `<!doctype html><meta charset=utf-8><title>下拉框页</title>
<select id="city" aria-label="城市">
  <option value="">请选择</option>
  <option value="bj">北京</option>
  <option value="sh">上海</option>
  <option value="gz" disabled>广州</option>
</select>
<select id="tags" aria-label="标签" multiple>
  <option value="a">甲</option>
  <option value="b">乙</option>
</select>
<input id="text" aria-label="文本框" value="旧内容">
<div id="city-out"></div><div id="tags-out"></div><div id="text-out"></div>
<script>
  const $ = (id) => document.getElementById(id);
  $("city").addEventListener("change", (e) => {
    $("city-out").textContent = "城市:" + e.target.selectedOptions[0].textContent;
  });
  $("tags").addEventListener("change", (e) => {
    $("tags-out").textContent =
      "标签:" + Array.from(e.target.selectedOptions).map((o) => o.textContent).join(",");
  });
  $("text").addEventListener("input", (e) => {
    $("text-out").textContent = "文本:" + e.target.value;
  });
</script>`;

const refOf = (snap: string, label: string): string => {
  const line = snap.split("\n").find((l) => l.includes(label));
  const ref = line ? /\[ref=(\w+)\]/.exec(line)?.[1] : undefined;
  if (!ref) throw new Error(`快照里找不到「${label}」的编号：\n${snap}`);
  return ref;
};

async function startSite(): Promise<{
  proxyPort: number;
  close(): Promise<void>;
}> {
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url === "/" ? PAGE : "not found");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  const sitePort = (site.address() as AddressInfo).port;

  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.hostname !== SITE) {
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
        res.writeHead(r.statusCode ?? 502, r.headers);
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
    close: async () => {
      proxy.closeAllConnections();
      site.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await new Promise<void>((r) => site.close(() => r()));
    },
  };
}

describe.skipIf(!enabled)("原生下拉框（真实 Chromium）", () => {
  let engine: Engine;
  let site: Awaited<ReturnType<typeof startSite>>;
  let ctx: BrowserCtx;

  const page = async (): Promise<PageHandle> => {
    const p = await ctx.newPage();
    await p.goto(`http://${SITE}/`);
    return p;
  };

  beforeAll(async () => {
    if (!enabled) return;
    site = await startSite();
    engine = new Engine({
      dataDir: makeTmpDir("ys-select-live-"),
      env: { ...process.env, YUANSHU_BROWSER: EXE },
      log: () => {},
    });
    ctx = await engine.context({
      proxy: {
        server: `http://127.0.0.1:${site.proxyPort}`,
        username: "ctx-token",
        password: "proxy-pass",
      },
    });
  });

  afterAll(async () => {
    if (!enabled) return;
    await ctx?.close().catch(() => {});
    await engine?.close().catch(() => {});
    await site?.close().catch(() => {});
  });

  test("快照里下拉框是 combobox", async () => {
    const p = await page();
    const snap = await p.snapshot();
    expect(snap).toMatch(/combobox "城市"/);
    await p.close();
  }, 30_000);

  test("按 label 选、按 value 选、选空值项，页面的 change 都触发了", async () => {
    const p = await page();
    let snap = await p.snapshot();
    const city = refOf(snap, "城市");

    expect(
      await p.type(city, "北京", { submit: false, perKey: false }),
    ).toEqual({ selected: ["北京"] });
    expect(await p.dom({ selector: "#city-out" })).toBeTruthy();
    snap = await p.snapshot();
    expect(snap).toContain("城市:北京");

    expect(await p.type(city, "sh", { submit: false, perKey: false })).toEqual({
      selected: ["上海"],
    });
    snap = await p.snapshot();
    expect(snap).toContain("城市:上海");

    // 空值项（「请选择」）
    expect(await p.type(city, "", { submit: false, perKey: false })).toEqual({
      selected: ["请选择"],
    });
    snap = await p.snapshot();
    expect(snap).toContain("城市:请选择");
    await p.close();
  }, 30_000);

  test("多选：换行分隔多项，一次都选上，change 给出两项", async () => {
    const p = await page();
    const tags = refOf(await p.snapshot(), "标签");
    expect(
      await p.type(tags, "甲\n乙", { submit: false, perKey: false }),
    ).toEqual({ selected: ["甲", "乙"] });
    expect(await p.snapshot()).toContain("标签:甲,乙");
    await p.close();
  }, 30_000);

  test("没匹配：错误里列出可选项，页面不动", async () => {
    const p = await page();
    const city = refOf(await p.snapshot(), "城市");
    const err = (await p
      .type(city, "深圳", { submit: false, perKey: false })
      .catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      "下拉框 " +
        city +
        " 里没有匹配「深圳」的选项。可选：请选择、北京、上海、广州",
    );
    // 页面里没有 change 记录
    expect(await p.snapshot()).not.toContain("城市:");
    await p.close();
  }, 30_000);

  test("disabled 的选项报错", async () => {
    const p = await page();
    const city = refOf(await p.snapshot(), "城市");
    const err = (await p
      .type(city, "广州", { submit: false, perKey: false })
      .catch((e: Error) => e)) as Error;
    expect(err.message).toBe("选项「广州」被禁用，选不了");
    await p.close();
  }, 30_000);

  test("普通 <input> 的 type 照旧能用（返回 null）", async () => {
    const p = await page();
    const text = refOf(await p.snapshot(), "旧内容");
    expect(
      await p.type(text, "新内容", { submit: false, perKey: false }),
    ).toBeNull();
    expect(await p.snapshot()).toContain("文本:新内容");
    await p.close();
  }, 30_000);
});
