import { call, enc, type RawFailure, raw, rawKind, send } from "./http";

export interface FileEntry {
  name: string;
  type: "dir" | "file" | "other";
  size: number;
  mtimeMs: number;
  symlink?: string;
  broken?: boolean;
}

export interface FileListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
}

/** 环境的文件接口前缀；预览 iframe 之类需要直接拼 URL 的地方也用它。 */
export const filesBase = (env: string) =>
  `/api/v1/environments/${enc(env)}/files`;
const files = filesBase;
const sid = (sessionId: string | null) =>
  sessionId ? `&sessionId=${enc(sessionId)}` : "";

export const listFiles = (
  token: string | null,
  env: string,
  path: string,
  hidden: boolean,
) =>
  call(
    "GET",
    `${files(env)}/list?path=${enc(path)}${hidden ? "&hidden=1" : ""}`,
    token,
    undefined,
    (b: FileListing) => {
      if (!Array.isArray(b.entries)) throw new Error("shape");
      return b;
    },
  );

export const makeDir = (
  token: string | null,
  env: string,
  path: string,
  sessionId: string | null,
) =>
  call(
    "POST",
    `${files(env)}/mkdir`,
    token,
    { path, ...(sessionId ? { sessionId } : {}) },
    (b: { path: string }) => b,
  );

export const removeEntry = (
  token: string | null,
  env: string,
  path: string,
  recursive: boolean,
  sessionId: string | null,
) =>
  call(
    "DELETE",
    `${files(env)}/entry?path=${enc(path)}${recursive ? "&recursive=1" : ""}${sid(sessionId)}`,
    token,
    undefined,
    () => undefined,
  );

export interface Preview {
  contentType: string;
  bytes: Uint8Array;
  // 文件总大小；响应不带范围信息时等于已取字节数。
  total: number;
}

export interface TextFile {
  text: string;
  total: number;
  truncated: boolean;
  /** 编辑基线：服务端在读响应头里给出的 mtime 与全文 sha256（截断时没有 sha256）。 */
  mtimeMs: number | null;
  sha256: string | null;
}

/**
 * 读文本文件正文（不带 Range，尽量整份拿）：顺带把编辑基线（mtime / sha256）取回来，
 * 保存时用它判冲突。超过服务端上限会截断，此时没有 sha256。
 */
export const readTextFile = (token: string | null, env: string, path: string) =>
  raw(
    `${files(env)}/content?path=${enc(path)}&as=text`,
    {},
    token,
    async (res): Promise<TextFile> => {
      const body = new Uint8Array(await res.arrayBuffer());
      const sha = res.headers.get("X-File-Sha256");
      const mtime = res.headers.get("X-File-Mtime");
      const size = Number(res.headers.get("X-File-Size"));
      return {
        text: new TextDecoder("utf-8").decode(body),
        total: res.headers.get("X-Truncated") === "1" ? size : body.length,
        truncated: res.headers.get("X-Truncated") === "1",
        mtimeMs: mtime ? Number(mtime) : null,
        sha256: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
      };
    },
  );

export interface SaveBase {
  mtimeMs: number | null;
  sha256: string | null;
}

export interface SaveResult {
  size: number;
  created: boolean;
  sha256: string;
  mtimeMs: number;
}

/** 409 时把磁盘当前的基线带回来，前端据此提示「被别人改过了」。 */
export interface SaveConflict extends SaveBase {
  conflict: true;
}

/**
 * 保存文本：带上读出时的基线。基线对不上时服务端返回 409 与磁盘当前基线，
 * 这里原样交回给调用方去让用户选「覆盖 / 放弃 / 看差异」。
 */
export const saveTextFile = async (
  token: string | null,
  env: string,
  path: string,
  text: string,
  base: SaveBase,
  sessionId: string | null,
): Promise<
  | { ok: true; data: SaveResult }
  | { ok: false; conflict: SaveConflict }
  | { ok: false; kind: Exclude<RawFailure, never> }
> => {
  const q = new URLSearchParams({ path });
  if (base.sha256) q.set("expect_sha256", base.sha256);
  if (base.mtimeMs !== null) q.set("expect_mtime", String(base.mtimeMs));
  if (sessionId) q.set("sessionId", sessionId);
  const res = await send(
    `${files(env)}/content?${q.toString()}`,
    {
      method: "PUT",
      body: new Blob([text], { type: "text/plain; charset=utf-8" }),
    },
    token,
  );
  if (!res) return { ok: false, kind: "network" };
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      mtimeMs?: number;
      sha256?: string;
    };
    if (body.error === "conflict")
      return {
        ok: false,
        conflict: {
          conflict: true,
          mtimeMs: body.mtimeMs ?? null,
          sha256: body.sha256 ?? null,
        },
      };
    return { ok: false, kind: "conflict" };
  }
  if (!res.ok) return { ok: false, kind: rawKind(res.status) };
  const body = (await res.json().catch(() => null)) as SaveResult | null;
  return body ? { ok: true, data: body } : { ok: false, kind: "server" };
};

// 只取前 limit 字节。Range 由服务端按字节截取，文本与二进制同一条路径。
export const readPreview = (
  token: string | null,
  env: string,
  path: string,
  limit: number,
  asText: boolean,
) =>
  raw<Preview>(
    `${files(env)}/content?path=${enc(path)}${asText ? "&as=text" : ""}`,
    { headers: { Range: `bytes=0-${limit - 1}` } },
    token,
    async (res) => {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const range = /\/(\d+)$/.exec(res.headers.get("Content-Range") ?? "");
      return {
        contentType: res.headers.get("Content-Type") ?? "",
        bytes,
        total: range ? Number(range[1]) : bytes.length,
      };
    },
  );

export const readBytes = (token: string | null, env: string, path: string) =>
  raw(
    `${files(env)}/content?path=${enc(path)}`,
    {},
    token,
    async (res) => new Uint8Array(await res.arrayBuffer()),
  );

/** 单个文件的元信息：预览前先用它判大小，避免把超大文件整份拉进内存。 */
export interface FileStat {
  path: string;
  name: string;
  type: "dir" | "file" | "other";
  size: number;
  mtimeMs: number;
}

export const statFile = (token: string | null, env: string, path: string) =>
  call(
    "GET",
    `${files(env)}/stat?path=${enc(path)}`,
    token,
    undefined,
    (b: FileStat) => b,
  );

export const readDownload = (token: string | null, env: string, path: string) =>
  raw(`${files(env)}/content?path=${enc(path)}&download=1`, {}, token, (res) =>
    res.blob(),
  );

/** 目录打包下载：服务端流式打成 zip（符号链接不跟随、不打进去） */
export const readArchive = (token: string | null, env: string, path: string) =>
  raw(`${files(env)}/archive?path=${enc(path)}`, {}, token, (res) =>
    res.blob(),
  );

// 展示用：直接拿 Blob（响应头里的 Content-Type 会被带进 blob.type，图片可据此判断/渲染）。
export const readBlob = (token: string | null, env: string, path: string) =>
  raw(`${files(env)}/content?path=${enc(path)}`, {}, token, (res) =>
    res.blob(),
  );

export const uploadFile = (
  token: string | null,
  env: string,
  path: string,
  body: Blob,
  overwrite: boolean,
  sessionId: string | null,
) =>
  raw(
    `${files(env)}/content?path=${enc(path)}${overwrite ? "&overwrite=1" : ""}${sid(sessionId)}`,
    { method: "PUT", body },
    token,
    async () => undefined,
  );

// ---- 服务端目录浏览（ADR-0032）----

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
  readable: boolean;
  writable: boolean;
  truncated: boolean;
}

// path 缺省为服务端用户 home；400 表示路径不存在或不是目录。
export const listDirs = (token: string | null, path?: string, hidden = false) =>
  call(
    "GET",
    `/api/v1/fs/dirs?${path === undefined ? "" : `path=${enc(path)}&`}hidden=${hidden ? 1 : 0}`,
    token,
    undefined,
    (b: DirListing) => {
      if (typeof b.path !== "string" || !Array.isArray(b.dirs))
        throw new Error("shape");
      return b;
    },
  );

// ---- 文件传输（ADR-0062）----

export interface TransferJob {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  from: { env: string; path: string };
  to: { env: string; path: string };
  startedAt: string;
  /** 扫描阶段为 null，之后是待复制的文件总数。 */
  totalFiles: number | null;
  totalBytes: number | null;
  files: number;
  bytes: number;
  skippedLinks?: number;
  error?: { code: string; message: string };
}

export interface TransferRequest {
  from: { env: string; path: string };
  to: { env: string; path: string };
  overwrite: boolean;
  sessionId: string | null;
}

const jobs = "/api/v1/transfer-jobs";

const pickJob = (b: TransferJob) => {
  if (typeof b.id !== "string" || typeof b.state !== "string")
    throw new Error("shape");
  return b;
};

export const startTransferJob = (token: string | null, req: TransferRequest) =>
  call("POST", jobs, token, req, pickJob);

export const getTransferJob = (token: string | null, id: string) =>
  call("GET", `${jobs}/${enc(id)}`, token, undefined, pickJob);

// 取消只是发出请求；任务何时真正停下以轮询到的状态为准。
export const cancelTransferJob = (token: string | null, id: string) =>
  call("DELETE", `${jobs}/${enc(id)}`, token, undefined, pickJob);

// 同环境移动。目录永不覆盖，文件也不覆盖，冲突返回 conflict。sessionId 可为 null。
export const renameEntry = (
  token: string | null,
  env: string,
  from: string,
  to: string,
  sessionId: string | null,
) =>
  call(
    "POST",
    `/api/v1/environments/${enc(env)}/files/rename`,
    token,
    { from, to, sessionId },
    () => undefined,
  );
