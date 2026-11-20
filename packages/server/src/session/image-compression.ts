// 输入图片压缩：按设置页里的参数把用户发送的图片缩到上限内再交给模型。
// 与 pi 的 processImage 同源（同一个 resizeImage），但参数由服务端默认值实时决定。
import {
  type ResizedImage,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import type { ImageCompression } from "../store/defaults.js";

/** 可替换的压缩实现；测试用它省掉真实 WASM 压缩。 */
export type ImageResize = (
  bytes: Uint8Array,
  mimeType: string,
  options: {
    maxWidth: number;
    maxHeight: number;
    maxBytes: number;
    jpegQuality: number;
  },
) => Promise<ResizedImage | null>;

export interface CompressedImage {
  mimeType: string;
  /** 不带前缀的 base64。 */
  data: string;
  /** 交给模型的图片宽高；回退原图时不给（调用方自己知道原图尺寸）。 */
  width?: number;
  height?: number;
}

/**
 * 压缩一张图片；关闭压缩或压缩失败（resizeImage 返回 null：光子 WASM 不可用、压不到上限）
 * 时回退原图，不拦截消息，由模型/供应商决定是否接受。
 */
export async function compressImage(
  bytes: Uint8Array,
  mimeType: string,
  cfg: ImageCompression,
  resize: ImageResize = resizeImage as ImageResize,
): Promise<CompressedImage> {
  if (cfg.enabled) {
    const resized = await resize(bytes, mimeType, {
      maxWidth: cfg.maxWidth,
      maxHeight: cfg.maxHeight,
      maxBytes: cfg.maxBytes,
      jpegQuality: cfg.jpegQuality,
    });
    if (resized)
      return {
        mimeType: resized.mimeType,
        data: resized.data,
        width: resized.width,
        height: resized.height,
      };
  }
  return { mimeType, data: Buffer.from(bytes).toString("base64") };
}
