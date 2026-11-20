import type { Db } from "./db.js";

export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

export const AUTH_METHODS = ["oauth", "key", "env", "cmd", "ambient"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

// auth.json / models.json（明文）/ 仅本次会话（只在内存，重启即失）。
export const KEY_STORAGES = ["auth", "models", "session"] as const;
export type KeyStorage = (typeof KEY_STORAGES)[number];

// pi 的 thinkingFormat 取值（pi-ai 的 OpenAICompletionsCompat）。
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

// 三态：键缺省 = 自动（按 URL 推断），有值 = 显式开/关或指定字段。
export interface ProviderCompat {
  supportsDeveloperRole?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** 请求里带不带 reasoning_effort。 */
  supportsReasoningEffort?: boolean;
  /** 历史里的思考块改成普通文本发回（拒绝 thinking block 的端点）。 */
  requiresThinkingAsText?: boolean;
  /** 思考参数的写法（enable_thinking、reasoning 对象等）。 */
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
// 逐级映射：level → 供应商侧的取值字符串。不支持的档位不在 levels 里，不用 null 表达。
export type LevelMap = Partial<Record<ThinkingLevelName, string>>;

export const MODEL_INPUTS = ["text", "image", "audio", "video"] as const;
export type ModelInput = (typeof MODEL_INPUTS)[number];

// catalog = 目录声明（UI「·目录」）/ probe = 来自端点列表（「·实测」）/ manual = 手填（「·未知」）。
export const MODEL_SOURCES = ["catalog", "probe", "manual"] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

// 没有成本字段（Q9：用户已删除，不要加回来）。ctx/out 为 0 表示还没填（UI 标「待补全」）。
export interface ModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  levels: ThinkingLevelName[];
  /** 选择器里换到这个模型时思考档位的起点；仅预填，不改会话现有档位。 */
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
  ttft: number; // 首 token 耗时 ms；没走到首 token 阶段为 0
  total: number; // 整个测试耗时 ms
  stage: StageName; // 成功 = "token"，失败 = 失败的那一阶段
  errorCode?: string;
}

export interface ProviderRecord {
  id: string; // 内置 = pi 的 provider id；自定义 = uuid
  custom: boolean;
  name: string | null; // 仅自定义
  slug: string | null; // 仅自定义
  api: ProviderApi | null; // 仅自定义
  baseUrl: string | null; // 自定义必填；内置为覆盖值
  method: AuthMethod;
  keyStorage: KeyStorage;
  envVariable: string | null;
  command: string | null;
  secretId: string | null; // API key 在 secrets 里的引用；永不出现在任何响应里
  authHeader: string | null; // 仅自定义：「头名」或「头名: 前缀」，空 = 协议默认
  maxConcurrent: number | null; // 同时在途的请求数上限；null = 缺省（50）
  compat: ProviderCompat | null;
  models: ModelSpec[]; // 用户选入的模型（内置供应商的目录不在这里）
  lastTest: LastTest | null;
  createdAt: string;
  updatedAt: string;
}

type Row = {
  id: string;
  custom: number;
  name: string | null;
  slug: string | null;
  api: string | null;
  base_url: string | null;
  method: string;
  key_storage: string;
  env_variable: string | null;
  command: string | null;
  secret_id: string | null;
  auth_header: string | null;
  max_concurrent: number | null;
  compat: string | null;
  models: string;
  last_test: string | null;
  created_at: string;
  updated_at: string;
};

const toRecord = (r: Row): ProviderRecord => ({
  id: r.id,
  custom: r.custom === 1,
  name: r.name,
  slug: r.slug,
  api: r.api as ProviderApi | null,
  baseUrl: r.base_url,
  method: r.method as AuthMethod,
  keyStorage: r.key_storage as KeyStorage,
  envVariable: r.env_variable,
  command: r.command,
  secretId: r.secret_id,
  authHeader: r.auth_header,
  maxConcurrent: r.max_concurrent,
  compat: r.compat ? (JSON.parse(r.compat) as ProviderCompat) : null,
  models: JSON.parse(r.models) as ModelSpec[],
  lastTest: r.last_test ? (JSON.parse(r.last_test) as LastTest) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class ProviderStore {
  // keyStorage = session 的 key：只在内存里，重启即失。
  private readonly sessionKeys = new Map<string, string>();

  constructor(private readonly db: Db) {}

  list(): ProviderRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM providers ORDER BY created_at, id")
        .all() as Row[]
    ).map(toRecord);
  }

  get(id: string): ProviderRecord | null {
    const r = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? toRecord(r) : null;
  }

  /** slug 已被占用返回 false（唯一约束），其余错误照常抛出。 */
  save(p: ProviderRecord): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO providers (id, custom, name, slug, api, base_url, method, key_storage,
             env_variable, command, secret_id, auth_header, max_concurrent, compat, models, last_test, created_at, updated_at)
           VALUES (@id, @custom, @name, @slug, @api, @base_url, @method, @key_storage,
             @env_variable, @command, @secret_id, @auth_header, @max_concurrent, @compat, @models, @last_test, @created_at, @updated_at)
           ON CONFLICT(id) DO UPDATE SET name=@name, slug=@slug, api=@api, base_url=@base_url,
             method=@method, key_storage=@key_storage, env_variable=@env_variable, command=@command,
             secret_id=@secret_id, auth_header=@auth_header, max_concurrent=@max_concurrent, compat=@compat, models=@models, last_test=@last_test,
             updated_at=@updated_at`,
        )
        .run({
          id: p.id,
          custom: p.custom ? 1 : 0,
          name: p.name,
          slug: p.slug,
          api: p.api,
          base_url: p.baseUrl,
          method: p.method,
          key_storage: p.keyStorage,
          env_variable: p.envVariable,
          command: p.command,
          secret_id: p.secretId,
          auth_header: p.authHeader,
          max_concurrent: p.maxConcurrent,
          compat: p.compat ? JSON.stringify(p.compat) : null,
          models: JSON.stringify(p.models),
          last_test: p.lastTest ? JSON.stringify(p.lastTest) : null,
          created_at: p.createdAt,
          updated_at: p.updatedAt,
        });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
        return false;
      throw err;
    }
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    this.sessionKeys.delete(id);
  }

  /** 有供应商用这个密码库条目当 API key（登记给 SecretStore 的 referrer）。 */
  referencesSecret(secretId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM providers WHERE secret_id = ?")
        .get(secretId) !== undefined
    );
  }

  sessionKey(id: string): string | null {
    return this.sessionKeys.get(id) ?? null;
  }

  setSessionKey(id: string, key: string | null): void {
    if (key) this.sessionKeys.set(id, key);
    else this.sessionKeys.delete(id);
  }
}
