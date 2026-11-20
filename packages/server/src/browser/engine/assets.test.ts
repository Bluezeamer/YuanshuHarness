// engine/assets.ts：清单（资源树 + 页面里的 <img> 补 alt / 宽高 + ref 求交）与取字节（缓存优先、取不到发新请求）。
// 用假 Page / 假 ctx：不发真请求，网络部分的真行为在 assets.live.test.ts。
import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, test, vi } from "vitest";
import {
  collectImages,
  collectRefUrls,
  fetchAssets,
  listAssets,
} from "./assets.js";
import type { AssetResult } from "./types.js";

const b64 = (s: string) => ({
  content: Buffer.from(s).toString("base64"),
  base64Encoded: true,
});

/** 资源树：一张主 frame 图、一张子 frame 图、一份样式、一段音频、一个 data: 图。 */
const TREE = {
  frameTree: {
    frame: { id: "F1" },
    resources: [
      {
        url: "https://a.test/a.png",
        type: "Image",
        mimeType: "image/png",
        contentSize: 70,
      },
      {
        url: "https://a.test/site.css",
        type: "Stylesheet",
        mimeType: "text/css",
        contentSize: 2048,
      },
      {
        url: "https://a.test/s.mp3",
        type: "Media",
        mimeType: "audio/mpeg",
        contentSize: 300 * 1024,
      },
      {
        url: "data:image/gif;base64,AAA",
        type: "Image",
        mimeType: "image/gif",
      },
    ],
    childFrames: [
      {
        frame: { id: "F2" },
        resources: [
          {
            url: "https://b.test/b.png",
            type: "Image",
            mimeType: "image/png",
            contentSize: 120,
          },
        ],
      },
    ],
  },
};

function fakeCdp(
  tree: unknown,
  contents: Record<string, { content: string; base64Encoded: boolean }> = {},
) {
  const send = vi.fn(async (name: string, args?: { url?: string }) => {
    if (name === "Page.getResourceTree") return tree;
    if (name !== "Page.getResourceContent") return;
    const hit = args?.url === undefined ? undefined : contents[args.url];
    if (!hit) throw new Error("资源已被回收");
    return hit;
  });
  const cdp = { send, detach: vi.fn(async () => {}) };
  const ctx = { newCDPSession: async () => cdp } as unknown as BrowserContext;
  return { ctx, send };
}

/** 页面里收集到的 <img>（模拟 collectImages 的结果）。 */
const IMG = (src: string, alt: string, w: number, h: number) => ({
  src,
  alt,
  width: w,
  height: h,
});

/** 假页面：整页 evaluate 给一组 <img>；locator 给 ref 范围的结果。 */
function fakePage(
  opts: {
    images?: ReturnType<typeof IMG>[];
    refImages?: ReturnType<typeof IMG>[];
    refUrls?: string[];
  } = {},
) {
  const images = opts.images ?? [];
  const calls: string[] = [];
  const locator = {
    evaluate: async (fn: { name?: string }) => {
      calls.push(`locator.evaluate ${fn.name}`);
      return fn.name === "collectRefUrls"
        ? (opts.refUrls ?? [])
        : (opts.refImages ?? []);
    },
  };
  const page = {
    evaluate: async () => {
      calls.push("page.evaluate");
      return images;
    },
    locator: (selector: string) => {
      calls.push(`locator ${selector}`);
      return locator;
    },
  } as unknown as Page;
  return { page, calls };
}

describe("listAssets", () => {
  test("列所有类型；图片按地址补 alt 与宽高；子 frame 标 sub；对不上的图不补", async () => {
    const { ctx } = fakeCdp(TREE);
    const { page, calls } = fakePage({
      images: [
        IMG("https://a.test/a.png", "普通图", 40, 40),
        IMG("https://b.test/b.png", "框里的图", 120, 80),
      ],
    });
    const got = await listAssets(ctx, page);
    expect(calls).toEqual(["page.evaluate"]);
    expect(got).toEqual([
      {
        url: "https://a.test/a.png",
        type: "image",
        mime: "image/png",
        size: 70,
        frame: "main",
        alt: "普通图",
        width: 40,
        height: 40,
      },
      {
        url: "https://a.test/site.css",
        type: "stylesheet",
        mime: "text/css",
        size: 2048,
        frame: "main",
      },
      {
        url: "https://a.test/s.mp3",
        type: "media",
        mime: "audio/mpeg",
        size: 300 * 1024,
        frame: "main",
      },
      {
        url: "data:image/gif;base64,AAA",
        type: "image",
        mime: "image/gif",
        size: null,
        frame: "main",
      },
      {
        url: "https://b.test/b.png",
        type: "image",
        mime: "image/png",
        size: 120,
        frame: "sub",
        alt: "框里的图",
        width: 120,
        height: 80,
      },
    ]);
  });

  test("ref：只留这个元素子树里引用的地址（资源树里没有的不出现）", async () => {
    const { ctx } = fakeCdp(TREE);
    const { page, calls } = fakePage({
      refImages: [IMG("https://a.test/a.png", "图", 40, 40)],
      refUrls: ["https://a.test/a.png", "https://a.test/never.png"],
    });
    const got = await listAssets(ctx, page, { ref: "e12" });
    expect(calls).toContain("locator aria-ref=e12");
    expect(calls).toContain("locator.evaluate collectImages");
    expect(calls).toContain("locator.evaluate collectRefUrls");
    expect(got.map((a) => a.url)).toEqual(["https://a.test/a.png"]);
    expect(got[0]?.alt).toBe("图");
  });
});

describe("collectImages（在页面里跑）", () => {
  /** 假 <img>：只带 collectImages 会读的字段。 */
  const img = (
    src: string,
    opts: { alt?: string; w?: number; h?: number; complete?: boolean } = {},
  ) => ({
    tagName: "IMG",
    currentSrc: src,
    alt: opts.alt ?? "",
    naturalWidth: opts.w ?? 800,
    naturalHeight: opts.h ?? 600,
    complete: opts.complete ?? true,
    // 真的 <img> 也有 querySelectorAll：指到图片本身时不该去查它的后代。
    querySelectorAll: () => {
      throw new Error("指到 <img> 本身时不该查后代");
    },
  });

  const scope = (images: ReturnType<typeof img>[]) => ({
    querySelectorAll: () => images,
  });

  test("容器里收所有 <img>：跳过没加载完的与 currentSrc 为空的", () => {
    expect(
      collectImages(
        scope([
          img("https://a.test/1.png", { alt: "一" }),
          img("https://a.test/2.png", { complete: false }),
          img(""),
        ]),
      ),
    ).toEqual([
      { src: "https://a.test/1.png", alt: "一", width: 800, height: 600 },
    ]);
  });

  test("ref 指到 <img> 本身时只有它（<img> 也有 querySelectorAll，不靠它判断）", () => {
    const one = img("https://a.test/x.png", { alt: "x", w: 300, h: 200 });
    expect(collectImages(one)).toEqual([
      { src: "https://a.test/x.png", alt: "x", width: 300, height: 200 },
    ]);
  });

  test("容器里没有图时收不到东西", () => {
    expect(collectImages(scope([]))).toEqual([]);
  });
});

describe("collectRefUrls（在页面里跑）", () => {
  const media = (tagName: string, src: string, poster: string | null) => ({
    tagName,
    currentSrc: src,
    getAttribute: (name: string) => (name === "poster" ? poster : null),
  });

  test("收 img 的 currentSrc 与 video / audio 的 currentSrc + poster，去重", () => {
    expect(
      collectRefUrls({
        baseURI: "https://a.test/dir/",
        querySelectorAll: () => [
          media("IMG", "https://a.test/a.png", null),
          media("VIDEO", "https://a.test/v.mp4", "poster.jpg"),
          media("AUDIO", "https://a.test/v.mp4", null),
        ],
      }),
    ).toEqual([
      "https://a.test/a.png",
      "https://a.test/v.mp4",
      "https://a.test/dir/poster.jpg",
    ]);
  });

  test("指到元素本身时只有它；空地址跳过", () => {
    expect(collectRefUrls(media("VIDEO", "", "https://a.test/p.jpg"))).toEqual([
      "https://a.test/p.jpg",
    ]);
  });
});

describe("fetchAssets", () => {
  const collect = async (
    ctx: BrowserContext,
    urls: string[],
    maxBytes = 1 << 20,
  ) => {
    const { page } = fakePage();
    const got: AssetResult[] = [];
    await fetchAssets(
      ctx,
      page,
      urls,
      { referer: "https://a.test/", maxBytes },
      async (r) => {
        got.push(r);
      },
    );
    return got;
  };

  test("缓存里有的不发新请求", async () => {
    const { ctx, send } = fakeCdp(TREE, { "https://a.test/a.png": b64("png") });
    const request = { get: vi.fn() };
    const withReq = { ...ctx, request } as unknown as BrowserContext;
    const got = await collect(withReq, ["https://a.test/a.png"]);
    expect(got).toEqual([
      {
        url: "https://a.test/a.png",
        ok: true,
        mime: "image/png",
        bytes: Buffer.from("png"),
        viaRequest: false,
      },
    ]);
    expect(request.get).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Page.getResourceContent", {
      frameId: "F1",
      url: "https://a.test/a.png",
    });
  });

  test("缓存取不到（音频这类）就发新请求，带 referer，走本上下文", async () => {
    const { ctx } = fakeCdp(TREE, {});
    const dispose = vi.fn(async () => {});
    const get = vi.fn(async () => ({
      headers: () => ({ "content-type": "audio/mpeg; charset=binary" }),
      status: () => 200,
      body: async () => Buffer.from("mp3"),
      dispose,
    }));
    const withReq = { ...ctx, request: { get } } as unknown as BrowserContext;
    const got = await collect(withReq, ["https://a.test/s.mp3"]);
    expect(get).toHaveBeenCalledWith("https://a.test/s.mp3", {
      headers: { referer: "https://a.test/" },
      timeout: 30_000,
      failOnStatusCode: false,
    });
    expect(got).toEqual([
      {
        url: "https://a.test/s.mp3",
        ok: true,
        mime: "audio/mpeg",
        bytes: Buffer.from("mp3"),
        viaRequest: true,
      },
    ]);
    // 响应体要释放，否则 Playwright 一直留在上下文里
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("非 2xx：失败原因写 HTTP 状态码", async () => {
    const { ctx } = fakeCdp(TREE, {});
    const dispose = vi.fn(async () => {});
    const withReq = {
      ...ctx,
      request: {
        get: async () => ({
          headers: () => ({}),
          status: () => 404,
          body: async () => Buffer.alloc(0),
          dispose,
        }),
      },
    } as unknown as BrowserContext;
    expect(await collect(withReq, ["https://a.test/missing.png"])).toEqual([
      { url: "https://a.test/missing.png", ok: false, reason: "HTTP 404" },
    ]);
    // 失败的响应同样要释放
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("X-Yuanshu-Deny：写成网络层的拒绝文字", async () => {
    const { ctx } = fakeCdp(TREE, {});
    const withReq = {
      ...ctx,
      request: {
        get: async () => ({
          headers: () => ({ "x-yuanshu-deny": "blocked_address" }),
          status: () => 403,
          body: async () => Buffer.alloc(0),
          dispose: async () => {},
        }),
      },
    } as unknown as BrowserContext;
    const got = await collect(withReq, ["https://a.test/x.png"]);
    expect(got[0]?.ok).toBe(false);
    expect(got).toMatchObject([
      {
        url: "https://a.test/x.png",
        ok: false,
        reason: expect.stringContaining("内网"),
      },
    ]);
  });

  test("超过大小上限：缓存与新请求两条路都写清上限", async () => {
    const { ctx } = fakeCdp(TREE, {
      "https://a.test/a.png": b64("0123456789"),
    });
    const withReq = {
      ...ctx,
      request: {
        get: async () => ({
          headers: () => ({ "content-type": "image/png" }),
          status: () => 200,
          body: async () => Buffer.alloc(64),
          dispose: async () => {},
        }),
      },
    } as unknown as BrowserContext;
    const got = await collect(
      withReq,
      ["https://a.test/a.png", "https://b.test/b.png"],
      8,
    );
    expect(got).toEqual([
      {
        url: "https://a.test/a.png",
        ok: false,
        reason: "超过大小上限（8 B）",
      },
      {
        url: "https://b.test/b.png",
        ok: false,
        reason: "超过大小上限（8 B）",
      },
    ]);
  });

  test("网络错误：取 Playwright 报错的第一行", async () => {
    const { ctx } = fakeCdp(TREE, {});
    const withReq = {
      ...ctx,
      request: {
        get: async () => {
          throw new Error(
            "apiRequestContext.get: connect ECONNREFUSED\nCall log:\n  - GET",
          );
        },
      },
    } as unknown as BrowserContext;
    expect(await collect(withReq, ["https://a.test/x.png"])).toEqual([
      {
        url: "https://a.test/x.png",
        ok: false,
        reason: "apiRequestContext.get: connect ECONNREFUSED",
      },
    ]);
  });

  test("data: 这类只在浏览器里的地址：缓存取不到就没有别处可取", async () => {
    const { ctx } = fakeCdp(TREE, {});
    const get = vi.fn();
    const withReq = { ...ctx, request: { get } } as unknown as BrowserContext;
    expect(await collect(withReq, ["data:image/gif;base64,AAA"])).toEqual([
      {
        url: "data:image/gif;base64,AAA",
        ok: false,
        reason: "浏览器缓存里没有这份资源",
      },
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  test("逐个回调：顺序与传入顺序一致，中间失败不影响后面", async () => {
    const { ctx } = fakeCdp(TREE, {
      "https://a.test/a.png": b64("png"),
      "https://a.test/s.mp3": b64("mp3"),
    });
    const got = await collect(ctx, [
      "https://a.test/a.png",
      "https://a.test/never.png",
      "https://a.test/s.mp3",
    ]);
    expect(got.map((r) => [r.url, r.ok])).toEqual([
      ["https://a.test/a.png", true],
      ["https://a.test/never.png", false],
      ["https://a.test/s.mp3", true],
    ]);
  });
});
