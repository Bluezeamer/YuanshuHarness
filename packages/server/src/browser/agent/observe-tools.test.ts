// observe-tools.ts 的行为：截图的四种形态与坐标声明、控制台折叠与落文件。
// 全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test } from "vitest";
import {
  cleanupTmpDirs,
  makeToolHarness,
  type ToolHarness,
} from "./testkit.js";

afterAll(cleanupTmpDirs);

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

const error = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return (e as Error).message;
};

/** 经工具打开一个公网站点：返回页面编号与它的假页面。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  await h.run("browser_open", { target });
  const pageId = h.registry.list("w1")[0]?.id as string;
  return { pageId, page: h.ctx().pageAt(-1) };
}

/** 手写一个 PNG 头：签名 + IHDR，宽高是真的，后面无所谓。 */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("browser_screenshot", () => {
  test("视口截图：绕过压缩、图片块就是原字节的 base64，说明写坐标系与可以直接用于 x、y", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    const r = await h.run("browser_screenshot", { pageId });
    expect(page.calls).toContain("screenshot");
    // 不走 modelImage：坐标契约不依赖用户可调的压缩设置
    expect(h.modelImages).toEqual([]);
    expect(r.content[0]).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: Buffer.from("jpeg").toString("base64"),
    });
    expect(h.saved).toEqual([
      { name: "screenshot.jpg", bytes: Buffer.from("jpeg") },
    ]);
    const line = r.content[1]?.text ?? "";
    expect(line).toContain("截图：示例页 https://example.com/a");
    expect(line).toContain("视口截图，坐标系：视口 1280×800，左上角为原点");
    expect(line).toContain(
      "图上的像素位置可直接用于 browser_click / browser_move / browser_drag 的 x、y",
    );
    expect(line).toContain("[attach_file] attachment:");
    expect(line).toContain("the address is shown above");
    expect(line).toContain("transfer_files");
    // 截图不写审计
    expect(h.audit.map((a) => a.tool)).not.toContain("browser_screenshot");
  });

  test("元素截图：调 screenshotOf、走 modelImage、说明写不是视口截图、不能用于点击", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.elementShot = pngHeader(300, 120);
    const r = await h.run("browser_screenshot", { pageId, ref: "e12" });
    expect(page.calls).toContain("screenshotOf e12");
    expect(page.calls).not.toContain("screenshot");
    expect(h.saved.map((s) => s.name)).toEqual(["element-e12.png"]);
    expect(h.modelImages[0]?.mime).toBe("image/png");
    expect(r.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    const line = r.content[1]?.text ?? "";
    expect(line).toContain("元素截图 e12：");
    expect(line).toContain("这不是视口截图");
    expect(line).toContain("原图 300×120");
    expect(line).toContain("图上的位置不能用于点击");
    expect(line).not.toContain("坐标系");
    expect(line).toContain("[attach_file] attachment:");
    expect(h.audit.map((a) => a.tool)).not.toContain("browser_screenshot");
  });

  test("元素截图：读不出 PNG 尺寸时不写尺寸，其余照写", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.elementShot = Buffer.from("not-a-png");
    const line =
      (await h.run("browser_screenshot", { pageId, ref: "e3" })).content[1]
        ?.text ?? "";
    expect(line).toContain("元素截图 e3：");
    expect(line).not.toContain("原图");
    expect(line).toContain("这不是视口截图");
  });

  test("整页截图：调 screenshotFull、走 modelImage、说明写原图尺寸与不能用于点击", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.fullShot = {
      bytes: Buffer.from("fulljpeg"),
      width: 1280,
      height: 2400,
      fullHeight: 2400,
    };
    const r = await h.run("browser_screenshot", { pageId, fullPage: true });
    expect(page.calls).toContain("screenshotFull");
    expect(h.saved).toEqual([
      { name: "fullpage.jpg", bytes: Buffer.from("fulljpeg") },
    ]);
    expect(h.modelImages).toEqual([
      { mime: "image/jpeg", bytes: Buffer.from("fulljpeg") },
    ]);
    const line = r.content[1]?.text ?? "";
    expect(line).toContain("整页截图：");
    expect(line).toContain("这不是视口截图，原图 1280×2400");
    expect(line).toContain("图上的位置不能用于点击");
    expect(line).not.toContain("页面实际高");
    // 模型尺寸与一致时不写那句话
    expect(line).not.toContain("给模型的是");
  });

  test("整页超高：声明页面实际高度与只截了前多少", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.fullShot = {
      bytes: Buffer.from("fulljpeg"),
      width: 1280,
      height: 30_000,
      fullHeight: 35_364,
    };
    const line =
      (await h.run("browser_screenshot", { pageId, fullPage: true })).content[1]
        ?.text ?? "";
    expect(line).toContain("（页面实际高 35364px，只截了前 30000px）");
  });

  test("尺寸声明：给模型的尺寸与原图不同时写出来（整页带看不清细节的提示）", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.fullShot = {
      bytes: Buffer.from("fulljpeg"),
      width: 1280,
      height: 4000,
      fullHeight: 4000,
    };
    h.modelImageSize = { width: 640, height: 2000 };
    const line =
      (await h.run("browser_screenshot", { pageId, fullPage: true })).content[1]
        ?.text ?? "";
    expect(line).toContain("原图 1280×4000");
    expect(line).toContain(
      "；给模型的是 640×2000，看不清细节，要看细节用 ref 或视口截图",
    );
  });

  test("尺寸声明：元素截图只写给模型的尺寸，不带整页那句提示", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.elementShot = pngHeader(1200, 900);
    h.modelImageSize = { width: 600, height: 450 };
    const line =
      (await h.run("browser_screenshot", { pageId, ref: "e7" })).content[1]
        ?.text ?? "";
    expect(line).toContain("原图 1200×900");
    expect(line).toContain("；给模型的是 600×450");
    expect(line).not.toContain("看不清细节");
  });

  test("尺寸声明：modelImage 没返回尺寸就当作原图，不写那句话", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.elementShot = pngHeader(800, 600);
    const line =
      (await h.run("browser_screenshot", { pageId, ref: "e7" })).content[1]
        ?.text ?? "";
    expect(line).toContain("原图 800×600");
    expect(line).not.toContain("给模型的是");
  });

  test("read: false 只存不给图：没有图片块、不调 modelImage，说明里指路去读文件", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const r = await h.run("browser_screenshot", { pageId, read: false });
    expect(r.content.every((b) => b.type === "text")).toBe(true);
    expect(h.modelImages).toEqual([]);
    expect(h.saved.map((s) => s.name)).toEqual(["screenshot.jpg"]);
    const line = textOf(r);
    expect(line).toContain("图没有交给你；要看就用读文件工具读上面的文件");
    expect(line).toContain("[attach_file] attachment:");
  });

  test("ref 与 fullPage 同给报错，说明三选一", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const message = await error(
      h.run("browser_screenshot", { pageId, ref: "e1", fullPage: true }),
    );
    expect(message).toContain(
      "ref、fullPage、区域（fromX/fromY/toX/toY）只能给一个",
    );
    expect(h.saved).toEqual([]);
  });

  test("区域截图：调 screenshotRect、走 modelImage、文件名带矩形、说明写偏移与可用于 x、y", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.rectShot = pngHeader(101, 41);
    const r = await h.run("browser_screenshot", {
      pageId,
      fromX: 10,
      fromY: 20,
      toX: 110,
      toY: 60,
    });
    expect(page.calls).toContain("screenshotRect 10,20 101x41");
    expect(page.calls).not.toContain("screenshot");
    expect(h.saved.map((s) => s.name)).toEqual(["region-10-20-101x41.png"]);
    expect(h.modelImages[0]?.mime).toBe("image/png");
    expect(r.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    const line = r.content[1]?.text ?? "";
    expect(line).toContain("区域截图：示例页 https://example.com/a");
    expect(line).toContain("视口坐标 (10,20)–(110,60) 的裁剪");
    expect(line).toContain("原图 101×41");
    expect(line).toContain(
      "图上位置加上 (10,20) 就是视口坐标，可用于 browser_click / browser_move 的 x、y",
    );
    // 模型尺寸与原图相同：不写缩小那句
    expect(line).not.toContain("给模型的是");
    expect(h.audit.map((a) => a.tool)).not.toContain("browser_screenshot");
  });

  test("区域截图：角点反序也归一（取最小值、宽高含两端）", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_screenshot", {
      pageId,
      fromX: 110,
      fromY: 60,
      toX: 10,
      toY: 20,
    });
    expect(page.calls).toContain("screenshotRect 10,20 101x41");
    expect(h.saved.map((s) => s.name)).toEqual(["region-10-20-101x41.png"]);
    // 说明里的两个角是归一后的左上 / 右下（偏移量必须是真的左上角）
    expect(
      (
        await h.run("browser_screenshot", {
          pageId,
          fromX: 110,
          fromY: 60,
          toX: 10,
          toY: 20,
        })
      ).content[1]?.text,
    ).toContain("视口坐标 (10,20)–(110,60) 的裁剪");
  });

  test("区域截图：同一个点给两次是 1×1，不是空区域", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_screenshot", {
      pageId,
      fromX: 10,
      fromY: 10,
      toX: 10,
      toY: 10,
    });
    expect(page.calls).toContain("screenshotRect 10,10 1x1");
    expect(h.saved.map((s) => s.name)).toEqual(["region-10-10-1x1.png"]);
  });

  test("区域截图：缩小过时说明改成按比例换算，不写那句错话", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.rectShot = pngHeader(1000, 400);
    h.modelImageSize = { width: 500, height: 200 };
    const line =
      (
        await h.run("browser_screenshot", {
          pageId,
          fromX: 0,
          fromY: 0,
          toX: 999,
          toY: 399,
        })
      ).content[1]?.text ?? "";
    expect(line).toContain("原图 1000×400");
    expect(line).toContain("给模型的是 500×200，被缩小过，位置要按比例换算");
    expect(line).not.toContain("加上 (0,0) 就是视口坐标");
  });

  test("区域截图：read: false 只存不给图、不调 modelImage", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const r = await h.run("browser_screenshot", {
      pageId,
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
      read: false,
    });
    expect(r.content.every((b) => b.type === "text")).toBe(true);
    expect(h.modelImages).toEqual([]);
    expect(h.saved.map((s) => s.name)).toEqual(["region-1-2-3x3.png"]);
    expect(textOf(r)).toContain("图没有交给你；要看就用读文件工具读上面的文件");
  });

  test("区域只给部分角点报错", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    expect(
      await error(
        h.run("browser_screenshot", { pageId, fromX: 1, fromY: 2, toX: 3 }),
      ),
    ).toContain("区域要同时给 fromX、fromY、toX、toY");
    expect(page.calls).not.toContain("screenshotRect");
    expect(h.saved).toEqual([]);
  });

  test("区域与 ref / fullPage 互斥，三个一起也不行", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const corners = { fromX: 1, fromY: 2, toX: 3, toY: 4 };
    for (const extra of [
      { ref: "e1" },
      { fullPage: true },
      { ref: "e1", fullPage: true },
    ]) {
      const message = await error(
        h.run("browser_screenshot", { pageId, ...corners, ...extra }),
      );
      expect(message, JSON.stringify(extra)).toContain(
        "ref、fullPage、区域（fromX/fromY/toX/toY）只能给一个",
      );
    }
    expect(h.saved).toEqual([]);
  });

  test("区域坐标越界沿用 coordArg 的写法", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const message = await error(
      h.run("browser_screenshot", {
        pageId,
        fromX: 0,
        fromY: 0,
        toX: 1280,
        toY: 10,
      }),
    );
    expect(message).toContain("x=1280 超出视口");
    expect(message).toContain("应在 0–1279 之间");
  });

  test("ref 格式不对直接拒", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(h.run("browser_screenshot", { pageId, ref: "12" })),
    ).toContain("ref 必须是最近一次快照里的元素编号");
    expect(h.saved).toEqual([]);
  });

  test("休眠页上的截图照样走 registry.use（唤醒后再截）", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    await h.registry.sleep(pageId);
    const r = await h.run("browser_screenshot", { pageId });
    expect(textOf(r)).toContain("截图：");
    expect(h.saved).toHaveLength(1);
  });

  test("描述写明四种形态、区域参数与 read: false", async () => {
    const h = makeToolHarness();
    const descriptions = new Map<string, string>();
    const { browserTools } = await import("./tools.js");
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: { name: string; description?: string }) =>
        descriptions.set(t.name, t.description ?? ""),
    } as never);
    const d = descriptions.get("browser_screenshot") ?? "";
    expect(d).toContain("视口截图");
    expect(d).toContain("fullPage");
    expect(d).toContain("fromX、fromY、toX、toY");
    expect(d).toContain("半个元素");
    expect(d).toContain("ref、fullPage、区域三个只能给一个");
    expect(d).toContain("只有视口截图与区域截图");
    expect(d).toContain("read 为 false 只存附件不给图");
    expect(d).toContain("元素编号来自最近一次快照");
  });
});

describe("browser_console", () => {
  const line = (id: number, text: string) => ({
    id,
    ts: Date.now(),
    firstTs: Date.now(),
    count: 1,
    kind: "console" as const,
    level: "log" as const,
    text,
  });

  test("空缓冲：头行加一句没有消息，不落文件", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(textOf(await h.run("browser_console", { pageId }))).toBe(
      "CONSOLE: 0 entries · 0 distinct · 0 evicted\n(no console messages)",
    );
    expect(h.saved).toEqual([]);
  });

  test("折叠组、按首次出现升序、失败请求单独标出", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.consoleItems = [
      {
        ...line(1, "同一句"),
        count: 3,
        level: "warn",
      },
      {
        ...line(2, "GET /api 500"),
        kind: "request-failed",
        level: "error",
        url: "https://example.com/api?token=***",
      },
    ];
    expect(textOf(await h.run("browser_console", { pageId }))).toBe(
      [
        "CONSOLE: 4 entries · 2 distinct · 0 evicted",
        "[warn] ×3 同一句 · last 0s ago",
        "[request failed] GET /api 500 (https://example.com/api?token=***) · 0s ago",
      ].join("\n"),
    );
    expect(h.saved).toEqual([]);
  });

  test("level 过滤：warn 保留 warn 及以上，头行标出级别", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.consoleItems = [
      line(1, "普通日志"),
      { ...line(2, "警告"), level: "warn" },
      { ...line(3, "报错"), level: "error" },
    ];
    const out = textOf(
      await h.run("browser_console", { pageId, level: "warn" }),
    );
    expect(out.split("\n")).toEqual([
      "CONSOLE: 2 entries · 2 distinct · 0 evicted · level >= warn",
      "[warn] 警告 · 0s ago",
      "[error] 报错 · 0s ago",
    ]);
  });

  test("level 只接受 warn / error", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(h.run("browser_console", { pageId, level: "info" })),
    ).toContain("level 只能是 warn 或 error");
  });

  test("有省略时把全文落成附件，结果里带 FULL LOG 行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.consoleItems = [line(1, "x".repeat(600))];
    const r = await h.run("browser_console", { pageId });
    expect(h.saved.map((s) => s.name)).toEqual([`console-${pageId}.txt`]);
    const full = h.saved[0]?.bytes.toString("utf8") ?? "";
    expect(full).toContain("CONSOLE: 1 entries · 1 distinct · 0 evicted");
    expect(full).toContain(`[log] ×1 ${"x".repeat(600)}`);
    expect(full).not.toContain("chars)");
    const out = textOf(r);
    expect(out).toContain("…(+100 chars)");
    expect(out).toContain("\nFULL LOG: [attach_file] attachment:");
  });

  test("没有省略就不落文件", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.consoleItems = [line(1, "短消息")];
    const out = textOf(await h.run("browser_console", { pageId }));
    expect(h.saved).toEqual([]);
    expect(out).not.toContain("FULL LOG");
  });

  test("缓冲挤掉过也算省略：落文件并声明挤掉次数", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.consoleItems = [line(1, "一条")];
    page.consoleDropped = 5;
    const r = await h.run("browser_console", { pageId });
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.bytes.toString("utf8")).toContain(
      "(5 earlier occurrences were evicted from the buffer and are not in this file)",
    );
    expect(textOf(r)).toContain("5 evicted");
  });
});
