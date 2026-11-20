import type {
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Db } from "../store/db.js";
import { buildRuntime, type ModelStore } from "../store/models.js";
import type {
  ModelSpec,
  ProviderRecord,
  ProviderStore,
} from "../store/providers.js";
import type { SecretStore } from "../store/secrets.js";
import { authHeaderValue, parseAuthHeader } from "./auth-header.js";
import type { Catalog } from "./catalog.js";
import { resolveAuth } from "./credentials.js";
import { piModel } from "./models-json.js";

export interface DefaultModel {
  provider: string;
  model: string;
  thinking: string | null;
}

export type BuiltModel = Awaited<ReturnType<typeof buildRuntime>>;

// pi 的 headers 值按配置语法解析（$VAR、${VAR}、开头的 ! 是命令）：密钥原文要先转义，免得被当成引用或命令执行。
const literal = (v: string) => v.replace(/\$/g, "$$$$").replace(/^!/, "$$!");

/**
 * 自定义供应商登记进 pi 的配置。会话（resolver）与「测试连接」共用这一份，测的就是会话用的。
 * 无密钥的本地服务给占位 apiKey，否则 SDK 认为未配置鉴权；真实密钥另由 runtime 注入。
 * 自定义鉴权头在 pi 默认的鉴权头之外追加（同名则取代），所以密钥要在这里拼进头值。
 */
export function customProviderConfig(
  rec: ProviderRecord,
  key: string | null,
  models: ModelSpec[] = rec.models,
): ProviderConfig {
  const auth = rec.authHeader ? parseAuthHeader(rec.authHeader) : null;
  return {
    baseUrl: rec.baseUrl as string,
    api: rec.api as ProviderConfig["api"],
    apiKey: "none",
    ...(auth && key
      ? { headers: { [auth.name]: literal(authHeaderValue(auth, key)) } }
      : {}),
    models: models.map((m) => ({
      ...(piModel(m) as unknown as ProviderModelConfig),
      // registerProvider 不像 models.json 那样补默认成本；缺了它，每轮结算用量时会抛错、整轮 run.failed。
      // 这是 pi 内部要求的占位，不是产品里的成本字段。
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(rec.compat ? { compat: rec.compat } : {}),
    })),
  } as ProviderConfig;
}

const KEY = "default_model";

// 会话用的模型有两个来源：供应商登记（设置页，含 pi 内置目录）与旧的「模型登记」。
// provider 先按旧登记 id 找，再按供应商 id 找；两边 id 不会撞（旧的是 uuid，内置是 pi 的供应商名，自定义也是 uuid）。
export class ModelResolver {
  constructor(
    private readonly d: {
      db: Db;
      models: ModelStore;
      providers: ProviderStore;
      catalog: Catalog;
      secrets: SecretStore;
      agentDir: string;
    },
  ) {}

  /** {provider, model} 是否指向一个能跑起来的模型。 */
  has(provider: string, model: string): boolean {
    const legacy = this.d.models.get(provider);
    if (legacy) return legacy.modelId === model;
    const rec = this.d.providers.get(provider);
    if (rec?.models.some((m) => m.id === model)) return true;
    if (rec?.custom) return false;
    const { catalog } = this.d;
    return (
      catalog.has(provider) && catalog.model(provider, model) !== undefined
    );
  }

  /**
   * 全局默认：设置页选的；没选或已失效就用旧登记里标默认的那条；
   * 都没有时取最早登记的、带有用户选入模型的供应商的第一个模型，这样第一次配好供应商就能直接用。
   */
  default(): DefaultModel | null {
    const row = this.d.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(KEY) as { value: string } | undefined;
    if (row) {
      try {
        const v = JSON.parse(row.value) as DefaultModel;
        if (this.has(v.provider, v.model)) return v;
      } catch {
        // 损坏的记录当作没设置
      }
    }
    const legacy = this.d.models.default();
    if (legacy)
      return { provider: legacy.id, model: legacy.modelId, thinking: null };
    for (const rec of this.d.providers.list()) {
      const first = rec.models[0];
      if (first) return { provider: rec.id, model: first.id, thinking: null };
    }
    return null;
  }

  setDefault(v: DefaultModel): void {
    this.d.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY, JSON.stringify(v));
  }

  /** 构造会话用的运行时与模型；指定的找不到就用全局默认，都没有返回 null（沿用 SDK 默认配置）。 */
  async build(
    provider: string | null,
    model: string | null,
  ): Promise<BuiltModel | null> {
    if (provider) {
      const hit = await this.buildOne(provider, model);
      if (hit) return hit;
    }
    const def = this.default();
    return def ? this.buildOne(def.provider, def.model) : null;
  }

  // 内置供应商的模型 = 目录条目叠上用户在设置页保存的规格；目录里没有的（手加 / 从端点导入的）借同家目录里
  // 任意一个模型的协议与端点合成。不叠规格的话，改了上下文、输出、思考映射都只是摆设。
  private builtinModel(provider: string, model: string) {
    const { catalog, providers } = this.d;
    const spec = providers.get(provider)?.models.find((m) => m.id === model);
    const inCatalog = catalog.model(provider, model);
    const base = inCatalog ?? catalog.template(provider);
    if (!base) return undefined;
    if (!spec) return inCatalog;
    const pm = piModel(spec);
    return {
      ...base,
      id: model,
      name: spec.name,
      reasoning: spec.reasoning,
      input: pm.input as typeof base.input,
      contextWindow: spec.ctx || (inCatalog ? base.contextWindow : 128_000),
      maxTokens: spec.out || (inCatalog ? base.maxTokens : 16_384),
      // 规格里的映射是权威：没写就是没有（不让模板模型的映射漏过来）
      thinkingLevelMap: pm.thinkingLevelMap as typeof base.thinkingLevelMap,
    };
  }

  // 设置页里改了或删了密钥，共享 runtime 里的运行时密钥要跟着变：只撤销我们自己设置过的，不碰 pi 自己的来源。
  private readonly appliedKeys = new Map<string, string>();
  private async applyKey(provider: string, key: string | undefined) {
    const { runtime } = this.d.catalog;
    if (key) {
      if (this.appliedKeys.get(provider) !== key) {
        await runtime.setRuntimeApiKey(provider, key);
        this.appliedKeys.set(provider, key);
      }
    } else if (this.appliedKeys.has(provider)) {
      await runtime.removeRuntimeApiKey(provider);
      this.appliedKeys.delete(provider);
    }
  }

  private async buildOne(
    provider: string,
    model: string | null,
  ): Promise<BuiltModel | null> {
    const { models, secrets, agentDir } = this.d;
    const legacy = models.get(provider);
    if (legacy) return buildRuntime(agentDir, legacy, secrets);
    if (!model) return null;
    const { catalog, providers } = this.d;
    const rec = providers.get(provider);
    const custom = rec?.custom === true;
    const auth = await resolveAuth(
      { catalog, providers, secrets },
      provider,
      rec ?? null,
      custom,
      (custom ? rec?.api : catalog.api(provider)) ?? "",
    ).catch(() => null);
    const key = auth?.own ?? undefined;

    if (!custom) {
      const m = this.builtinModel(provider, model);
      if (!m) return null;
      await this.applyKey(provider, key);
      return {
        runtime: catalog.runtime,
        model: rec?.baseUrl ? { ...m, baseUrl: rec.baseUrl } : m,
      };
    }

    // 自定义供应商没注册进 pi：把它登记进共享的 runtime（重复登记会替换模型清单）。所有会话共用这一个 runtime，
    // 这样会话运行中换模型（setModel）时，目标供应商对它的 runtime 是认得的。无密钥的本地服务给占位值，
    // 否则 SDK 认为未配置鉴权。
    if (!rec) return null;
    catalog.runtime.registerProvider(
      rec.id,
      customProviderConfig(rec, key ?? null),
    );
    await this.applyKey(rec.id, key);
    const built = catalog.runtime.getModel(rec.id, model);
    return built ? { runtime: catalog.runtime, model: built } : null;
  }
}
