import { enc, request } from "./http";

/** 工作区勾选的技能与 MCP（名字清单）；已设为全局的不用勾。 */
export interface WorkspaceCapabilities {
  skill: string[];
  mcp: string[];
}

const url = (workspaceId: string) =>
  `/api/v1/workspaces/${enc(workspaceId)}/capabilities`;

export const fetchWorkspaceCapabilities = (
  token: string | null,
  workspaceId: string,
) => request<WorkspaceCapabilities>("GET", url(workspaceId), token);

/** 整份替换某一类（缺省的那类不动）。 */
export const setWorkspaceCapabilities = (
  token: string | null,
  workspaceId: string,
  body: Partial<WorkspaceCapabilities>,
) => request<WorkspaceCapabilities>("PUT", url(workspaceId), token, body);
