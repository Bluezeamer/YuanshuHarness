// 工作区：顶层实体，带默认配置、挂载目录与独立布局。
// 与服务端 packages/server/src/api/workspaces.ts、session/workspaces.ts 对应。

import { enc, request } from "./http";
import { type PutResult, putDocument, type Workbench } from "./layout";

export interface WorkspaceDirectory {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  role: "local" | "remote";
}

export interface WorkspaceDefaults {
  agentPresetId?: string;
  modePresetIds?: string[];
  model?: { provider: string; model: string; reasoning: string };
  permissionTier?: string;
}

/** 这个工作区对审核模型判别准则的补充：追加在全局准则后，或整段覆盖；文字为空 = 跟随全局 */
export interface WorkspaceReviewPolicy {
  mode: "append" | "override";
  text: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  groupId: string | null;
  archived: boolean;
  /** 置顶：左轨里排在同一分组内其余工作区之前 */
  pinned: boolean;
  order: number;
  defaults: WorkspaceDefaults;
  reviewPolicy: WorkspaceReviewPolicy;
  /** 第 0 个是主目录（local），其余是附加目录（remote） */
  directories: WorkspaceDirectory[];
  /** 只数顶层会话，不含子代理会话 */
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryInput {
  environmentId?: string;
  path: string;
}

/** 删除工作区时受影响的目录；被保留的目录也列出，供界面展示。 */
export interface DirectoryImpact {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  removed: boolean;
  rules: number;
  hooks: number;
}

export interface RemovalPreview {
  /** 有会话在运行，此时删除会被拒 */
  running: boolean;
  sessions: number;
  terminals: number;
  directories: DirectoryImpact[];
}

export interface DirectoryPreview {
  added: { environmentId: string; path: string; name: string }[];
  removed: DirectoryImpact[];
}

export const listWorkspaces = async (
  token: string | null,
): Promise<Workspace[]> =>
  (
    await request<{ workspaces: Workspace[] }>(
      "GET",
      "/api/v1/workspaces",
      token,
    )
  ).workspaces;

export const getWorkspace = (token: string | null, id: string) =>
  request<Workspace>("GET", `/api/v1/workspaces/${enc(id)}`, token);

/** 201 新建，200 表示同主目录的工作区已存在；两者都返回工作区，调用方不区分。 */
export const createWorkspace = (
  token: string | null,
  input: {
    directories: DirectoryInput[];
    name?: string;
    description?: string;
    defaults?: WorkspaceDefaults;
  },
) => request<Workspace>("POST", "/api/v1/workspaces", token, input);

export const patchWorkspace = (
  token: string | null,
  id: string,
  patch: {
    name?: string;
    description?: string;
    groupId?: string | null;
    archived?: boolean;
    pinned?: boolean;
    order?: number;
    defaults?: WorkspaceDefaults;
    reviewPolicy?: WorkspaceReviewPolicy;
  },
) => request<Workspace>("PATCH", `/api/v1/workspaces/${enc(id)}`, token, patch);

export const reorderWorkspaces = (token: string | null, ids: string[]) =>
  request("PUT", "/api/v1/workspaces/reorder", token, { ids });

/** 有会话在跑会得到 409 `session_running` */
export const deleteWorkspace = (token: string | null, id: string) =>
  request("DELETE", `/api/v1/workspaces/${enc(id)}`, token);

export const workspaceRemovalPreview = (token: string | null, id: string) =>
  request<RemovalPreview>(
    "GET",
    `/api/v1/workspaces/${enc(id)}/removal-preview`,
    token,
  );

export const previewDirectories = (
  token: string | null,
  id: string,
  directories: DirectoryInput[],
) =>
  request<DirectoryPreview>(
    "PUT",
    `/api/v1/workspaces/${enc(id)}/directories`,
    token,
    { directories, dryRun: true },
  );

export const setDirectories = (
  token: string | null,
  id: string,
  directories: DirectoryInput[],
) =>
  request<Workspace>(
    "PUT",
    `/api/v1/workspaces/${enc(id)}/directories`,
    token,
    { directories },
  );

/** 还没存过布局时服务端给 document: null。 */
export const getWorkspaceLayout = async (
  token: string | null,
  id: string,
): Promise<Workbench> => {
  const b = await request<Workbench>(
    "GET",
    `/api/v1/workspaces/${enc(id)}/layout`,
    token,
  );
  return { revision: b.revision, document: b.document ?? null };
};

export const putWorkspaceLayout = (
  token: string | null,
  id: string,
  baseRevision: number,
  document: unknown,
  keepalive = false,
): Promise<PutResult> =>
  putDocument(
    `/api/v1/workspaces/${enc(id)}/layout`,
    token,
    baseRevision,
    document,
    keepalive,
  );
