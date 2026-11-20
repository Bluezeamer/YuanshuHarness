import type { Tier } from "./defaults";
import { ApiError, enc, request } from "./http";

// 与服务端 packages/server/src/store/session-configs.ts、api/session-config.ts 对应。

export type ConfigModel =
  | { mode: "follow-default" }
  | { mode: "explicit"; provider: string; model: string; reasoning: string };

export interface SessionConfig {
  sessionId: string;
  model: ConfigModel;
  /** 生效能力 id（tool:名字 / skill:名字 / mcp:名字）；null = 不限制 */
  capabilities: string[] | null;
  /** 审批档位的会话覆盖；null = 没覆盖，跟随全局默认 */
  permissionTier: Tier | null;
  /** 1 = 创建时落库的第一版 */
  rev: number;
}

export type ConfigBody = Omit<SessionConfig, "sessionId" | "rev">;

export type ConfigPatch = Partial<ConfigBody>;

export interface PatchResult {
  config: SessionConfig;
  /** now = 立即生效；next-run = 下一轮运行开头生效（模型会收到状态通知） */
  appliedAt: "now" | "next-run";
}

export const getSessionConfig = (token: string | null, id: string) =>
  request<SessionConfig>("GET", `/api/v1/sessions/${enc(id)}/config`, token);

export const patchSessionConfig = (
  token: string | null,
  id: string,
  baseRev: number,
  patch: ConfigPatch,
) =>
  request<PatchResult>("PATCH", `/api/v1/sessions/${enc(id)}/config`, token, {
    baseRev,
    patch,
  });

/** 409 时服务端带回当前值，调用方据此让用户选择覆盖或采用服务端版本 */
export const conflictOf = (err: unknown): SessionConfig | null => {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const cur = (err.body as { current?: SessionConfig | null } | null)?.current;
  return cur ?? null;
};

/** 400 的可读码（`unknown_model`、`unknown_tool` 等） */
export const configErrorCode = (err: unknown): string | null =>
  err instanceof ApiError && err.status === 400 ? err.code : null;

export interface CreateSessionInput {
  /** 加入已有工作区：目录清单与新会话默认配置都由它决定 */
  workspaceId?: string;
  directoryId?: string;
  /** 有序、非空、无重复；第 1 个是 local。同时给 directoryId 时必须等于它的第 1 项 */
  directoryIds?: string[];
  /** 创建时选择的 agent 预设（提示词来源）；缺省用默认预设 */
  promptPresetId?: string;
  /** 创建时多选的应用模式预设（按选择顺序） */
  modePresetIds?: string[];
  /** 缺的分区用预设默认值 */
  config?: Partial<ConfigBody>;
}

export const createSessionWithConfig = (
  token: string | null,
  input: CreateSessionInput,
) => request<{ id: string }>("POST", "/api/v1/sessions", token, input);
