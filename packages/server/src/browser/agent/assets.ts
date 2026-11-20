// 保存页面资源时的文件名：URL 路径最后一段，缺扩展名时按 mime 补。
// 非法字符不在这里处理——落盘前还会过 attachments 的 sanitizeAttachmentName。

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/json": "json",
  "text/css": "css",
  "text/javascript": "js",
  "text/html": "html",
  "font/woff2": "woff2",
  "font/woff": "woff",
};

/** mime → 扩展名；表里没有就是 undefined（调用方自己决定回退）。 */
export function extOfMime(mime: string): string | undefined {
  return EXT_BY_MIME[mime];
}

/** `data:` / `blob:` 这类没有文件名的 URL 叫 asset，扩展名照常按 mime 补。 */
export function assetFileName(url: string, mime: string): string {
  let last = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:")
      last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    // 不是合法地址：当作没有文件名
  }
  let name = "";
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  if (name === "") name = "asset";
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return name;
  const ext = EXT_BY_MIME[mime];
  return ext === undefined ? name : `${name}.${ext}`;
}
