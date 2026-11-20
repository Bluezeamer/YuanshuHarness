import { enc, request } from "./http";

// 与服务端 packages/server/src/api/session-modes.ts 对应：会话可切换的模式与当前激活的模式。

export interface ModeChoice {
  id: string;
  name: string;
}

export interface SessionModes {
  modes: ModeChoice[];
  /** 当前激活的模式；null = 没有 */
  activeModeId: string | null;
}

export const getSessionModes = (token: string | null, id: string) =>
  request<SessionModes>("GET", `/api/v1/sessions/${enc(id)}/modes`, token);

/** 改清单和 / 或切换当前模式；切换静默，下一次运行由状态通知带给模型 */
export const putSessionModes = (
  token: string | null,
  id: string,
  body: { modePresetIds?: string[]; activeModeId?: string | null },
) =>
  request<SessionModes>(
    "PUT",
    `/api/v1/sessions/${enc(id)}/modes`,
    token,
    body,
  );
