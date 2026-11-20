// 工作区分组：与旧的会话分组同形，但两者是独立实体（会话分组 C4 才删）。
// 与服务端 packages/server/src/api/workspace-groups.ts 对应。

import { enc, request } from "./http";

export interface WorkspaceGroup {
  id: string;
  name: string;
  /** 0..6 循环色号 */
  tone: number;
  collapsed: boolean;
  order: number;
}

export const listWorkspaceGroups = async (token: string | null) =>
  (
    await request<{ groups: WorkspaceGroup[] }>(
      "GET",
      "/api/v1/workspace-groups",
      token,
    )
  ).groups;

export const createWorkspaceGroup = (
  token: string | null,
  input: { name: string; tone?: number },
) => request<WorkspaceGroup>("POST", "/api/v1/workspace-groups", token, input);

export const patchWorkspaceGroup = (
  token: string | null,
  id: string,
  patch: Partial<Pick<WorkspaceGroup, "name" | "tone" | "collapsed" | "order">>,
) =>
  request<WorkspaceGroup>(
    "PATCH",
    `/api/v1/workspace-groups/${enc(id)}`,
    token,
    patch,
  );

/** 只解散，不删工作区 */
export const deleteWorkspaceGroup = (token: string | null, id: string) =>
  request("DELETE", `/api/v1/workspace-groups/${enc(id)}`, token);
