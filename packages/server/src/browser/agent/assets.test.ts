import { describe, expect, test } from "vitest";
import { assetFileName } from "./assets.js";

describe("assetFileName", () => {
  test("普通 URL：取路径最后一段", () => {
    expect(assetFileName("https://a.test/img/photo.png", "image/png")).toBe(
      "photo.png",
    );
    expect(assetFileName("http://a.test:8080/a/b/c.jpg", "image/jpeg")).toBe(
      "c.jpg",
    );
  });

  test("带查询串与片段：都丢掉", () => {
    expect(
      assetFileName("https://a.test/i/chart.webp?w=800&v=2", "image/webp"),
    ).toBe("chart.webp");
    expect(assetFileName("https://a.test/i/a.gif#top", "image/gif")).toBe(
      "a.gif",
    );
  });

  test("百分号编码先解码", () => {
    expect(
      assetFileName("https://a.test/i/%E5%9B%BE%E7%89%87.png", "image/png"),
    ).toBe("图片.png");
    expect(assetFileName("https://a.test/i/my%20shot.jpg", "image/jpeg")).toBe(
      "my shot.jpg",
    );
  });

  test("没有扩展名时按 mime 补；已有扩展名不重复补", () => {
    expect(assetFileName("https://a.test/i/render", "image/png")).toBe(
      "render.png",
    );
    expect(assetFileName("https://a.test/i/render", "image/jpeg")).toBe(
      "render.jpg",
    );
    expect(assetFileName("https://a.test/i/render", "image/svg+xml")).toBe(
      "render.svg",
    );
    // 点在前头不算扩展名（与 sanitizeAttachmentName 的判定一致），按 mime 补
    expect(assetFileName("https://a.test/i/.gitignore", "image/png")).toBe(
      ".gitignore.png",
    );
  });

  test("音视频 / 文档 / 脚本 / 字体都按 mime 补扩展名", () => {
    expect(assetFileName("https://a.test/v/clip", "video/mp4")).toBe(
      "clip.mp4",
    );
    expect(assetFileName("https://a.test/v/clip", "video/webm")).toBe(
      "clip.webm",
    );
    expect(assetFileName("https://a.test/a/song", "audio/mpeg")).toBe(
      "song.mp3",
    );
    expect(assetFileName("https://a.test/a/song", "audio/ogg")).toBe(
      "song.ogg",
    );
    expect(assetFileName("https://a.test/d/report", "application/pdf")).toBe(
      "report.pdf",
    );
    expect(assetFileName("https://a.test/d/data", "application/json")).toBe(
      "data.json",
    );
    expect(assetFileName("https://a.test/c/site", "text/css")).toBe("site.css");
    expect(assetFileName("https://a.test/j/app", "text/javascript")).toBe(
      "app.js",
    );
    expect(assetFileName("https://a.test/p/index", "text/html")).toBe(
      "index.html",
    );
    expect(assetFileName("https://a.test/f/a", "font/woff2")).toBe("a.woff2");
    expect(assetFileName("https://a.test/f/b", "font/woff")).toBe("b.woff");
  });

  test("data: / blob: / 空路径都叫 asset，扩展名照常按 mime 补", () => {
    expect(
      assetFileName("data:image/png;base64,iVBORw0KGgo=", "image/png"),
    ).toBe("asset.png");
    expect(assetFileName("blob:https://a.test/1234-5678", "image/jpeg")).toBe(
      "asset.jpg",
    );
    expect(assetFileName("https://x.test/", "image/webp")).toBe("asset.webp");
    expect(
      assetFileName("data:application/x-foo,abc", "application/x-foo"),
    ).toBe("asset");
  });

  test("mime 不认识时只留名字，不补扩展名", () => {
    expect(
      assetFileName("https://a.test/i/blob", "application/octet-stream"),
    ).toBe("blob");
    expect(assetFileName("https://a.test/i/x.bmp", "image/bmp")).toBe("x.bmp");
  });
});
