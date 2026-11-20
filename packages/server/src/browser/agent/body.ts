// 请求 / 响应体给模型看的整理：文本内联预览，超长或二进制的整段落附件。
// 只做字节层面的判断，不碰 Playwright，也不猜 mime（能不能解码成 UTF-8 就是分界）。
import { extOfMime } from "./assets.js";
import type { BrowserToolsDeps } from "./deps.js";
import { sizeText } from "./network-view.js";

/** 内联预览的字符上限。 */
export const BODY_PREVIEW_MAX = 4000;

export interface BodyPresentation {
  size: number; // 字节数
  text: string | null; // 文本才有：预览文字（已过 deps.mask，最多 BODY_PREVIEW_MAX 字符）；二进制是 null
  shownChars: number; // 预览里的字符数（text 为 null 时是 0）
  totalChars: number; // 文本全文的字符数（二进制是 0）
  marker: string | null; // 存了附件才有 [attach_file] 标记行
}

/** 把一份字节整理给模型看。name 是附件名（不含扩展名），扩展名由 mime 决定。 */
export async function presentBody(
  deps: BrowserToolsDeps,
  sessionId: string,
  input: { bytes: Buffer; mime: string; name: string },
): Promise<BodyPresentation> {
  const { bytes, mime } = input;
  const max = deps.fileMaxBytes();
  if (bytes.length > max)
    throw new Error(
      `内容有 ${sizeText(bytes.length)}，超过大小上限（${sizeText(max)}）`,
    );

  let decoded: string | null = null;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // 解不成 UTF-8 就是二进制
  }

  if (decoded === null) {
    const saved = await deps.saveAsset({
      sessionId,
      name: `${input.name}.${extOfMime(mime) ?? "bin"}`,
      bytes,
    });
    return {
      size: bytes.length,
      text: null,
      shownChars: 0,
      totalChars: 0,
      marker: saved.marker,
    };
  }

  const full = deps.mask(decoded);
  if (full.length <= BODY_PREVIEW_MAX)
    return {
      size: bytes.length,
      text: full,
      shownChars: full.length,
      totalChars: full.length,
      marker: null,
    };
  const saved = await deps.saveAsset({
    sessionId,
    name: `${input.name}.${extOfMime(mime) ?? "txt"}`,
    bytes: Buffer.from(full, "utf8"),
  });
  return {
    size: bytes.length,
    text: full.slice(0, BODY_PREVIEW_MAX),
    shownChars: BODY_PREVIEW_MAX,
    totalChars: full.length,
    marker: saved.marker,
  };
}
