import { request } from "./http";
import type { ThinkingLevelName } from "./providers";

// 与服务端 packages/server/src/api/default-model.ts 对应：agent 与会话都没指定模型时用的全局默认。
export interface DefaultModel {
  provider: string;
  model: string;
  /** 启动思考级别；null = 沿用模型/agent 自己的默认 */
  thinking: ThinkingLevelName | null;
}

export const getDefaultModel = async (token: string | null) =>
  (
    await request<{ default: DefaultModel | null }>(
      "GET",
      "/api/v1/default-model",
      token,
    )
  ).default;

export const putDefaultModel = async (
  token: string | null,
  value: { provider: string; model: string; thinking?: ThinkingLevelName },
) =>
  (
    await request<{ default: DefaultModel | null }>(
      "PUT",
      "/api/v1/default-model",
      token,
      value,
    )
  ).default;
