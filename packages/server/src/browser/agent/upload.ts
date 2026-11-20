// 上传来源文件的解析与硬边界：位置按会话的位置规则解析（session/address.ts，host + path），realpath 之后必须仍在
// 归属目录之内，不能是敏感文件，必须是普通文件，且不超过单文件上限。这一层不看审批档位——越界直接拒绝。
// 文件以内容形式交给浏览器（见 readUploadSource），所以磁盘上不留副本。
import type { Readable } from "node:stream";
import { isInside, isSensitive, pathOf } from "../../permission/paths.js";
import type { Located } from "../../session/address.js";
import { formatSize } from "../../session/attachments.js";

/** 一次最多交几个文件（与工具参数、卡片一致）。 */
export const UPLOAD_MAX_FILES = 5;

/** 一个来源文件：页面看到的文件名、大小、以及打开读流（每个来源只会调用一次）。 */
export interface UploadSource {
  /** 页面看到的文件名（只取 basename） */
  name: string;
  size: number;
  /** 打开读流；每个来源只会调用一次 */
  open(): Promise<Readable>;
}

export interface UploadSourceDeps {
  /** 位置解析（session/address.ts 的 AddressBook.locate）。 */
  locate(host: string | undefined, path: string | undefined): Promise<Located>;
}

export interface ResolvedUpload extends UploadSource {
  /** 给卡片 / 审计看的来源：`host:path` */
  display: string;
}

/** 解析一个来源文件并守住硬边界；任何一条不满足都抛一行英文错误给模型看。 */
export async function resolveUploadFile(
  deps: UploadSourceDeps,
  host: string | undefined,
  path: string,
  maxBytes: number,
): Promise<ResolvedUpload> {
  const at = await deps.locate(host, path);
  const env = at.env;
  const pm = pathOf(env);
  const real = await env.realpath(at.path);
  if (real === null) throw new Error(`File not found: ${at.shown}`);
  if (!isInside(at.directory.path, real, pm))
    throw new Error(
      `The file is not inside its directory "${at.directory.name}" after resolving symlinks, so it cannot be uploaded: ${at.shown}`,
    );
  if (isSensitive(real))
    throw new Error(
      `That is a secret or credential file, so it cannot be uploaded: ${at.shown}`,
    );
  const st = await env.stat(real);
  if (!st?.isFile)
    throw new Error(`Only regular files can be uploaded: ${at.shown}`);
  if (st.size > maxBytes)
    throw new Error(
      `File too large (${formatSize(st.size)}, limit ${formatSize(maxBytes)}): ${at.shown}`,
    );
  return {
    name: pm.basename(real),
    size: st.size,
    display: at.shown,
    open: () => env.readStream(real),
  };
}

/** 读进内存；读到的字节数超过 limit 立刻中止（文件在 stat 之后变大了也不会撑爆内存）。 */
export async function readUploadSource(
  src: UploadSource,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of await src.open()) {
    const buf = chunk as Buffer;
    got += buf.length;
    if (got > limit)
      throw new Error(
        `File too large (read more than ${formatSize(limit)}): ${src.name}`,
      );
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
