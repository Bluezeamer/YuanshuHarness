// assets-view.ts：清单行与保存结果文字的渲染规则（纯函数）。
import { describe, expect, test } from "vitest";
import type { PageAsset } from "../engine/types.js";
import { renderAssetList, renderSaveResult } from "./assets-view.js";

const asset = (extra: Partial<PageAsset> = {}): PageAsset => ({
  url: "https://host/a.png",
  type: "image",
  mime: "image/png",
  size: 70,
  frame: "main",
  ...extra,
});

const query = {
  title: "示例页",
  url: "https://host/page",
  types: ["image", "media"],
};

describe("renderAssetList", () => {
  test("外壳两行 + 一行一个资源；宽高与 alt 只有图片有", () => {
    expect(
      renderAssetList(
        [
          asset({ alt: "普通图", width: 40, height: 40 }),
          asset({
            url: "https://host/s.mp3",
            type: "media",
            mime: "audio/mpeg",
            size: 300 * 1024,
          }),
        ],
        query,
      ),
    ).toBe(
      [
        "ASSETS: 示例页 | https://host/page",
        "SCOPE: type=image,media",
        "#1 image image/png 70 B 40×40 alt「普通图」 https://host/a.png",
        "#2 media audio/mpeg 300.0 KB - https://host/s.mp3",
      ].join("\n"),
    );
  });

  test("大小写成 B / KB / MB；没有大小写 -，没有 mime 也写 -", () => {
    const lines = renderAssetList(
      [
        asset({ size: 999, mime: "", width: 1, height: 1 }),
        asset({ size: 2048, width: 2, height: 2 }),
        asset({ size: 5 * 1024 * 1024, width: 3, height: 3 }),
      ],
      query,
    ).split("\n");
    expect(lines[2]).toBe("#1 image - 999 B 1×1 https://host/a.png");
    expect(lines[3]).toBe("#2 image image/png 2.0 KB 2×2 https://host/a.png");
    expect(lines[4]).toBe("#3 image image/png 5.0 MB 3×3 https://host/a.png");
  });

  test("子 frame 的行末写 [iframe]；data: 地址写成说明", () => {
    const out = renderAssetList(
      [
        asset({
          url: "data:image/svg+xml;base64,AAA",
          frame: "sub",
          mime: "image/svg+xml",
          alt: "懒加载图",
          width: 120,
          height: 80,
          size: 72,
        }),
      ],
      query,
    );
    expect(out).toContain(
      "#1 image image/svg+xml 72 B 120×80 alt「懒加载图」 data:image/svg+xml (29 chars) [iframe]",
    );
  });

  test("SCOPE 行：给了 ref 就写，type 按给的写", () => {
    const out = renderAssetList([asset({ type: "script" })], {
      ...query,
      ref: "e12",
      types: ["script", "stylesheet"],
    });
    expect(out.split("\n")[1]).toBe("SCOPE: ref e12 | type=script,stylesheet");
  });

  test("按类型筛（不分大小写），缺省之外的类型靠调用方传的 types", () => {
    const out = renderAssetList(
      [
        asset({ type: "image" }),
        asset({
          url: "https://host/app.js",
          type: "script",
          mime: "text/javascript",
        }),
      ],
      query,
    );
    expect(out).not.toContain("app.js");
    expect(renderAssetList([asset({ type: "IMAGE" })], query)).toContain(
      "https://host/a.png",
    );
  });

  test("最多 100 行，多出的只写个数", () => {
    const many = Array.from({ length: 103 }, (_, i) =>
      asset({ url: `https://host/${i}.png` }),
    );
    const lines = renderAssetList(many, query).split("\n");
    expect(lines.filter((l) => l.startsWith("#"))).toHaveLength(100);
    expect(lines.at(-1)).toBe(
      "… 3 more rows not listed (narrow with type or ref)",
    );
  });

  test("没有资源：No assets matched.", () => {
    expect(renderAssetList([], query)).toBe(
      [
        "ASSETS: 示例页 | https://host/page",
        "SCOPE: type=image,media",
        "No assets matched.",
      ].join("\n"),
    );
  });
});

describe("renderSaveResult", () => {
  test("头行计数 + 成功行（标记、mime、大小、地址）+ 失败行", () => {
    expect(
      renderSaveResult([
        {
          url: "https://host/a.png",
          ok: true,
          marker: "[attach_file] attachment:/a.png",
          mime: "image/png",
          size: 70,
          viaRequest: false,
        },
        {
          url: "https://host/s.mp3",
          ok: true,
          marker: "[attach_file] attachment:/s.mp3",
          mime: "audio/mpeg",
          size: 300 * 1024,
          viaRequest: true,
        },
        { url: "https://host/missing.png", ok: false, reason: "HTTP 404" },
      ]),
    ).toBe(
      [
        "Saved 2 of 3 assets",
        "[attach_file] attachment:/a.png  image/png  70 B  https://host/a.png",
        "[attach_file] attachment:/s.mp3  audio/mpeg  300.0 KB  https://host/s.mp3  (new request)",
        "FAILED https://host/missing.png: HTTP 404",
      ].join("\n"),
    );
  });

  test("全部失败：头行写 0", () => {
    expect(
      renderSaveResult([
        { url: "https://host/a.png", ok: false, reason: "HTTP 500" },
      ]),
    ).toBe(
      ["Saved 0 of 1 assets", "FAILED https://host/a.png: HTTP 500"].join("\n"),
    );
  });
});
