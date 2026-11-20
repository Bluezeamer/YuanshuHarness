// AGENTS.md：全局文件（缺省 ~/.ys/AGENTS.md）由「全局 AGENTS.md」版本激活时写入，项目文件由创建工作区时选的模板写入。
// 与服务端 packages/server/src/api/agents-md.ts、api/workspaces.ts 对应。
import { request } from "./http";
import type { StudioPreset } from "./studio";

export interface GlobalAgentsMdState {
  /** 文件的绝对路径（文件不存在时也给） */
  path: string;
  exists: boolean;
  /** 文件有内容，并且不是我们最近一次写进去的（有人手改过，或从没写过） */
  modified: boolean;
}

export const getGlobalAgentsMdState = (token: string | null) =>
  request<GlobalAgentsMdState>("GET", "/api/v1/agents-md/global", token);

/** 把磁盘上现在的内容存成一个新版本并设为生效；文件不存在或是空白时抛 ApiError（409，code 为 empty） */
export const importGlobalAgentsMd = (token: string | null) =>
  request<{ preset: StudioPreset }>(
    "POST",
    "/api/v1/agents-md/global/import",
    token,
    {},
  );

/** 把项目模板写进工作区主目录的 AGENTS.md；已有文件又没给 mode 时抛 ApiError（409，code 为 file_exists） */
export const applyProjectAgentsMd = (
  token: string | null,
  workspaceId: string,
  presetId: string,
  mode?: "overwrite" | "append",
) =>
  request<{ written: true; path: string }>(
    "POST",
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents-md`,
    token,
    mode ? { presetId, mode } : { presetId },
  );
