// 用户内容（文字 + 附件）的唯一解析入口：所有「用户发给 agent 的内容」都经这里。
// 客户端只带附件路径引用，服务端在所属工作区的 attachment directory 内重新 stat / 识别 mime；
// 图片读字节并压缩成 ImageInput，其余只出标记行。越界、不存在、图片但模型不支持一律整体拒绝。
import type { ExecEnv } from "../env/types.js";
import { isInside } from "../permission/paths.js";
import type { ImageCompression } from "../store/defaults.js";
import {
  type AttachmentRef,
  attachmentNameOfPath,
  formatSize,
  injectAttachmentMarkers,
  isModelImageMime,
  mimeOfFile,
  type ResolvedAttachment,
  readHead,
  resolveAttachmentPath,
} from "./attachments.js";
import { compressImage, type ImageResize } from "./image-compression.js";

/** 交给模型的图片输入（SDK 的 ImageContent 同形）。 */
export interface ImageInput {
  mimeType: string;
  data: string;
}

export interface UserContentCtx {
  /** 会话所属工作区的附件区目录与它的执行环境；没有则 null */
  attachmentDir(): { env: ExecEnv; path: string } | null;
  supportsImages(): boolean;
  /** 每次发送现取压缩设置 */
  compression(): ImageCompression;
  resize?: ImageResize;
}

export interface ResolvedContent {
  /** 用户原文 + 空行 + 每个附件一行 `[attach_file]` 标记（没有附件时原样） */
  text: string;
  /** 模型支持且附件里有图片时的压缩后图片；其余为空 */
  images: ImageInput[];
  /** 附件引用：`path` 保持客户端传来的写法，name / mime / sizeText 以磁盘为准 */
  attachments: AttachmentRef[];
}

export class ContentError extends Error {
  /** 给人看的拒绝原因；调用方统一翻成 bad_request。 */
  constructor(message: string) {
    super(message);
  }
}

/** 附件路径 → 磁盘上的真实文件信息；越界与不存在都在这里拒绝。 */
async function resolveOne(
  env: ExecEnv,
  dir: string,
  dirReal: string,
  raw: string,
): Promise<ResolvedAttachment> {
  const abs = resolveAttachmentPath(dir, raw);
  const real = abs ? await env.realpath(abs) : null;
  if (!abs || !real || !isInside(dirReal, real))
    throw new ContentError("附件路径无效");
  const st = await env.stat(real);
  if (!st?.isFile) throw new ContentError("附件不存在，请重新上传");
  const name = attachmentNameOfPath(real);
  const mime = mimeOfFile(await readHead(env, real, st.size), name);
  return {
    path: raw,
    abs: real,
    name,
    mime,
    size: st.size,
    sizeText: formatSize(st.size),
  };
}

export async function resolveUserContent(
  ctx: UserContentCtx,
  text: string,
  paths: readonly string[],
): Promise<ResolvedContent> {
  if (paths.length === 0) return { text, images: [], attachments: [] };
  const dir = ctx.attachmentDir();
  if (!dir) throw new ContentError("附件不存在，请重新上传");
  const dirReal = (await dir.env.realpath(dir.path)) ?? dir.path;
  const resolved: ResolvedAttachment[] = [];
  for (const raw of paths)
    resolved.push(await resolveOne(dir.env, dir.path, dirReal, raw));
  const images: ImageInput[] = [];
  if (resolved.some((a) => isModelImageMime(a.mime))) {
    if (!ctx.supportsImages()) throw new ContentError("当前模型不支持图片输入");
    // 每次发送都重新读设置：设置页保存后，下一条消息就按新参数压缩。
    const cfg = ctx.compression();
    // 非图片不读字节，避免大文件进内存。
    for (const a of resolved) {
      if (!isModelImageMime(a.mime)) continue;
      const bytes = await dir.env.readFile(a.abs);
      images.push(await compressImage(bytes, a.mime, cfg, ctx.resize));
    }
  }
  return {
    text: injectAttachmentMarkers(text, resolved),
    images,
    attachments: resolved.map((a) => ({
      name: a.name,
      mime: a.mime,
      sizeText: a.sizeText,
      path: a.path,
    })),
  };
}
