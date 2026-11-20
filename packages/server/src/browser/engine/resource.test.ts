import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, test, vi } from "vitest";
import { listResources, loadResources } from "./resource.js";

// 假的 CDP 会话：记录发出去的命令顺序，能按命令预设返回或抛错。
function fakeCdp(
  tree: unknown,
  contents: Record<string, { content: string; base64Encoded: boolean }>,
) {
  const sent: string[] = [];
  const cdp = {
    send: vi.fn(async (name: string, args?: { url?: string }) => {
      sent.push(name);
      if (name === "Page.getResourceTree") return tree;
      if (name !== "Page.getResourceContent") return;
      const hit = args?.url === undefined ? undefined : contents[args.url];
      if (!hit) throw new Error("资源已被回收");
      return hit;
    }),
    detach: vi.fn(async () => {}),
  };
  const ctx = { newCDPSession: async () => cdp } as unknown as BrowserContext;
  return { ctx, sent, cdp };
}

const b64 = (s: string) => ({
  content: Buffer.from(s).toString("base64"),
  base64Encoded: true,
});

/** 主 frame 一张图 / 一份样式 + 子 frame 一张图；另有一条重复地址与一条空地址。 */
const TREE = {
  frameTree: {
    frame: { id: "F1" },
    resources: [
      {
        url: "https://a.test/one.png",
        type: "Image",
        mimeType: "image/png",
        contentSize: 70,
      },
      {
        url: "https://a.test/style.css",
        type: "Stylesheet",
        mimeType: "text/css",
      },
      {
        url: "data:image/gif;base64,AAA",
        type: "Image",
        mimeType: "image/gif",
        contentSize: 0,
      },
      // 同一地址又出现一次：只留一条
      {
        url: "https://a.test/one.png",
        type: "Image",
        mimeType: "image/png",
        contentSize: 70,
      },
      { url: "", type: "Other", mimeType: "" },
    ],
    childFrames: [
      {
        frame: { id: "F2" },
        resources: [
          {
            url: "https://b.test/two.svg",
            type: "Image",
            mimeType: "image/svg+xml",
            contentSize: 2048,
          },
          {
            url: "https://b.test/s.mp3",
            type: "Media",
            mimeType: "audio/mpeg",
          },
        ],
      },
    ],
  },
};

describe("listResources", () => {
  test("所有类型都列；按地址去重；子 frame 带 main:false；type 小写；大小没有或 0 是 null", async () => {
    const { ctx, sent } = fakeCdp(TREE, {});
    const got = await listResources(ctx, {} as Page);
    expect(got.map((r) => [r.url, r.type, r.mime, r.size, r.main])).toEqual([
      ["https://a.test/one.png", "image", "image/png", 70, true],
      ["https://a.test/style.css", "stylesheet", "text/css", null, true],
      ["data:image/gif;base64,AAA", "image", "image/gif", null, true],
      ["https://b.test/two.svg", "image", "image/svg+xml", 2048, false],
      ["https://b.test/s.mp3", "media", "audio/mpeg", null, false],
    ]);
    expect(got.find((r) => r.url === "https://b.test/s.mp3")?.frameId).toBe(
      "F2",
    );
    // 不 enable 时读资源树会报 "Agent is not enabled"。
    expect(sent).toEqual(["Page.enable", "Page.getResourceTree"]);
  });

  test("会话一定 detach；中途抛错也 detach", async () => {
    const { ctx, cdp } = fakeCdp(TREE, {});
    await listResources(ctx, {} as Page);
    expect(cdp.detach).toHaveBeenCalledTimes(1);

    const broken = {
      send: vi.fn(async () => {
        throw new Error("boom");
      }),
      detach: vi.fn(async () => {}),
    };
    const bad = {
      newCDPSession: async () => broken,
    } as unknown as BrowserContext;
    await expect(listResources(bad, {} as Page)).rejects.toThrow("boom");
    expect(broken.detach).toHaveBeenCalledTimes(1);
  });
});

describe("loadResources", () => {
  test("按 url 取回字节；所有类型都能取，递归找到子 frame 里的资源", async () => {
    const { ctx, sent } = fakeCdp(TREE, {
      "https://a.test/one.png": b64("png-bytes"),
      "https://a.test/style.css": { content: "body{}", base64Encoded: false },
      "https://b.test/two.svg": {
        content: "<svg/>",
        base64Encoded: false,
      },
      "data:image/gif;base64,AAA": b64("gif"),
    });
    const got = await loadResources(ctx, {} as Page, [
      "https://a.test/one.png",
      "https://a.test/style.css",
      "https://b.test/two.svg",
      "data:image/gif;base64,AAA",
    ]);
    expect([...got.keys()]).toEqual([
      "https://a.test/one.png",
      "https://a.test/style.css",
      "https://b.test/two.svg",
      "data:image/gif;base64,AAA",
    ]);
    expect(got.get("https://a.test/one.png")).toMatchObject({
      mime: "image/png",
    });
    expect(got.get("https://a.test/one.png")?.bytes.toString()).toBe(
      "png-bytes",
    );
    // base64Encoded:false 是文本（svg / css），要按 utf8 转 Buffer
    expect(got.get("https://b.test/two.svg")?.bytes.toString()).toBe("<svg/>");
    expect(got.get("https://a.test/style.css")?.bytes.toString()).toBe(
      "body{}",
    );
    expect(sent.slice(0, 2)).toEqual(["Page.enable", "Page.getResourceTree"]);
  });

  test("不在资源树里的 URL 不发 getResourceContent", async () => {
    const { ctx, sent } = fakeCdp(TREE, {});
    const got = await loadResources(ctx, {} as Page, [
      "https://a.test/never.png",
    ]);
    expect(got.size).toBe(0);
    expect(sent.filter((s) => s === "Page.getResourceContent")).toHaveLength(0);
  });

  test("单个 URL 取失败只跳过这一个，其余照常", async () => {
    const { ctx } = fakeCdp(TREE, {
      "https://a.test/one.png": b64("png-bytes"),
      // 子 frame 那张故意不给：send 会抛错
    });
    const got = await loadResources(ctx, {} as Page, [
      "https://a.test/one.png",
      "https://b.test/two.svg",
    ]);
    expect([...got.keys()]).toEqual(["https://a.test/one.png"]);
  });

  test("没有 URL 时不开 CDP 会话", async () => {
    const { ctx, cdp } = fakeCdp(TREE, {});
    expect((await loadResources(ctx, {} as Page, [])).size).toBe(0);
    expect(cdp.send).not.toHaveBeenCalled();
  });
});
