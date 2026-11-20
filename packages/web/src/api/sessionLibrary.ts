import { enc, request } from "./http";

// 与服务端 packages/server/src/session/library.ts、api/session-library.ts 对应。

export type SessionStatus = "running" | "idle" | "blocked" | "archived";
export type Lifecycle = "active" | "archived";

export interface LibrarySession {
  id: string;
  /** 展示标题；没有名字时取首条用户消息前 48 字，再没有是「新对话」 */
  title: string;
  /** 展示编号，形如「#」加四位数字；还没进索引的子会话为 null */
  no: string | null;
  name: string | null;
  status: SessionStatus;
  lifecycle: Lifecycle;
  /** 所属工作区；没归入工作区时为 null */
  workspaceId: string | null;
  /** 派生关系（来源会话与分叉点）与未读标记 */
  parentSessionId: string | null;
  forkEntryId: string | null;
  unreadResult: boolean;
  unreadError: boolean;
  /** 置顶：左轨里排在同级会话之前 */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** 本轮是否真在跑（status 里 active 一律算 running，这个才反映是否在运行） */
  running: boolean;
  directoryId: string | null;
  promptPresetId: string | null;
  modePresetIds: string[];
  activeModeId: string | null;
}

export interface LibraryQuery {
  /** 逗号分隔多值 */
  status?: SessionStatus[];
  q?: string;
}

const qs = (q: LibraryQuery): string => {
  const p = new URLSearchParams();
  if (q.status?.length) p.set("status", q.status.join(","));
  if (q.q) p.set("q", q.q);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const listLibrary = async (
  token: string | null,
  query: LibraryQuery = {},
): Promise<LibrarySession[]> =>
  (
    await request<{ sessions: LibrarySession[] }>(
      "GET",
      `/api/v1/sessions${qs(query)}`,
      token,
    )
  ).sessions;

export const patchLibrarySession = (
  token: string | null,
  id: string,
  patch: { title?: string; pinned?: boolean },
) =>
  request<LibrarySession>("PATCH", `/api/v1/sessions/${enc(id)}`, token, patch);

export type SessionAction = "archive" | "unarchive";

/** 归档运行中的会话会得到 409 `session_running` */
export const sessionAction = (
  token: string | null,
  id: string,
  action: SessionAction,
) =>
  request<LibrarySession>(
    "POST",
    `/api/v1/sessions/${enc(id)}/${action}`,
    token,
  );

export const refreshContext = (token: string | null, id: string) =>
  request<LibrarySession>(
    "POST",
    `/api/v1/sessions/${enc(id)}/refresh-context`,
    token,
  );

export const deleteSession = (token: string | null, id: string) =>
  request("DELETE", `/api/v1/sessions/${enc(id)}`, token);
