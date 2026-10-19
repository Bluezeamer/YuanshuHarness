import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SecretStore } from "./secrets.js";

// 三种主流协议（ADR-0015）。
export const MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type ModelApi = (typeof MODEL_APIS)[number];

export interface ModelEntry {
  id: string; // 供应商登记 id，同时作为 pi 的 provider id
  name: string;
  api: ModelApi;
  baseUrl: string;
  modelId: string;
  contextWindow: number | null;
  reasoning: boolean;
  image: boolean;
  secretId: string | null; // API key 在密码库的 id；本地无鉴权的服务可为空
  isDefault: boolean;
}

export type ModelView = Omit<ModelEntry, "secretId"> & { hasKey: boolean };

export const toView = ({ secretId, ...rest }: ModelEntry): ModelView => ({
  ...rest,
  hasKey: secretId !== null,
});

// 模型登记：每条一个 JSON 文件，放在数据目录的 models/ 下。API key 只存密码库的引用。
export class ModelStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "models");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  list(): ModelEntry[] {
    const out: ModelEntry[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(
          JSON.parse(
            readFileSync(path.join(this.dir, f), "utf8"),
          ) as ModelEntry,
        );
      } catch {
        // 损坏的文件跳过，不拖垮其余模型。
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ModelEntry | null {
    return this.list().find((m) => m.id === id) ?? null;
  }

  // 第一次登记的自动成为默认。
  save(entry: ModelEntry): void {
    if (this.list().every((m) => m.id === entry.id)) entry.isDefault = true;
    if (entry.isDefault) {
      for (const m of this.list()) {
        if (m.id !== entry.id && m.isDefault)
          this.write({ ...m, isDefault: false });
      }
    }
    this.write(entry);
  }

  remove(id: string): ModelEntry | null {
    const m = this.get(id);
    if (!m) return null;
    rmSync(path.join(this.dir, `${id}.json`), { force: true });
    const rest = this.list();
    if (m.isDefault && rest[0]) this.write({ ...rest[0], isDefault: true });
    return m;
  }

  default(): ModelEntry | null {
    const all = this.list();
    return all.find((m) => m.isDefault) ?? all[0] ?? null;
  }

  private write(m: ModelEntry): void {
    writeFileSync(
      path.join(this.dir, `${m.id}.json`),
      JSON.stringify(m, null, 2),
      {
        mode: 0o600,
      },
    );
  }
}

// 按登记项构造 pi 的 ModelRuntime：models.json 写在 agentDir，密钥运行时注入、不落盘。
export async function buildRuntime(
  agentDir: string,
  entry: ModelEntry,
  secrets: SecretStore,
  keyOverride?: string,
) {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const modelsPath = path.join(agentDir, `models-${entry.id}.json`);
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        [entry.id]: {
          baseUrl: entry.baseUrl,
          api: entry.api,
          // 无密钥的本地服务给占位值，否则 SDK 认为未配置鉴权。
          ...(entry.secretId || keyOverride ? {} : { apiKey: "none" }),
          models: [
            {
              id: entry.modelId,
              reasoning: entry.reasoning,
              input: entry.image ? ["text", "image"] : ["text"],
              ...(entry.contextWindow
                ? { contextWindow: entry.contextWindow }
                : {}),
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath,
  });
  {
    const key =
      keyOverride ?? (entry.secretId ? secrets.reveal(entry.secretId) : null);
    if (key) await runtime.setRuntimeApiKey(entry.id, key);
  }
  const model = runtime.getModel(entry.id, entry.modelId);
  if (!model) throw new Error("model_not_found");
  return { runtime, model };
}
