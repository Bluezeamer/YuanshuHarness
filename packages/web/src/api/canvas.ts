// 灵感画布接口：一个目录里 `.canvas/` 下的画布与灵感卡。路径参数都相对 `.canvas/`，dir 是目录的绝对路径。
import { call, enc, type RawFailure, raw, rawKind, send } from "./http";

export interface CanvasNodeJson {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  file?: string;
  [k: string]: unknown;
}

export interface CanvasEdgeJson {
  id: string;
  fromNode: string;
  toNode: string;
  [k: string]: unknown;
}

/** JSON Canvas 文档；未知字段原样往返，界面不认识的也不能丢 */
export interface CanvasDocJson {
  nodes: CanvasNodeJson[];
  edges: CanvasEdgeJson[];
  [k: string]: unknown;
}

export interface Baseline {
  mtimeMs: number;
  sha256: string;
}

export interface FileInfo {
  exists: boolean;
  kind: "card" | "ref";
  size?: number;
  mtimeMs?: number;
  /** 文本文件的开头一段；二进制或太大的是 null */
  preview?: string | null;
  /** 文本比 preview 长 */
  truncated?: boolean;
  /** 别的主机上的引用，那台主机现在连不上（不是文件缺失） */
  unreachable?: boolean;
}

export interface BoardSummary {
  name: string;
  cards: number;
  mtimeMs: number;
}

export interface BoardList {
  /** `.canvas/` 是否已经建起来 */
  ready: boolean;
  /** 主机上没有 git 时没有历史，界面给一条提示 */
  git: "ok" | "missing";
  /** 画布的名字是相对 `.canvas/` 的路径（不带后缀），可以在子文件夹里 */
  boards: BoardSummary[];
  /** 笔记：相对 `.canvas/` 的路径（带 `.md`） */
  notes: string[];
  /** 用户建的文件夹（含空的）：相对 `.canvas/` 的路径 */
  folders: string[];
}

export interface BoardData {
  name: string;
  canvas: CanvasDocJson;
  baseline: Baseline;
  files: Record<string, FileInfo>;
  /** 图片设置的指纹：设置变了它就变，带进图片地址让浏览器缓存里的旧缩略图作废 */
  mediaRev: string;
}

/** 带基线的写入结果：基线对不上时服务端回当前基线（与文件接口同形） */
export type Guarded<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      conflict: {
        conflict: true;
        mtimeMs: number | null;
        sha256: string | null;
      };
    }
  | { ok: false; kind: RawFailure };

export interface CardRead {
  text: string;
  mtimeMs: number | null;
  sha256: string | null;
}

const base = (env: string) => `/api/v1/canvas/${enc(env)}`;

/**
 * 画布里项目文件引用的图片地址（直接给 <img> 用，会话靠 Cookie 鉴权）。
 * 服务端会缩成缩略图并缓存；v 是文件的 mtime、r 是图片设置的指纹，文件或设置变了地址就变，浏览器可以放心长期缓存。
 */
export const canvasImageUrl = (
  env: string,
  dir: string,
  file: string,
  v: number | undefined,
  r: string,
  host?: string,
): string =>
  `${base(env)}/image?${new URLSearchParams({ dir, file, r, ...(host ? { host } : {}), ...(v === undefined ? {} : { v: String(v) }) })}`;
/** 画布里音视频的地址（直接给 <video> / <audio> 用）：服务端按 Range 流式给出，v 是文件的 mtime */
export const canvasMediaUrl = (
  env: string,
  dir: string,
  file: string,
  v: number | undefined,
  host?: string,
): string =>
  `${base(env)}/media?${new URLSearchParams({ dir, file, ...(host ? { host } : {}), ...(v === undefined ? {} : { v: String(v) }) })}`;
/** 网页链接卡片的信息（Server 抓的）；failed 表示没抓到，界面退回只显示地址 */
export interface LinkMeta {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  icon: string | null;
  site: string | null;
  failed: boolean;
}

export const readLinkMeta = (token: string | null, env: string, url: string) =>
  call(
    "GET",
    `${base(env)}/link?${new URLSearchParams({ url })}`,
    token,
    undefined,
    (b: LinkMeta) => b,
  );

const q = (dir: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ dir, ...extra }).toString();

export const listBoards = (token: string | null, env: string, dir: string) =>
  call(
    "GET",
    `${base(env)}/boards?${q(dir)}`,
    token,
    undefined,
    (b: BoardList) => b,
  );

/** 远端同步（Server 本机有这个目录的画布副本时才有；本机环境没有） */
export interface MirrorStatus {
  state: "synced" | "pending" | "syncing" | "offline";
  pending: number;
  error?: string;
  /** 远端文件被外部改过、已另存的副本路径 */
  asides: string[];
}

export const readMirror = (token: string | null, env: string, dir: string) =>
  call(
    "GET",
    `${base(env)}/mirror?${q(dir)}`,
    token,
    undefined,
    (b: { mirror: MirrorStatus | null }) => b.mirror,
  );

export const createBoard = (
  token: string | null,
  env: string,
  dir: string,
  name: string,
) =>
  call(
    "POST",
    `${base(env)}/boards?${q(dir)}`,
    token,
    { name },
    (b: { name: string }) => b,
  );

/** 新建一篇笔记（path 相对 `.canvas/`，可带子文件夹，缺 `.md` 补上）；返回建出来的路径 */
export const createNote = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
) =>
  call(
    "POST",
    `${base(env)}/notes?${q(dir)}`,
    token,
    { path },
    (b: { path: string }) => b,
  );

export const readBoard = (
  token: string | null,
  env: string,
  dir: string,
  name: string,
) =>
  call(
    "GET",
    `${base(env)}/board?${q(dir, { name })}`,
    token,
    undefined,
    (b: BoardData) => b,
  );

export const renameBoard = (
  token: string | null,
  env: string,
  dir: string,
  name: string,
  to: string,
) =>
  call(
    "PATCH",
    `${base(env)}/board?${q(dir, { name })}`,
    token,
    { name: to },
    (b: { name: string }) => b,
  );

/** 把画布挪到新的完整名字（可以换文件夹）；卡片、资源、引用它的笔记链接一起跟着走 */
export const moveBoard = (
  token: string | null,
  env: string,
  dir: string,
  name: string,
  to: string,
) =>
  call(
    "PATCH",
    `${base(env)}/board?${q(dir, { name })}`,
    token,
    { to },
    (b: { name: string }) => b,
  );

export const deleteBoard = (
  token: string | null,
  env: string,
  dir: string,
  name: string,
) =>
  call(
    "DELETE",
    `${base(env)}/board?${q(dir, { name })}`,
    token,
    undefined,
    () => undefined,
  );

// 带基线的写：409 且是 conflict 时把磁盘当前基线带回来
async function writeGuarded<T>(
  method: "PUT" | "POST",
  url: string,
  body: BodyInit,
  contentType: string,
  token: string | null,
): Promise<Guarded<T>> {
  const res = await send(
    url,
    { method, body, headers: { "Content-Type": contentType } },
    token,
  );
  if (!res) return { ok: false, kind: "network" };
  if (res.status === 409) {
    const b = (await res.json().catch(() => ({}))) as {
      error?: string;
      mtimeMs?: number;
      sha256?: string;
    };
    if (b.error === "conflict")
      return {
        ok: false,
        conflict: {
          conflict: true,
          mtimeMs: b.mtimeMs ?? null,
          sha256: b.sha256 ?? null,
        },
      };
    return { ok: false, kind: "conflict" };
  }
  if (!res.ok) return { ok: false, kind: rawKind(res.status) };
  const data = (await res.json().catch(() => null)) as T | null;
  return data ? { ok: true, data } : { ok: false, kind: "server" };
}

const guard = (expect: { mtimeMs: number | null; sha256: string | null }) => {
  const g: Record<string, string> = {};
  if (expect.sha256) g.expect_sha256 = expect.sha256;
  if (expect.mtimeMs !== null) g.expect_mtime = String(expect.mtimeMs);
  return g;
};

export const saveBoard = (
  token: string | null,
  env: string,
  dir: string,
  name: string,
  doc: CanvasDocJson,
  expect: Baseline,
) =>
  writeGuarded<{ baseline: Baseline }>(
    "PUT",
    `${base(env)}/board?${q(dir, { name, ...guard(expect) })}`,
    JSON.stringify(doc),
    "application/json",
    token,
  );

export const readCard = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
) =>
  raw(
    `${base(env)}/card?${q(dir, { path })}`,
    {},
    token,
    async (res): Promise<CardRead> => {
      const mtime = res.headers.get("X-File-Mtime");
      const sha = res.headers.get("X-File-Sha256");
      return {
        text: await res.text(),
        mtimeMs: mtime ? Number(mtime) : null,
        sha256: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
      };
    },
  );

/** 与 saveTextFile 同形的结果：编辑器的保存条与冲突对话框可以直接用 */
export const saveCard = async (
  token: string | null,
  env: string,
  dir: string,
  path: string,
  text: string,
  expect: { mtimeMs: number | null; sha256: string | null },
) => {
  const r = await writeGuarded<{ baseline: Baseline }>(
    "PUT",
    `${base(env)}/card?${q(dir, { path, ...guard(expect) })}`,
    new Blob([text], { type: "text/plain; charset=utf-8" }),
    "text/plain; charset=utf-8",
    token,
  );
  return r.ok
    ? ({
        ok: true,
        data: {
          mtimeMs: r.data.baseline.mtimeMs,
          sha256: r.data.baseline.sha256,
        },
      } as const)
    : r;
};

export const renameCard = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
  name: string,
) =>
  call(
    "PATCH",
    `${base(env)}/card?${q(dir, { path })}`,
    token,
    { name },
    (b: { path: string }) => b,
  );

export type UploadResult =
  | {
      ok: true;
      data: { path: string; nodeId: string; large: boolean; size: number };
    }
  | { ok: false; kind: RawFailure; max?: number };

/**
 * 把粘贴 / 拖入的文件传进画布的资源文件夹（字节流，不走 base64）；成功时服务端已经把节点放进了画布文档。
 * at 是节点左上角，size 是节点大小（画布单位）。
 */
export async function uploadAsset(
  token: string | null,
  env: string,
  dir: string,
  board: string,
  file: File,
  opts: {
    name: string;
    at?: { x: number; y: number };
    size?: { w: number; h: number };
  },
): Promise<UploadResult> {
  const extra: Record<string, string> = { board, name: opts.name };
  if (opts.at) {
    extra.x = String(Math.round(opts.at.x));
    extra.y = String(Math.round(opts.at.y));
  }
  if (opts.size) {
    extra.w = String(opts.size.w);
    extra.h = String(opts.size.h);
  }
  return putBytes(`${base(env)}/asset?${q(dir, extra)}`, file, token);
}

/** 字节流 PUT（不走 base64），解析成功体；失败带上服务端给的上限（413） */
async function putBytes<T>(
  url: string,
  file: File,
  token: string | null,
): Promise<
  { ok: true; data: T } | { ok: false; kind: RawFailure; max?: number }
> {
  const res = await send(
    url,
    {
      method: "PUT",
      body: file,
      headers: { "Content-Type": "application/octet-stream" },
    },
    token,
  );
  if (!res) return { ok: false, kind: "network" };
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { max?: number };
    return {
      ok: false,
      kind: rawKind(res.status),
      ...(typeof b.max === "number" ? { max: b.max } : {}),
    };
  }
  const data = (await res.json().catch(() => null)) as T | null;
  return data ? { ok: true, data } : { ok: false, kind: "server" };
}

/**
 * 笔记里的图片：存进笔记旁边的 `<笔记名>.assets/`（不是画布节点）；返回相对 `.canvas/` 的最终路径
 * （重名会加序号、过大的放进 `_large/`），界面据此写成相对笔记的链接。
 */
export const uploadNoteAsset = (
  token: string | null,
  env: string,
  dir: string,
  note: string,
  file: File,
  name: string,
) =>
  putBytes<{ path: string; large: boolean; size: number }>(
    `${base(env)}/note-asset?${q(dir, { note, name })}`,
    file,
    token,
  );

/** 删资源：文件与画布上的节点一起删 */
export const deleteAsset = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
) =>
  call(
    "DELETE",
    `${base(env)}/asset?${q(dir, { path })}`,
    token,
    undefined,
    () => undefined,
  );

export const deleteCard = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
) =>
  call(
    "DELETE",
    `${base(env)}/card?${q(dir, { path })}`,
    token,
    undefined,
    () => undefined,
  );

export interface SaveBatchBody {
  board: string;
  /** 没改布局时不带；新卡片的节点已经在里面，它们的 file 由服务端换成建出来的文件 */
  doc?: CanvasDocJson;
  expect?: { mtimeMs: number; sha256: string };
  edits: Array<{
    path: string;
    text: string;
    expect: { mtimeMs: number | null; sha256: string | null };
  }>;
  created: Array<{ nodeId: string; text: string }>;
}

export interface SaveBatchData {
  /** 写了文档才有 */
  baseline: Baseline | null;
  edits: Array<{ path: string; baseline: Baseline }>;
  created: Array<{ nodeId: string; path: string; baseline: Baseline }>;
  /** 磁盘上被别处改过、没有写入的卡片 */
  conflicts: string[];
}

/** 一次保存：画布文档、改过的卡片、新卡片一个请求。文档的基线对不上整批不写，回 conflict */
export const saveBatch = (
  token: string | null,
  env: string,
  dir: string,
  body: SaveBatchBody,
) =>
  writeGuarded<SaveBatchData>(
    "POST",
    `${base(env)}/save?${q(dir)}`,
    JSON.stringify(body),
    "application/json",
    token,
  );

/** 笔记改名 / 挪动：to 是新路径（缺 `.md` 补上）；画布节点与别的笔记里的 `[[…]]` 跟着改 */
export const moveNote = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
  to: string,
) =>
  call(
    "PATCH",
    `${base(env)}/note?${q(dir, { path })}`,
    token,
    { to },
    (b: { path: string }) => b,
  );

export const deleteNote = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
) =>
  call(
    "DELETE",
    `${base(env)}/note?${q(dir, { path })}`,
    token,
    undefined,
    () => undefined,
  );

export const createFolder = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
) =>
  call(
    "POST",
    `${base(env)}/folders?${q(dir)}`,
    token,
    { path },
    (b: { path: string }) => b,
  );

export const moveFolder = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
  to: string,
) =>
  call(
    "PATCH",
    `${base(env)}/folder?${q(dir, { path })}`,
    token,
    { to },
    (b: { path: string }) => b,
  );

export const deleteFolder = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
) =>
  call(
    "DELETE",
    `${base(env)}/folder?${q(dir, { path })}`,
    token,
    undefined,
    () => undefined,
  );

/** 谁引用了这篇笔记 / 这块画布（画布的路径带 `.canvas` 后缀）：放着它的画布、`[[…]]` 指向它的笔记 */
export const readRefs = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
) =>
  call(
    "GET",
    `${base(env)}/refs?${q(dir, { path })}`,
    token,
    undefined,
    (b: { boards: string[]; notes: string[] }) => b,
  );

// ---- 版本历史（每个 `.canvas/` 自己的 git）：列表、某个版本的内容、恢复、撤销 agent 的上一次修改 ----

export interface VersionEntry {
  sha: string;
  /** 毫秒 */
  ts: number;
  source: "agent" | "user" | "external" | "restore" | "undo";
  /** agent 的提交带它的会话 id */
  session?: string;
  /** 服务端写的一行（`save 想法.canvas`、agent 的操作摘要） */
  summary: string;
}

/** 某个文件（相对 `.canvas/`）的历史，新的在前；不给 path 是整个 `.canvas/` 的（撤销 agent 要看最新一条是谁的） */
export const listVersions = (
  token: string | null,
  env: string,
  dir: string,
  path?: string,
  limit?: number,
) =>
  call(
    "GET",
    `${base(env)}/history?${q(dir, {
      ...(path === undefined ? {} : { path }),
      ...(limit === undefined ? {} : { limit: String(limit) }),
    })}`,
    token,
    undefined,
    (b: { commits: VersionEntry[] }) => b.commits,
  );

/** 某个版本里这个文件的全文；那个版本里没有这个文件（被删了）是 not_found */
export const readVersion = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
  sha: string,
) =>
  raw(
    `${base(env)}/history/version?${q(dir, { path, sha })}`,
    {},
    token,
    (res) => res.text(),
  );

/** 把文件恢复成某个版本：服务端记成一次新的提交，不改写历史 */
export const restoreVersion = (
  token: string | null,
  env: string,
  dir: string,
  path: string,
  sha: string,
) =>
  call(
    "POST",
    `${base(env)}/restore?${q(dir)}`,
    token,
    { path, sha },
    (b: { sha: string }) => b,
  );

/** 撤销最近一次 agent 的修改（整个 `.canvas/`）；之后又有别的提交时服务端不做聪明处理，把原因带回来 */
export async function undoAgent(
  token: string | null,
  env: string,
  dir: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await send(
    `${base(env)}/undo?${q(dir)}`,
    { method: "POST" },
    token,
  );
  if (!res) return { ok: false, message: "网络不通，请稍后再试" };
  if (res.ok) return { ok: true };
  const b = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: false, message: b.message ?? "撤销失败" };
}
