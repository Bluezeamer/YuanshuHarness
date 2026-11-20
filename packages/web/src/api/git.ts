// git 状态与分支（文件浏览器着色、版本视图显示分支/切分支用）。除了切分支都是只读。
import type { CallFailure } from "./http";
import { call, enc, failure, sendJson } from "./http";

export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitStatusEntry {
  /** 相对仓库根的路径，用 / 分隔 */
  path: string;
  status: GitFileStatus;
}

export interface GitStatus {
  /** 不是 git 仓库时为 null，界面据此隐藏所有 git 标记 */
  root: string | null;
  branch: string | null;
  detached: boolean;
  entries: GitStatusEntry[];
  /** 条目太多被截断（着色只覆盖前一批） */
  truncated: boolean;
}

export const EMPTY_GIT: GitStatus = {
  root: null,
  branch: null,
  detached: false,
  entries: [],
  truncated: false,
};

export const gitStatus = (token: string | null, env: string, path: string) =>
  call(
    "GET",
    `/api/v1/environments/${enc(env)}/git/status?path=${enc(path)}`,
    token,
    undefined,
    (b: GitStatus) =>
      typeof b?.root === "string" || b?.root === null
        ? {
            root: b.root,
            branch: typeof b.branch === "string" ? b.branch : null,
            detached: b.detached === true,
            entries: Array.isArray(b.entries) ? b.entries : [],
            truncated: b.truncated === true,
          }
        : EMPTY_GIT,
  );

/** 把「仓库根 + 相对路径」映射成绝对路径 → 状态，供文件列表按条目查表 */
export function statusByPath(status: GitStatus): Map<string, GitFileStatus> {
  const out = new Map<string, GitFileStatus>();
  if (!status.root) return out;
  const root = status.root.replace(/\/+$/, "");
  for (const e of status.entries)
    out.set(`${root}/${e.path.replace(/^\.?\/+/, "")}`, e.status);
  return out;
}

/** 目录 diff 的两侧内容：original 来自 HEAD（未被跟踪时为 null），current 是磁盘现状 */
export interface GitFileDiff {
  root: string | null;
  rel: string;
  original: string | null;
  current: string;
  binary: boolean;
  truncated: boolean;
}

export const EMPTY_FILE_DIFF: GitFileDiff = {
  root: null,
  rel: "",
  original: "",
  current: "",
  binary: false,
  truncated: false,
};

export const gitFileDiff = (
  token: string | null,
  env: string,
  path: string,
  file: string,
) =>
  call(
    "GET",
    `/api/v1/environments/${enc(env)}/git/file?path=${enc(path)}&file=${enc(file)}`,
    token,
    undefined,
    (b: GitFileDiff) => ({
      root: typeof b?.root === "string" ? b.root : null,
      rel: typeof b?.rel === "string" ? b.rel : "",
      original: typeof b?.original === "string" ? b.original : null,
      current: typeof b?.current === "string" ? b.current : "",
      binary: b?.binary === true,
      truncated: b?.truncated === true,
    }),
  );

/** 本地分支列表：版本视图的分支菜单用 */
export interface GitBranches {
  /** 不是 git 仓库时为 null */
  root: string | null;
  /** detached 时没有「当前分支」 */
  current: string | null;
  detached: boolean;
  locals: string[];
}

export const EMPTY_BRANCHES: GitBranches = {
  root: null,
  current: null,
  detached: false,
  locals: [],
};

export const gitBranches = (token: string | null, env: string, path: string) =>
  call(
    "GET",
    `/api/v1/environments/${enc(env)}/git/branches?path=${enc(path)}`,
    token,
    undefined,
    (b: GitBranches) =>
      typeof b?.root === "string" || b?.root === null
        ? {
            root: b.root,
            current: typeof b.current === "string" ? b.current : null,
            detached: b.detached === true,
            locals: Array.isArray(b.locals)
              ? b.locals.filter((x) => typeof x === "string")
              : [],
          }
        : EMPTY_BRANCHES,
  );

/** 工作区有未提交改动时怎么处理：暂存起来 / 带到新分支 / 干脆不切 */
export type GitDirtyPolicy = "stash" | "carry" | "abort";

export type GitCheckout =
  | { ok: true; data: { root: string; branch: string } }
  /** 服务端不肯在脏工作区上切：界面据此让用户先选策略，再带 stash/carry 重试 */
  | { ok: false; dirty: true; message: string }
  /** 其余失败都带服务端给的原因（不是仓库、git 自己拒绝切换…） */
  | ({ ok: false; kind: CallFailure["kind"] } & { message?: string });

/**
 * 切到本地分支。服务端对脏工作区不硬来：返回 dirty 而不是错误，
 * 因为「先 stash 还是带过去」只有用户能决定。
 */
export const gitCheckout = async (
  token: string | null,
  env: string,
  path: string,
  branch: string,
  dirty: GitDirtyPolicy,
  sessionId?: string | null,
): Promise<GitCheckout> => {
  const res = await sendJson(
    "POST",
    `/api/v1/environments/${enc(env)}/git/checkout`,
    token,
    { path, branch, dirty, ...(sessionId ? { sessionId } : {}) },
  );
  if (!res) return { ok: false, kind: "network" };
  if (res.status === 400) return { ok: false, kind: "bad_request" };
  if (res.status === 404) return { ok: false, kind: "not_found" };
  if (res.status === 409) {
    // 409 有两种：脏工作区（要弹策略选择）、git 自己拒绝（直接报错）
    const body = (await res.json().catch(() => null)) as {
      kind?: unknown;
      message?: unknown;
    } | null;
    const message = typeof body?.message === "string" ? body.message : "";
    if (body?.kind === "dirty") return { ok: false, dirty: true, message };
    return { ok: false, kind: "conflict", message };
  }
  if (!res.ok) return { ok: false, ...failure(res) };
  const body = (await res.json().catch(() => null)) as {
    root?: unknown;
    branch?: unknown;
    dirty?: unknown;
    message?: unknown;
  } | null;
  if (body?.dirty === true)
    return {
      ok: false,
      dirty: true,
      message: typeof body.message === "string" ? body.message : "",
    };
  if (typeof body?.root !== "string" || typeof body?.branch !== "string")
    return { ok: false, kind: "server" };
  return { ok: true, data: { root: body.root, branch: body.branch } };
};
