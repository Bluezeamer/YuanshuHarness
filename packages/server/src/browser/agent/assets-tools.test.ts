// assets-tools.ts：browser_assets 的清单分支与保存分支（站点授权、逐个落附件、审计、不碰清洗层与回放）。
// 全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test } from "vitest";
import type { AssetResult, PageAsset } from "../engine/types.js";
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

/** 经工具打开一个公网站点：返回页面编号与它的假页面（打开那一步的审批 / 审计 / 清洗不算进断言）。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  await h.run("browser_open", { target });
  const pageId = h.registry.list("w1")[0]?.id as string;
  h.approvals.length = 0;
  h.audit.length = 0;
  h.cleaner.calls.length = 0;
  return { pageId, page: h.ctx().pageAt(-1) };
}

const asset = (url: string, type: string, extra: Partial<PageAsset> = {}) =>
  ({
    url,
    type,
    mime: "image/png",
    size: null,
    frame: "main",
    ...extra,
  }) as PageAsset;

describe("browser_assets 清单", () => {
  test("不带 urls：只列不存，不审批、不审计、不碰清洗层也不记回放", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.assetList = {
      "": [
        asset("https://example.com/a.png", "image", {
          alt: "普通图",
          width: 40,
          height: 40,
          size: 70,
          mime: "image/png",
        }),
        asset("https://example.com/s.mp3", "media", {
          size: 300 * 1024,
          mime: "audio/mpeg",
        }),
        // 缺省只列 image 与 media：脚本不出现
        asset("https://example.com/app.js", "script", {
          mime: "text/javascript",
        }),
      ],
    };
    const out = textOf(await h.run("browser_assets", { pageId }));
    expect(page.calls).toContain("assets");
    expect(h.saved).toEqual([]);
    expect(h.approvals).toEqual([]);
    expect(h.audit).toEqual([]);
    // 不碰清洗层
    expect(h.cleaner.calls).toEqual([]);
    expect(out).toBe(
      [
        "ASSETS: 示例页 | https://example.com/a",
        "SCOPE: type=image,media",
        "#1 image image/png 70 B 40×40 alt「普通图」 https://example.com/a.png",
        "#2 media audio/mpeg 300.0 KB - https://example.com/s.mp3",
      ].join("\n"),
    );
  });

  test("给 ref：cmd 传下去，SCOPE 行写 ref", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.assetList = { e5: [asset("https://example.com/x.png", "image")] };
    const out = textOf(
      await h.run("browser_assets", { pageId, ref: "e5", type: "IMAGE" }),
    );
    expect(page.calls).toContain("assets e5");
    expect(out).toContain("SCOPE: ref e5 | type=image");
    expect(out).toContain("#1 image image/png - - https://example.com/x.png");
  });

  test("ref 格式不对直接拒", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(h.run("browser_assets", { pageId, ref: "x1" })),
    ).toContain("ref 必须是最近一次快照里的元素编号");
  });

  test("休眠页照样走 registry.use（唤醒后列清单）", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    await h.registry.sleep(pageId);
    const out = textOf(await h.run("browser_assets", { pageId }));
    expect(out).toContain("No assets matched.");
  });
});

describe("browser_assets 保存", () => {
  test("清单内的地址免审批、逐个存附件，文件名走 assetFileName", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.assetList = {
      "": [
        asset("https://example.com/i/chart.png", "image"),
        asset("https://example.com/media", "media", { mime: "audio/mpeg" }),
      ],
    };
    page.assetFetch = [
      {
        url: "https://example.com/i/chart.png",
        ok: true,
        mime: "image/png",
        bytes: Buffer.from("png!"),
        viaRequest: false,
      },
      {
        url: "https://example.com/media",
        ok: true,
        mime: "audio/mpeg",
        bytes: Buffer.from("mp3"),
        viaRequest: true,
      },
    ];
    const out = textOf(
      await h.run("browser_assets", {
        pageId,
        urls: ["https://example.com/i/chart.png", "/media"],
      }),
    );
    expect(h.approvals).toEqual([]);
    expect(h.saved.map((s) => s.name)).toEqual(["chart.png", "media.mp3"]);
    // 相对地址按页面地址解析成绝对地址
    expect(page.calls.filter((c) => c.startsWith("fetchAssets"))).toEqual([
      "fetchAssets https://example.com/i/chart.png,https://example.com/media referer=https://example.com/a",
    ]);
    expect(out).toContain("Saved 2 of 2 assets");
    expect(out).toContain("[attach_file]");
    expect(out).toContain("image/png  4 B  https://example.com/i/chart.png");
    expect(out).toContain(
      "audio/mpeg  3 B  https://example.com/media  (new request)",
    );
  });

  test("清单外的地址要过站点授权：用户拒绝 → 失败项；批准 → 放行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.assetList = { "": [] };
    h.approve = [false, true];
    const out = textOf(
      await h.run("browser_assets", {
        pageId,
        urls: ["https://cdn.test/a.png", "https://other.test/b.png"],
      }),
    );
    expect(h.approvals).toEqual([
      {
        origin: "https://cdn.test",
        reason: "agent 要访问外部站点 https://cdn.test",
      },
      {
        origin: "https://other.test",
        reason: "agent 要访问外部站点 https://other.test",
      },
    ]);
    expect(out).toContain("Saved 1 of 2 assets");
    expect(out).toContain(
      "FAILED https://cdn.test/a.png: 用户没有批准访问 https://cdn.test",
    );
    expect(out).toContain("https://other.test/b.png");
    // 只有批准的那个进了取字节的清单
    expect(page.calls.filter((c) => c.startsWith("fetchAssets"))).toEqual([
      "fetchAssets https://other.test/b.png referer=https://example.com/a",
    ]);
  });

  test("清单外的地址不是 http(s)：直接失败，不问也不取", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const out = textOf(
      await h.run("browser_assets", {
        pageId,
        urls: ["data:image/png;base64,AA"],
      }),
    );
    expect(h.approvals).toEqual([]);
    expect(page.calls.some((c) => c.startsWith("fetchAssets"))).toBe(false);
    expect(out).toBe(
      [
        "Saved 0 of 1 assets",
        "FAILED data:image/png;base64,AA: 清单外的地址只支持 http 与 https",
      ].join("\n"),
    );
  });

  test("解析不了的地址记成失败项", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const out = textOf(
      await h.run("browser_assets", { pageId, urls: ["https://"] }),
    );
    expect(out).toContain("Saved 0 of 1 assets");
    expect(out).toContain("FAILED https://: 地址无法解析成绝对地址");
  });

  test("取字节失败逐个列地址与原因", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.assetList = { "": [asset("https://example.com/a.png", "image")] };
    page.assetFetch = [
      { url: "https://example.com/a.png", ok: false, reason: "HTTP 404" },
    ];
    const out = textOf(
      await h.run("browser_assets", {
        pageId,
        urls: ["https://example.com/a.png"],
      }),
    );
    expect(out).toBe(
      [
        "Saved 0 of 1 assets",
        "FAILED https://example.com/a.png: HTTP 404",
      ].join("\n"),
    );
    expect(h.saved).toEqual([]);
  });

  test("有新请求才写审计，且只写 host（不写路径与查询串）", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.assetList = {
      "": [
        asset("https://example.com/a.png", "image"),
        asset("https://example.com/b.png", "image"),
      ],
    };
    page.assetFetch = [
      {
        url: "https://example.com/a.png",
        ok: true,
        mime: "image/png",
        bytes: Buffer.from("a"),
        viaRequest: false,
      },
      {
        url: "https://cdn.example.com/x.png?token=SECRET",
        ok: true,
        mime: "image/png",
        bytes: Buffer.from("b"),
        viaRequest: true,
      },
    ] as AssetResult[];
    await h.run("browser_assets", {
      pageId,
      urls: [
        "https://example.com/a.png",
        "https://cdn.example.com/x.png?token=SECRET",
      ],
    });
    expect(h.audit).toEqual([
      {
        tool: "browser_assets",
        pageId,
        summary: "保存 2 个资源（其中 1 个新请求：cdn.example.com）",
      },
    ]);
    // 地址不按令牌打码：agent 要把原地址传回 urls
    expect(h.saved).toHaveLength(2);
  });

  test("没有新请求就不写审计", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.assetList = { "": [asset("https://example.com/a.png", "image")] };
    await h.run("browser_assets", {
      pageId,
      urls: ["https://example.com/a.png"],
    });
    expect(h.audit).toEqual([]);
  });

  test("不记回放", async () => {
    const steps: string[] = [];
    const h = makeToolHarness({
      async recordStep(a) {
        steps.push(a.tool);
      },
    });
    const { pageId, page } = await openViaTool(h);
    steps.length = 0;
    page.assetList = { "": [asset("https://example.com/a.png", "image")] };
    page.assetFetch = [
      {
        url: "https://example.com/a.png",
        ok: true,
        mime: "image/png",
        bytes: Buffer.from("a"),
        viaRequest: true,
      },
    ];
    await h.run("browser_assets", { pageId });
    await h.run("browser_assets", {
      pageId,
      urls: ["https://example.com/a.png"],
    });
    expect(steps).toEqual([]);
  });

  test("urls 超过 30 个、空数组都直接报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const many = Array.from(
      { length: 31 },
      (_, i) => `https://a.test/${i}.png`,
    );
    expect(
      await error(h.run("browser_assets", { pageId, urls: many })),
    ).toContain("urls 一次最多 30 个地址，现在 31 个");
    expect(
      await error(h.run("browser_assets", { pageId, urls: [] })),
    ).toContain("urls 不能是空数组");
    expect(
      await error(h.run("browser_assets", { pageId, urls: [1] })),
    ).toContain("urls 的第 1 项必须是非空字符串");
  });

  test("urls 与 ref / type 同时给：ref 与 type 被忽略，不报错", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const out = textOf(
      await h.run("browser_assets", {
        pageId,
        urls: ["https://example.com/a.png"],
        ref: "e5",
        type: "script",
      }),
    );
    expect(out).toContain("Saved 1 of 1 assets");
    // 清单不受 ref / type 限制（只为了判断地址在不在清单里）
    expect(page.calls).toContain("assets");
    expect(page.calls).not.toContain("assets e5");
    // 给了 urls 时 ref / type 根本不看，形状不对也不报错
    expect(
      await textOf(
        await h.run("browser_assets", {
          pageId,
          urls: ["https://example.com/a.png"],
          ref: "not-a-ref",
          type: 42,
        }),
      ),
    ).toContain("Saved 1 of 1 assets");
  });

  test("描述与参数形状：maxItems 30、没有 intent、带不可信声明", async () => {
    const h = makeToolHarness();
    const tools = new Map<
      string,
      {
        description?: string;
        parameters?: {
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }
    >();
    const { browserTools } = await import("./tools.js");
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: {
        name: string;
        description?: string;
        parameters?: unknown;
      }) => tools.set(t.name, t as never),
    } as never);
    const t = tools.get("browser_assets");
    expect(t?.description).toContain("不带 urls 先列清单");
    expect(t?.description).toContain("站点授权");
    expect(t?.description).toContain("不可信");
    const props = t?.parameters?.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([
      "pageId",
      "ref",
      "type",
      "urls",
    ]);
    expect((props.urls as { maxItems?: number }).maxItems).toBe(30);
    expect(props).not.toHaveProperty("intent");
    expect(t?.parameters?.required).toEqual(["pageId"]);
  });
});
