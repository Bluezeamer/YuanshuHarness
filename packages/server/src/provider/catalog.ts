import { mkdirSync } from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type AuthMethod,
  type LevelMap,
  type ModelSpec,
  THINKING_LEVELS,
  type ThinkingLevelName,
} from "../store/providers.js";

export type PiModel = ReturnType<ModelRuntime["getModels"]>[number];

// pi 没有「云凭据」的元数据，这两个靠 AWS / GCP 的环境凭据认证，没有 API key 的概念。
const AMBIENT_ONLY = new Set(["amazon-bedrock", "google-vertex"]);

// 与 pi 的 getSupportedThinkingLevels 同一规则：null 表示不支持；xhigh/max 必须显式映射才算支持。
function levelsOf(m: PiModel): ThinkingLevelName[] {
  if (!m.reasoning) return [];
  return THINKING_LEVELS.filter((l) => {
    const v = m.thinkingLevelMap?.[l];
    if (v === null) return false;
    if (l === "xhigh" || l === "max") return v !== undefined;
    return true;
  });
}

function mapOf(m: PiModel, levels: ThinkingLevelName[]): LevelMap | undefined {
  const out: LevelMap = {};
  for (const l of levels) {
    const v = m.thinkingLevelMap?.[l];
    if (typeof v === "string") out[l] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export const toSpec = (m: PiModel): ModelSpec => {
  const levels = levelsOf(m);
  return {
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    levels,
    ...(mapOf(m, levels) ? { map: mapOf(m, levels) } : {}),
    // pi 的目录只声明 text / image；audio / video 只能由用户手填。
    input: [...m.input],
    ctx: m.contextWindow,
    out: m.maxTokens,
    source: "catalog",
  };
};

/** 内置供应商目录：直接读 pi 的模型注册表，不落库、不联网。 */
export class Catalog {
  private constructor(readonly runtime: ModelRuntime) {}

  static async create(agentDir: string): Promise<Catalog> {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    return new Catalog(
      await ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: null,
      }),
    );
  }

  ids(): string[] {
    return this.runtime.getProviders().map((p) => p.id);
  }

  has(id: string): boolean {
    return this.runtime.getProvider(id) !== undefined;
  }

  name(id: string): string {
    return this.runtime.getProvider(id)?.name ?? id;
  }

  baseUrl(id: string): string | undefined {
    return this.runtime.getProvider(id)?.baseUrl;
  }

  /**
   * 该供应商目录里模型的协议。聚合端点混着多种协议，取出现次数最多的（并列取先出现的）：
   * 探测与测试连接按它选鉴权头，取第一个模型的协议会把 OpenRouter 这类端点当成 anthropic-messages。
   */
  api(id: string): string | undefined {
    const count = new Map<string, number>();
    for (const m of this.runtime.getModels(id))
      count.set(m.api, (count.get(m.api) ?? 0) + 1);
    let best: string | undefined;
    for (const [api, n] of count)
      if (best === undefined || n > (count.get(best) ?? 0)) best = api;
    return best;
  }

  methods(id: string): AuthMethod[] {
    const p = this.runtime.getProvider(id);
    if (AMBIENT_ONLY.has(id)) return ["ambient", "key"];
    return [...(p?.auth.oauth ? ["oauth" as const] : []), "key", "env", "cmd"];
  }

  defaultMethod(id: string): AuthMethod {
    return AMBIENT_ONLY.has(id) ? "ambient" : "key";
  }

  models(id: string): ModelSpec[] {
    return this.runtime.getModels(id).map(toSpec);
  }

  model(id: string, modelId: string): PiModel | undefined {
    return this.runtime.getModel(id, modelId);
  }

  /** 目录里的任意一个模型：目录外的模型借它的协议、端点和 provider 标识合成。 */
  template(id: string): PiModel | undefined {
    return this.runtime.getModels(id)[0];
  }
}
