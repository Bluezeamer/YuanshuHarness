import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ uploadNoteAsset: vi.fn() }));
vi.mock("../../../../api/canvas", () => api);

import { relativeLink, saveNoteImages } from "./noteImages";

const file = (name: string, type = "image/png") =>
  new File([new Uint8Array([1])], name, { type });

beforeEach(() => {
  api.uploadNoteAsset.mockReset();
});

test("服务端给的相对 .canvas/ 的路径换成相对这篇笔记的链接：去掉笔记所在文件夹、逐段转义、_large 照带", () => {
  expect(relativeLink("访谈.md", ".assets/访谈/a b.png")).toBe(
    "./.assets/访谈/a%20b.png",
  );
  expect(relativeLink("产品/访谈.md", "产品/.assets/访谈/图 (2).png")).toBe(
    "./.assets/访谈/图%20%282%29.png",
  );
  expect(
    relativeLink("产品/访谈.md", "产品/.assets/访谈/_large/clip.png"),
  ).toBe("./.assets/访谈/_large/clip.png");
});

test("逐张上传到笔记的资源夹：用服务端返回的最终路径（重名已被改名）写链接，多张空行隔开；非图片忽略", async () => {
  api.uploadNoteAsset
    .mockResolvedValueOnce({
      ok: true,
      data: { path: "产品/.assets/访谈/a.png", large: false, size: 1 },
    })
    .mockResolvedValueOnce({
      ok: true,
      data: { path: "产品/.assets/访谈/a (2).png", large: false, size: 1 },
    });
  const r = await saveNoteImages(
    "local",
    "/w/proj",
    "产品/访谈.md",
    [file("a.png"), file("x.pdf", "application/pdf"), file("a.png")],
    "drop",
  );
  expect(api.uploadNoteAsset).toHaveBeenCalledTimes(2);
  expect(api.uploadNoteAsset.mock.calls[0]?.slice(1, 4)).toEqual([
    "local",
    "/w/proj",
    "产品/访谈.md",
  ]);
  expect(api.uploadNoteAsset.mock.calls[0]?.[5]).toBe("a.png");
  expect(r).toEqual({
    ok: true,
    text: "![](./.assets/访谈/a.png)\n\n![](./.assets/访谈/a%20%282%29.png)",
  });
});

test("粘贴截图按日期时间命名；没有图片什么都不做；失败给出原因（超限带上限）", async () => {
  api.uploadNoteAsset.mockResolvedValue({
    ok: true,
    data: { path: ".assets/n/x.png", large: false, size: 1 },
  });
  await saveNoteImages("local", "/w", "n.md", [file("image.png")], "paste");
  expect(api.uploadNoteAsset.mock.calls[0]?.[5]).toMatch(
    /^image-\d{8}-\d{6}\.png$/,
  );

  api.uploadNoteAsset.mockClear();
  expect(
    await saveNoteImages(
      "local",
      "/w",
      "n.md",
      [file("a.pdf", "application/pdf")],
      "drop",
    ),
  ).toEqual({ ok: true, text: null });
  expect(api.uploadNoteAsset).not.toHaveBeenCalled();

  api.uploadNoteAsset.mockResolvedValueOnce({
    ok: false,
    kind: "too_large",
    max: 8 * 1024 * 1024,
  });
  expect(
    await saveNoteImages("local", "/w", "n.md", [file("a.png")], "drop"),
  ).toEqual({ ok: false, why: "图片太大（上限 8.0 MB）" });
  api.uploadNoteAsset.mockResolvedValueOnce({ ok: false, kind: "network" });
  expect(
    await saveNoteImages("local", "/w", "n.md", [file("a.png")], "drop"),
  ).toEqual({ ok: false, why: "连不上服务端" });
});
