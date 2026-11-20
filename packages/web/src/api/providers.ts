import { enc, request } from "./http";

// 所有类型与服务端 packages/server/src/provider/*.ts 一一对应

export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

export const AUTH_METHODS = ["oauth", "key", "env", "cmd", "ambient"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const KEY_STORAGES = ["auth", "models", "session"] as const;
export type KeyStorage = (typeof KEY_STORAGES)[number];

// 与服务端 pi 的 thinkingFormat 取值一致
export const THINKING_FORMATS = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "baseten",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
] as const;
export type ThinkingFormat = (typeof THINKING_FORMATS)[number];

export interface ProviderCompat {
  supportsDeveloperRole?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  supportsReasoningEffort?: boolean;
  requiresThinkingAsText?: boolean;
  thinkingFormat?: ThinkingFormat;
}

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];
export type LevelMap = Partial<Record<ThinkingLevelName, string>>;

export const MODEL_INPUTS = ["text", "image", "audio", "video"] as const;
export type ModelInput = (typeof MODEL_INPUTS)[number];

export const MODEL_SOURCES = ["catalog", "probe", "manual"] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

export interface ModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  levels: ThinkingLevelName[];
  /** 在选择器里换到这个模型时思考档位的起点；必须是 levels 里的一档 */
  defaultLevel?: ThinkingLevelName;
  map?: LevelMap;
  input: ModelInput[];
  ctx: number;
  out: number;
  source: ModelSource;
}

export const TEST_STAGES = [
  "credential",
  "endpoint",
  "models",
  "token",
] as const;
export type StageName = (typeof TEST_STAGES)[number];

export interface LastTest {
  at: string;
  ok: boolean;
  ttft: number;
  total: number;
  stage: StageName;
  errorCode?: string;
}

export type ProviderStatus = "off" | "warn" | "ok";

export interface CredentialTier {
  source: "--api-key" | "auth.json" | "models.json" | "env";
  hit: boolean;
  detail?: string;
}

export interface CredentialInfo {
  source: CredentialTier["source"] | null;
  detail?: string;
  chain: CredentialTier[];
}

export interface ProviderView {
  id: string;
  name: string;
  custom: boolean;
  // 用户添加过（库里有记录）；内置供应商只有环境凭据时为 false
  added: boolean;
  methods: AuthMethod[];
  method: AuthMethod;
  status: ProviderStatus;
  // 自定义供应商是四种之一；内置的是 pi 目录里的协议名，可能不在四种里（如 mistral-conversations）
  api?: string;
  baseUrl?: string;
  // 端点能否探测；false 时测试只验证凭据与首 token，也不能从端点导入模型
  probeable: boolean;
  slug?: string;
  // 仅自定义供应商：「头名」或「头名: 前缀」；不含密钥，缺省 = 协议默认
  authHeader?: string;
  // 同时在途的模型请求数上限（缺省 50）；超了在服务端排队
  maxConcurrent: number;
  compat?: ProviderCompat;
  keyStorage: KeyStorage;
  envVariable?: string;
  command?: string;
  hasKey: boolean;
  credential: CredentialInfo;
  lastTest?: LastTest;
  models: ModelSpec[];
}

export interface StageResult {
  state: "ok" | "fail" | "skip";
  ms: number;
  error?: string;
}

export interface TestResult {
  ok: boolean;
  failedStage: StageName | null;
  errorCode: string | null;
  stages: Record<StageName, StageResult>;
  lastTest: LastTest;
}

export interface ModelsJsonDiff {
  op: "add" | "remove" | "replace";
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface ModelsJsonView {
  path: string;
  exists: boolean;
  current: { providers: Record<string, unknown> } | null;
  live: { providers: Record<string, unknown> };
  diff: ModelsJsonDiff[];
}

export interface ProbeResult {
  ids: string[];
}

export interface CreateProviderInput {
  name: string;
  slug: string;
  api: ProviderApi;
  baseUrl: string;
  apiKey?: string;
  keyStorage?: KeyStorage;
  method?: "key" | "env" | "cmd";
  envVariable?: string;
  command?: string;
  authHeader?: string;
  compat?: ProviderCompat;
  models?: ModelSpec[];
}

// PATCH 的取值比创建宽：method 可切到 oauth/ambient（内置供应商），null 表示清除。
export type UpdateProviderInput = Omit<
  Partial<CreateProviderInput>,
  "baseUrl" | "method" | "envVariable" | "command" | "apiKey" | "authHeader"
> & {
  baseUrl?: string | null; // null 仅内置供应商可用：清除 Base URL 覆盖
  method?: AuthMethod;
  envVariable?: string | null;
  command?: string | null;
  apiKey?: string | null; // null = 移除已保存的密钥
  authHeader?: string | null; // null = 清除，回到协议默认
  maxConcurrent?: number | null; // null = 回到缺省（50）
};

// 抛错式调用（ApiError）：400 的 code 是校验码，409 是 slug_taken / in_use，403 是 builtin_provider。
export const listProviders = async (token: string | null) =>
  (
    await request<{ providers: ProviderView[] }>(
      "GET",
      "/api/v1/providers",
      token,
    )
  ).providers;

export const createProvider = (
  token: string | null,
  input: CreateProviderInput,
) => request<ProviderView>("POST", "/api/v1/providers", token, input);

export const updateProvider = (
  token: string | null,
  id: string,
  input: UpdateProviderInput,
) =>
  request<ProviderView>("PATCH", `/api/v1/providers/${enc(id)}`, token, input);

// 自定义端点：删除。内置供应商：清掉元枢里保存的配置（密钥、登录、地址覆盖、自己添加的模型），回到没配置过的样子。
export const deleteProvider = (token: string | null, id: string) =>
  request("DELETE", `/api/v1/providers/${enc(id)}`, token);

// pi 自带的目录模型（只读）：给「从端点获取」补规格，也给不能探测端点的供应商当候选；自定义端点是空表。
export const catalogModels = async (token: string | null, id: string) =>
  (
    await request<{ models: ModelSpec[] }>(
      "GET",
      `/api/v1/providers/${enc(id)}/catalog-models`,
      token,
    )
  ).models;

// 只取模型 id；无凭据 400 no_credential（带 message 指路），上游错误 502。
export const probeModels = (token: string | null, id: string) =>
  request<ProbeResult>(
    "POST",
    `/api/v1/providers/${enc(id)}/models/probe`,
    token,
  );

export const testProvider = (
  token: string | null,
  id: string,
  model?: string,
) =>
  request<TestResult>(
    "POST",
    `/api/v1/providers/${enc(id)}/test`,
    token,
    model ? { model } : undefined,
  );

// 只读预览：服务端不写盘。
export const getModelsJson = (token: string | null) =>
  request<ModelsJsonView>("GET", "/api/v1/models-json", token);

// ---- 订阅登录（OAuth） ----
// 登录在服务端后台进行：start 立即返回，前端轮询 get；要用户输入时 prompt 非空，用 answer 回答。

export interface LoginPrompt {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface LoginState {
  loginId: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** 最近一次授权链接 */
  link: { url: string; instructions?: string } | null;
  /** 最近一次设备码 */
  device: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  } | null;
  /** 最近一条进度文字 */
  message: string | null;
  /** 正在等用户输入的提示 */
  prompt: LoginPrompt | null;
  error: string | null;
}

export const startLogin = (token: string | null, id: string) =>
  request<LoginState>("POST", `/api/v1/providers/${enc(id)}/login`, token);

export const getLogin = (token: string | null, id: string, loginId: string) =>
  request<LoginState>(
    "GET",
    `/api/v1/providers/${enc(id)}/login/${enc(loginId)}`,
    token,
  );

export const answerLogin = (
  token: string | null,
  id: string,
  loginId: string,
  promptId: string,
  value: string,
) =>
  request(
    "POST",
    `/api/v1/providers/${enc(id)}/login/${enc(loginId)}/answer`,
    token,
    { promptId, value },
  );

export const cancelLogin = (
  token: string | null,
  id: string,
  loginId: string,
) =>
  request(
    "DELETE",
    `/api/v1/providers/${enc(id)}/login/${enc(loginId)}`,
    token,
  );

export const logoutProvider = (token: string | null, id: string) =>
  request<ProviderView>("POST", `/api/v1/providers/${enc(id)}/logout`, token);
