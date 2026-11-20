import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  listFiles: vi.fn(),
  makeDir: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock("../../../../api/files", () => api);

import {
  assetsDirOf,
  imageFileName,
  imageLink,
  isImageFile,
  isMarkdownPath,
  linkSeg,
  saveMdImages,
} from "./mdImages";

const file = (name: string, type = "image/png") =>
  new File([new Uint8Array([1, 2, 3])], name, { type });
const names = (entries: string[]) => ({
  ok: true,
  data: { entries: entries.map((name) => ({ name, type: "file" })) },
});

beforeEach(() => {
  api.listFiles.mockReset();
  api.makeDir.mockReset();
  api.uploadFile.mockReset();
  api.listFiles.mockResolvedValue(names([]));
  api.makeDir.mockResolvedValue({ ok: true, data: {} });
  api.uploadFile.mockResolvedValue({ ok: true, data: undefined });
});

test("资源夹是 md 所在目录的 .assets/<去掉扩展名的文件名>", () => {
  expect(assetsDirOf("/w/笔记.md")).toBe("/w/.assets/笔记");
  expect(assetsDirOf("/w/a.b.MD")).toBe("/w/.assets/a.b");
  expect(assetsDirOf("/笔记.markdown")).toBe("/.assets/笔记");
  expect(isMarkdownPath("/w/a.md")).toBe(true);
  expect(isMarkdownPath("/w/a.markdown")).toBe(true);
  expect(isMarkdownPath("/w/a.txt")).toBe(false);
});

test("文件名：粘贴来的截图（泛泛的 image.png）按日期时间命名；有真名字的、拖入的保留原名", () => {
  const now = new Date(2026, 10, 11, 9, 5, 7);
  expect(imageFileName(file("image.png"), "paste", now)).toBe(
    "image-20261111-090507.png",
  );
  expect(imageFileName(file("image.jpeg", "image/jpeg"), "paste", now)).toBe(
    "image-20261111-090507.jpg",
  );
  expect(imageFileName(file("", "image/svg+xml"), "paste", now)).toBe(
    "image-20261111-090507.svg",
  );
  expect(imageFileName(file("架构图.png"), "paste", now)).toBe("架构图.png");
  expect(imageFileName(file("image.png"), "drop", now)).toBe("image.png");
  expect(imageFileName(file("logo.svg", "image/svg+xml"), "drop", now)).toBe(
    "logo.svg",
  );
});

test("只认图片（含 svg）：按 MIME 或扩展名", () => {
  expect(isImageFile(file("a.png"))).toBe(true);
  expect(isImageFile(file("a.svg", "image/svg+xml"))).toBe(true);
  expect(isImageFile(file("a.webp", ""))).toBe(true);
  expect(isImageFile(file("a.pdf", "application/pdf"))).toBe(false);
  expect(isImageFile(file("a.mp4", "video/mp4"))).toBe(false);
});

test("链接地址：空格、括号、百分号等转义，中文保持原样；带 !、相对路径", () => {
  expect(linkSeg("我的 图(1).png")).toBe("我的%20图%281%29.png");
  expect(linkSeg("100%.png")).toBe("100%25.png");
  expect(linkSeg("a#b?.png")).toBe("a%23b%3F.png");
  expect(imageLink("笔记 一", "image 1.png")).toBe(
    "![](./.assets/笔记%20一/image%201.png)",
  );
});

test("存图片：资源夹不存在先建，逐张上传，返回相对路径链接（多张空行隔开）", async () => {
  api.listFiles.mockResolvedValue({ ok: false, kind: "not_found" });
  const r = await saveMdImages(
    "h1",
    "/w/笔记.md",
    [
      file("a.png"),
      file("b.svg", "image/svg+xml"),
      file("notes.pdf", "application/pdf"),
    ],
    "drop",
    "s1",
  );
  expect(api.makeDir).toHaveBeenCalledWith(null, "h1", "/w/.assets/笔记", "s1");
  expect(api.uploadFile.mock.calls.map((c) => c[2])).toEqual([
    "/w/.assets/笔记/a.png",
    "/w/.assets/笔记/b.svg",
  ]);
  expect(api.uploadFile.mock.calls[0]?.[4]).toBe(false);
  expect(r).toEqual({
    ok: true,
    text: "![](./.assets/笔记/a.png)\n\n![](./.assets/笔记/b.svg)",
  });
});

test("重名不覆盖：加 (2)；同一批里重名也错开", async () => {
  api.listFiles.mockResolvedValue(names(["a.png"]));
  const r = await saveMdImages(
    "local",
    "/w/n.md",
    [file("a.png"), file("a.png")],
    "drop",
    null,
  );
  expect(api.uploadFile.mock.calls.map((c) => c[2])).toEqual([
    "/w/.assets/n/a (2).png",
    "/w/.assets/n/a (3).png",
  ]);
  expect(r).toEqual({
    ok: true,
    text: "![](./.assets/n/a%20%282%29.png)\n\n![](./.assets/n/a%20%283%29.png)",
  });
  expect(api.makeDir).not.toHaveBeenCalled();
});

test("没有图片：什么都不做、不碰服务端", async () => {
  const r = await saveMdImages(
    "local",
    "/w/n.md",
    [file("a.pdf", "application/pdf")],
    "paste",
    null,
  );
  expect(r).toEqual({ ok: true, text: null });
  expect(api.listFiles).not.toHaveBeenCalled();
});

test("失败：读不了目录、建不了目录、上传失败都返回原因，不再继续", async () => {
  api.listFiles.mockResolvedValueOnce({ ok: false, kind: "forbidden" });
  let r = await saveMdImages("local", "/w/n.md", [file("a.png")], "drop", null);
  expect(r.ok).toBe(false);
  expect(api.uploadFile).not.toHaveBeenCalled();

  api.listFiles.mockResolvedValueOnce({ ok: false, kind: "not_found" });
  api.makeDir.mockResolvedValueOnce({ ok: false, kind: "forbidden" });
  r = await saveMdImages("local", "/w/n.md", [file("a.png")], "drop", null);
  expect(r).toEqual({ ok: false, why: "没有权限写入这个目录" });

  api.uploadFile.mockResolvedValueOnce({ ok: false, kind: "too_large" });
  r = await saveMdImages("local", "/w/n.md", [file("a.png")], "drop", null);
  expect(r).toEqual({ ok: false, why: "文件太大，服务端拒绝写入" });
});
