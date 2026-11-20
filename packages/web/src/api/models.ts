import { call, enc } from "./http";

export type ModelApiKind =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelCompat {
  supportsDeveloperRole?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  supportsMidConvoSystemMessages?: boolean;
  supportsMidConvoToolAdditions?: boolean;
  supportsMidConvoToolChanges?: boolean;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  api: ModelApiKind;
  baseUrl: string;
  modelId: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  input: Array<"text" | "image">;
  thinkingLevelMap: ThinkingLevelMap | null;
  compat: ModelCompat | null;
  hasKey: boolean;
  isDefault: boolean;
}

export interface ModelInput {
  name: string;
  api: ModelApiKind;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: ModelCompat;
  apiKey?: string;
}

export const listModels = (token: string | null) =>
  call(
    "GET",
    "/api/v1/models",
    token,
    undefined,
    (b: { models: ModelInfo[] }) => {
      if (!Array.isArray(b.models)) throw new Error("shape");
      return b.models;
    },
  );

export const createModel = (token: string | null, input: ModelInput) =>
  call("POST", "/api/v1/models", token, input, (b: ModelInfo) => b);

export const setDefaultModel = (token: string | null, id: string) =>
  call(
    "PATCH",
    `/api/v1/models/${enc(id)}`,
    token,
    { isDefault: true },
    (b: ModelInfo) => b,
  );

export const deleteModel = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/models/${enc(id)}`, token, undefined, () => {});

export const testModel = (token: string | null, input: ModelInput) =>
  call(
    "POST",
    "/api/v1/models/test",
    token,
    input,
    (b: { ok: boolean; error?: string }) => {
      if (typeof b.ok !== "boolean") throw new Error("shape");
      return b;
    },
  );
