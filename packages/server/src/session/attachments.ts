// 会话附件：附件区（虚拟主机 attachment）、附件文件命名/mime/大小格式化，以及注入消息里的
// `[attach_file]` 标记的生成与解析。上传/读取接口、send_message、事件与历史投影共用这一份。
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ExecEnv } from "../env/types.js";
import { VirtualEnv } from "../env/virtual.js";
import { isInside } from "../permission/paths.js";
import type { Directory, DirectoryStore } from "../store/directories.js";
import { ATTACHMENT_ENV_ID } from "../store/environments.js";
import { ATTACHMENT_HOST } from "./address.js";

export const ATTACHMENT_DIRECTORY_NAME = "attachment";
/** 附件引用（事件与历史里给前端展示的形式）。 */
export interface AttachmentRef {
  name: string;
  mime: string;
  sizeText: string;
  path: string;
}

/** 服务端按磁盘重新算出的附件信息，送模型与校验都以此为准。 */
export interface ResolvedAttachment {
  /** 注入标记里用的相对路径（原样保留客户端传来的写法）。 */
  path: string;
  /** 解析符号链接后的绝对路径。 */
  abs: string;
  name: string;
  mime: string;
  size: number;
  sizeText: string;
}

/** 附件按日期分目录；落盘路径里的第一段。 */
export const dayOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** 人类可读大小：`532 B` / `3.3 MB`（1024 进制，去掉多余的 .0）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(1))} ${UNITS[unit]}`;
}

// 按扩展名兜底的常见类型；图片只认魔数（见 imageMimeOf），这里不放 png/jpeg/gif/webp。
const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  xml: "text/xml",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  css: "text/css",
};
const TEXT_EXT = new Set(
  "txt log yaml yml toml ini conf cfg env js mjs cjs ts tsx jsx py rs go java c h cpp hpp cs rb php lua sh bash zsh fish sql diff patch gitignore lock".split(
    " ",
  ),
);

const extOf = (name: string): string => {
  const lower = name.toLowerCase();
  return lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
};

/** 扩展名兜底；不认识的给 application/octet-stream。 */
export function contentTypeFor(name: string): string {
  const ext = extOf(name);
  return (
    TYPES[ext] ??
    (TEXT_EXT.has(ext) ? "text/plain" : "application/octet-stream")
  );
}

/** 按魔数识别四种图片；不是返回 null。 */
export function imageMimeOf(head: Buffer): string | null {
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  )
    return "image/png";
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  )
    return "image/jpeg";
  if (
    head.length >= 4 &&
    head[0] === 0x47 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x38
  )
    return "image/gif";
  if (
    head.length >= 12 &&
    head.toString("latin1", 0, 4) === "RIFF" &&
    head.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

/** 附件 mime：优先魔数，其次扩展名，最后 octet-stream。 */
export function mimeOfFile(head: Buffer, name: string): string {
  return imageMimeOf(head) ?? contentTypeFor(name);
}

/**
 * 会作为图片输入交给模型的 mime：只收静态图片模态。GIF 虽然能按魔数识别，
 * 但多数模型只认静态图，按普通文件走路径引用。
 */
export const MODEL_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const isModelImageMime = (mime: string): boolean =>
  MODEL_IMAGE_MIMES.has(mime);

/** save 存下来的一份附件；字段与上传接口的响应同形。 */
export interface SavedAttachment {
  name: string;
  mime: string;
  size: number;
  sizeText: string;
  path: string;
}

// 限长按 UTF-8 字节：中文一字 3 字节，加上 8 位前缀与 `.part` 临时后缀仍要小于文件系统的 255 字节上限。
const MAX_NAME_BASE = 160;
const MAX_NAME_EXT = 20;

const cutBytes = (s: string, max: number): string => {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    bytes += Buffer.byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out;
};

// 落盘文件名：只换掉路径分隔符、单引号（标记行拿它定界）与控制字符，其余（含中文）原样保留，并各自限长。
// 路径里的目录部分（日期、随机前缀）仍是 ASCII，只有这最后一段文件名可以带非 ASCII。
const cleanSegment = (raw: string, max: number): string =>
  cutBytes(raw.replace(/[\\/']|\p{Cc}/gu, "_"), max) || "_";

/** 把用户给的原始文件名规范成可落盘的安全名（保留扩展名、限长）。 */
export function sanitizeAttachmentName(raw: string): string {
  const dot = raw.lastIndexOf(".");
  const hasExt = dot > 0 && dot < raw.length - 1;
  const base = hasExt ? raw.slice(0, dot) : raw;
  const ext = hasExt ? raw.slice(dot) : "";
  return (
    cleanSegment(base, MAX_NAME_BASE) +
    (ext === "" ? "" : cleanSegment(ext, MAX_NAME_EXT))
  );
}

// 注入给模型的标记行；格式是跨端契约，不要随意改动。
// 地址里的路径是原来相对路径去掉开头的 `./`（前端解析时换回去）。
export const ATTACHMENT_MARKER = "[attach_file]";
const ATTACHMENT_LINE =
  /^\[attach_file\] attachment:\/([^\n]+) \(([^,()\n]+), ([^()\n]+)\)$/;

export const attachmentLine = (a: {
  path: string;
  mime: string;
  sizeText: string;
}): string =>
  `${ATTACHMENT_MARKER} ${ATTACHMENT_HOST}:/${a.path.replace(/^\.\//, "")} (${a.mime}, ${a.sizeText})`;

/** 用户原文后追加空行 + 每个附件一行；没有附件时原样返回。 */
export function injectAttachmentMarkers(
  text: string,
  attachments: readonly { path: string; mime: string; sizeText: string }[],
): string {
  if (attachments.length === 0) return text;
  const block = attachments.map(attachmentLine).join("\n");
  return text.trim() === "" ? block : `${text}\n\n${block}`;
}

/** 落盘文件名去掉随机前缀后就是展示名。 */
export function attachmentNameOfPath(p: string): string {
  const base = path.posix.basename(p);
  return base.replace(/^[0-9a-f]{8}-/, "") || base;
}

/**
 * 从用户消息文本末尾剥离连续的 `[attach_file]` 行并解析成附件引用；返回的 text 只留用户原文。
 * 只有严格匹配契约格式的尾部行才会被剥离，其它内容原样保留。
 */
export function splitAttachmentMarkers(text: string): {
  text: string;
  attachments?: AttachmentRef[];
} {
  const lines = text.split("\n");
  const found: AttachmentRef[] = [];
  for (;;) {
    const last = lines[lines.length - 1];
    if (last === undefined) break;
    const m = ATTACHMENT_LINE.exec(last);
    if (!m) break;
    lines.pop();
    found.unshift({
      name: attachmentNameOfPath(m[1] as string),
      mime: (m[2] as string).trim(),
      sizeText: (m[3] as string).trim(),
      // 事件与前端沿用原来的相对路径形式
      path: `./${m[1]}`,
    });
  }
  if (found.length === 0) return { text };
  // 标记块前有一个空行（用户原文为空时没有）。
  if (lines[lines.length - 1] === "") lines.pop();
  return { text: lines.join("\n"), attachments: found };
}

/**
 * 客户端给的附件路径 → 绝对路径。必须是相对路径、不含 `..`，且落在会话 directory 内；
 * 否则返回 null（越界一律拒绝）。
 */
export function resolveAttachmentPath(
  directoryPath: string,
  raw: unknown,
): string | null {
  if (
    typeof raw !== "string" ||
    raw === "" ||
    raw.length > 4096 ||
    raw.includes("\0") ||
    path.isAbsolute(raw)
  )
    return null;
  if (raw.split(/[\\/]/).includes("..")) return null;
  const abs = path.resolve(directoryPath, raw);
  return isInside(directoryPath, abs) ? abs : null;
}

/** 只读文件头，避免把大文件整个读进内存。 */
export async function readHead(
  env: ExecEnv,
  abs: string,
  size: number,
  max = 16,
): Promise<Buffer> {
  if (size <= 0) return Buffer.alloc(0);
  const stream = await env.readStream(abs, {
    start: 0,
    end: Math.min(size, max) - 1,
  });
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    chunks.push(b);
    got += b.length;
    if (got >= max) break;
  }
  return Buffer.concat(chunks).subarray(0, max);
}

/**
 * 每个属主一块隐藏的 attachment directory（`<data-dir>/attachments/<ownerId>`）。
 * 属主是会话所属的工作区：同一工作区里的根会话、子代理、工作流 agent 看到的是同一块只读空间。
 * 没有工作区的会话（创建中、测试夹具）退回成会话自己。首次上传时惰性创建；
 * 文件原语走虚拟环境，命令执行在环境层就不可用。
 */
export class AttachmentDirectories {
  readonly root: string;
  readonly env: VirtualEnv;

  constructor(
    private readonly directories: DirectoryStore,
    dataDir: string,
    // 会话 id → 属主（工作区 id）；缺省就是会话自己。
    private readonly ownerOf: (sessionId: string) => string = (id) => id,
  ) {
    this.root = path.join(dataDir, "attachments");
    this.env = new VirtualEnv(this.root);
  }

  /** 附件区在磁盘上的位置：按属主，不按会话。 */
  pathOf(sessionId: string): string {
    return path.join(this.root, this.ownerOf(sessionId));
  }

  get(sessionId: string): Directory | undefined {
    return this.directories.getByPath(
      this.pathOf(sessionId),
      ATTACHMENT_ENV_ID,
    );
  }

  /** 首次上传时建目录与 directory；并发请求最终拿到同一行。 */
  async ensure(sessionId: string): Promise<Directory> {
    const dir = this.pathOf(sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const existing = this.directories.getByPath(dir, ATTACHMENT_ENV_ID);
    if (existing) return existing;
    this.directories.create(
      ATTACHMENT_DIRECTORY_NAME,
      dir,
      new Date(),
      ATTACHMENT_ENV_ID,
    );
    const ws = this.directories.getByPath(dir, ATTACHMENT_ENV_ID);
    if (!ws) throw new Error("附件 directory 创建失败");
    return ws;
  }

  /**
   * 会话删除：只清以会话 id 命名的那块（没有工作区、回退成自己的会话）。
   * 按工作区存放的附件区不随会话消失（同一工作区的别的会话还在用），由 removeOwner 在工作区删除时清。
   */
  async removeSession(sessionId: string): Promise<void> {
    await this.removeOwner(sessionId);
  }

  /** 属主（工作区）删除：连目录带 directory 行一起清掉；没上传过东西就什么也不剩，也不报错。 */
  async removeOwner(ownerId: string): Promise<void> {
    const ws = this.directories.getByPath(
      path.join(this.root, ownerId),
      ATTACHMENT_ENV_ID,
    );
    if (ws) this.directories.remove(ws.id);
    await rm(path.join(this.root, ownerId), { recursive: true, force: true });
  }

  /**
   * 分配一个新附件位置：`./<日期>/<8 位 hex>-<安全名>`，并建好日期目录（0700）。
   * 上传接口（流式落盘）与 save 共用这一处命名规则。
   */
  async reserve(
    sessionId: string,
    rawName: string,
  ): Promise<{ relative: string; abs: string; safe: string }> {
    const ws = await this.ensure(sessionId);
    const day = dayOf(new Date());
    const dir = path.join(ws.path, day);
    await this.env.mkdirp(dir, 0o700);
    const safe = sanitizeAttachmentName(rawName);
    const relative = `./${day}/${randomBytes(4).toString("hex")}-${safe}`;
    return { relative, abs: path.join(ws.path, relative.slice(2)), safe };
  }

  /** 把一段字节存成会话附件：先写同目录临时名再 rename，失败不留残文件。 */
  async save(
    sessionId: string,
    rawName: string,
    bytes: Buffer,
  ): Promise<SavedAttachment> {
    return this.saveFrom(sessionId, rawName, (abs) =>
      this.env.writeFile(abs, bytes),
    );
  }

  /**
   * 流式落盘（下载、上传）：write 把内容写到给的临时文件，成功后 rename 成正式附件、
   * 只读文件头嗅探 mime，不把大文件读进内存。
   */
  async saveFrom(
    sessionId: string,
    rawName: string,
    write: (abs: string) => Promise<void>,
  ): Promise<SavedAttachment> {
    const { relative, abs, safe } = await this.reserve(sessionId, rawName);
    const tmp = `${abs}.${randomBytes(4).toString("hex")}.part`;
    let renamed = false;
    try {
      await write(tmp);
      await this.env.rename(tmp, abs);
      renamed = true;
    } finally {
      if (!renamed) await this.env.remove(tmp).catch(() => {});
    }
    const size = (await this.env.stat(abs))?.size ?? 0;
    const head = await readHead(this.env, abs, size);
    return {
      name: rawName,
      mime: mimeOfFile(head, safe),
      size,
      sizeText: formatSize(size),
      path: relative,
    };
  }
}
