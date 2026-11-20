// 图片模态只收静态图片：GIF 等动图在模型侧按普通文件处理（多数模型只认静态图）。
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const isInlineImageMime = (mime: string): boolean =>
  INLINE_IMAGE_MIMES.has(mime.toLowerCase());
