import type { ResizedImage } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { PI_IMAGE_COMPRESSION } from "../store/defaults.js";
import { compressImage, type ImageResize } from "./image-compression.js";

const bytes = Buffer.from("original-image-bytes");
const mime = "image/png";

const resized: ResizedImage = {
  data: "resized-base64",
  mimeType: "image/jpeg",
  originalWidth: 4000,
  originalHeight: 3000,
  width: 1200,
  height: 900,
  wasResized: true,
};

const fake = (result: ResizedImage | null): ImageResize =>
  vi.fn(async () => result);

test("开启压缩：按设置调用 resizeImage，返回压缩后的 mime 与 base64", async () => {
  const resize = fake(resized);
  const out = await compressImage(
    bytes,
    mime,
    {
      ...PI_IMAGE_COMPRESSION,
      maxWidth: 1200,
      maxHeight: 900,
      jpegQuality: 60,
    },
    resize,
  );
  // 压缩成功时带上交给模型的尺寸
  expect(out).toEqual({
    mimeType: "image/jpeg",
    data: "resized-base64",
    width: 1200,
    height: 900,
  });
  expect(resize).toHaveBeenCalledTimes(1);
  expect(resize).toHaveBeenCalledWith(bytes, mime, {
    maxWidth: 1200,
    maxHeight: 900,
    // 没覆盖的字段用设置里的值
    maxBytes: PI_IMAGE_COMPRESSION.maxBytes,
    jpegQuality: 60,
  });
});

test("关闭压缩：不调用 resizeImage，原图 base64 返回", async () => {
  const resize = fake(resized);
  const out = await compressImage(
    bytes,
    mime,
    { ...PI_IMAGE_COMPRESSION, enabled: false },
    resize,
  );
  expect(out).toEqual({
    mimeType: mime,
    data: bytes.toString("base64"),
  });
  expect(resize).not.toHaveBeenCalled();
});

test("压缩器说没缩（wasResized: false）也带上尺寸：交给模型的尺寸仍然成立", async () => {
  const same: ResizedImage = {
    ...resized,
    width: 4000,
    height: 3000,
    wasResized: false,
  };
  const out = await compressImage(
    bytes,
    mime,
    PI_IMAGE_COMPRESSION,
    fake(same),
  );
  expect(out).toEqual({
    mimeType: "image/jpeg",
    data: "resized-base64",
    width: 4000,
    height: 3000,
  });
});

test("压缩失败（resizeImage 返回 null）：回退原图，不拦截消息，不给尺寸", async () => {
  const resize = fake(null);
  const out = await compressImage(bytes, mime, PI_IMAGE_COMPRESSION, resize);
  expect(out).toEqual({
    mimeType: mime,
    data: bytes.toString("base64"),
  });
  expect(resize).toHaveBeenCalledTimes(1);
});
