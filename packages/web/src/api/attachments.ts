// 会话附件：上传（XHR，带进度）与按 path 读取内容。
// 上传成功后拿到相对 attachment directory 的 path，发送时只带引用；附件标记行由服务端注入。
import { enc, type RawFailure, raw } from "./http";

/** 上传接口的返回：name 是原始文件名，path 是相对 attachment directory 的路径（目录部分 ASCII，文件名保留原名） */
export interface UploadedAttachment {
  name: string;
  mime: string;
  size: number;
  path: string;
}

export type UploadResult =
  | { ok: true; data: UploadedAttachment }
  | { ok: false; message: string };

export type BlobResult =
  | { ok: true; data: Blob }
  | { ok: false; message: string };

export type DownloadResult = { ok: true } | { ok: false; message: string };

const base = (sessionId: string) =>
  `/api/v1/sessions/${enc(sessionId)}/attachments`;

const contentUrl = (sessionId: string, path: string) =>
  `${base(sessionId)}/content?path=${enc(path)}&download=1`;

// 上传失败的中文说明；没有登记的状态码统一兜底。
const UPLOAD_ERRORS: Record<number, string> = {
  400: "文件名不合法，请重命名后再试",
  401: "登录已失效，请重新登录",
  403: "没有权限上传附件",
  404: "会话不存在或已删除",
  409: "同名附件冲突，请重试",
  413: "文件太大，超出了服务端限制",
  429: "操作过于频繁，请稍后再试",
};

const uploadError = (status: number): string =>
  UPLOAD_ERRORS[status] ?? "附件上传失败，请稍后重试";

const BLOB_ERRORS: Record<RawFailure, string> = {
  unauthorized: "登录已失效，请重新登录",
  forbidden: "没有权限读取该附件",
  not_found: "附件不存在或已被清理",
  conflict: "附件状态冲突，请稍后重试",
  too_large: "附件太大，无法读取",
  network: "网络错误，附件读取失败",
  server: "附件读取失败，请稍后重试",
};

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

function parseUploaded(text: string): UploadedAttachment | null {
  try {
    const b = JSON.parse(text) as Record<string, unknown>;
    if (!isText(b.name) || !isText(b.path)) return null;
    if (typeof b.size !== "number" || !Number.isFinite(b.size)) return null;
    return {
      name: b.name,
      mime: isText(b.mime) ? b.mime : "application/octet-stream",
      size: b.size,
      path: b.path,
    };
  } catch {
    return null;
  }
}

/**
 * 上传一个文件到会话附件区；onProgress 收到 0–100 的百分比。
 * 失败不抛错，返回可直接展示的中文说明。
 */
export function uploadAttachment(
  token: string | null,
  sessionId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base(sessionId)}?name=${enc(file.name)}`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable && e.total > 0)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = parseUploaded(xhr.responseText);
        resolve(
          data
            ? { ok: true, data }
            : { ok: false, message: "上传响应异常，请重试" },
        );
        return;
      }
      resolve({ ok: false, message: uploadError(xhr.status) });
    };
    xhr.onerror = () =>
      resolve({ ok: false, message: "网络错误，附件上传失败" });
    xhr.onabort = () => resolve({ ok: false, message: "附件上传已取消" });
    xhr.send(file);
  });
}

/** 按相对 path 读取附件内容（图片缩略图与下载都走它） */
export async function attachmentBlob(
  token: string | null,
  sessionId: string,
  path: string,
): Promise<BlobResult> {
  const res = await raw(contentUrl(sessionId, path), {}, token, (r) =>
    r.blob(),
  );
  return res.ok ? res : { ok: false, message: BLOB_ERRORS[res.kind] };
}

/** 下载附件：先取 blob，再用临时 a[download] 触发保存 */
export async function downloadAttachment(
  token: string | null,
  sessionId: string,
  path: string,
  name: string,
): Promise<DownloadResult> {
  const r = await attachmentBlob(token, sessionId, path);
  if (!r.ok) return r;
  const url = URL.createObjectURL(r.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 等浏览器接过下载再回收 blob URL
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { ok: true };
}
