import { request } from "./http";

/** 压缩与重试的取值；文件里没写的键缺省，缺省 = 跟随 pi 自己的配置。 */
export interface AgentSettings {
  compaction: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  retry: { enabled?: boolean; maxRetries?: number };
}

/** 不看我们的文件时 pi 自己会用的值（每次读都现取，用户改了 ~/.pi 就跟着变）。 */
export interface AgentSettingsDefaults {
  compaction: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
  retry: { enabled: boolean; maxRetries: number };
}

// 与服务端 GET/PUT /api/v1/agent-settings 对应；落盘在 ~/.ys/settings.json。
export interface AgentSettingsView {
  /** settings.json 的绝对路径：用户和 agent 都可以直接改它 */
  file: string;
  values: AgentSettings;
  /** 文件里被忽略的项（JSON 不合法、类型不对、超出范围），各一句话 */
  problems: string[];
  defaults: AgentSettingsDefaults;
}

/** 写入的补丁：键缺省 = 不动；null = 删掉这一项，回到跟随 pi。 */
export interface AgentSettingsPatch {
  compaction?: {
    enabled?: boolean | null;
    reserveTokens?: number | null;
    keepRecentTokens?: number | null;
  };
  retry?: { enabled?: boolean | null; maxRetries?: number | null };
}

export const getAgentSettings = (token: string | null) =>
  request<AgentSettingsView>("GET", "/api/v1/agent-settings", token);

export const putAgentSettings = (
  token: string | null,
  patch: AgentSettingsPatch,
) => request<AgentSettingsView>("PUT", "/api/v1/agent-settings", token, patch);
