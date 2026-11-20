// 预览分类：按扩展名预判（图片/PDF 要整文件取字节），其余先取前 N KB 再据内容类型判断文本或二进制。
import type { RawFailure } from "../../../../api/http";

/** 文本只取前这么多字节：大文件整个拉下来既慢又没法读 */
export const PREVIEW_LIMIT = 256 * 1024;

export const FAIL: Record<RawFailure, string> = {
  unauthorized: "登录已失效，请重新输入访问令牌",
  forbidden: "没有权限读取这个文件",
  not_found: "文件不存在，可能已被移动或删除",
  conflict: "这不是一个普通文件",
  too_large: "文件太大，无法在浏览器里打开",
  network: "网络不通，连不上 Server",
  server: "Server 出错了",
};

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

export const extOf = (path: string): string => {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** 按扩展名能直接判定的类别；其余返回 null，要看内容 */
/** 需要整份字节才能渲染的解析类格式（docx/xlsx/pptx/epub）。 */
export type ParseKind = "docx" | "sheet" | "pptx" | "epub";

// 扩展名 → 解析类格式：Office 三件套（含旧格式与 OpenDocument）、epub。
const PARSE_TYPES: Record<string, ParseKind> = {
  docx: "docx",
  doc: "docx",
  xlsx: "sheet",
  xls: "sheet",
  xlsm: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  pptx: "pptx",
  ppt: "pptx",
  epub: "epub",
};

export type PreviewKind =
  | { kind: "image"; mime: string }
  | { kind: "pdf" }
  | { kind: "markdown" }
  | { kind: ParseKind }
  | { kind: "html" }
  | { kind: "svg" }
  | { kind: "json" };

export function kindByExt(path: string): PreviewKind | null {
  const ext = extOf(path);
  const mime = IMAGE_TYPES[ext];
  if (mime) return { kind: "image", mime };
  if (ext === "pdf") return { kind: "pdf" };
  if (ext === "md" || ext === "markdown") return { kind: "markdown" };
  if (ext === "html" || ext === "htm") return { kind: "html" };
  // svg 本身是文本：既要能当图看，也要能在源码里改
  if (ext === "svg") return { kind: "svg" };
  if (ext === "json" || ext === "jsonc") return { kind: "json" };
  const parse = PARSE_TYPES[ext];
  if (parse) return { kind: parse };
  return null;
}

const isTextType = (t: string) =>
  t.startsWith("text/") ||
  t.startsWith("application/json") ||
  t.startsWith("image/svg+xml");

// 服务端对不认识的扩展名给 octet-stream，这时看开头有没有 NUL 来判断是不是文本
const looksBinary = (b: Uint8Array) => b.subarray(0, 8192).includes(0);

export function isText(contentType: string, bytes: Uint8Array): boolean {
  return (
    isTextType(contentType) ||
    (contentType.startsWith("application/octet-stream") && !looksBinary(bytes))
  );
}

export const baseName = (p: string): string =>
  p.split("/").filter(Boolean).pop() ?? p;

/** 头部标签上的类型名 */
export function kindLabel(path: string, kind: string): string {
  if (kind === "markdown") return "markdown";
  if (kind === "pdf") return "pdf";
  if (kind === "image") return "图片";
  if (kind === "binary") return "二进制";
  if (kind === "docx") return "Word";
  if (kind === "sheet") return "表格";
  if (kind === "pptx") return "幻灯片";
  if (kind === "epub") return "电子书";
  if (kind === "html") return "HTML";
  if (kind === "json") return "JSON";
  if (kind === "svg") return "SVG";
  return extOf(path) || "文本";
}
