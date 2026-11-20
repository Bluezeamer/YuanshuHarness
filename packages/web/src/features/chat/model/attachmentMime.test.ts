import { expect, test } from "vitest";
import { isInlineImageMime } from "./attachmentMime";

test("图片模态只收静态图片，GIF 等按普通文件", () => {
  expect(isInlineImageMime("image/png")).toBe(true);
  expect(isInlineImageMime("image/jpeg")).toBe(true);
  expect(isInlineImageMime("image/webp")).toBe(true);
  expect(isInlineImageMime("image/gif")).toBe(false);
  expect(isInlineImageMime("text/plain")).toBe(false);
});
