import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { uuidv7 } from "../id.js";
import {
  buildRuntime,
  MODEL_APIS,
  type ModelApi,
  type ModelEntry,
  type ModelStore,
  toView,
} from "../store/models.js";
import type { SecretStore } from "../store/secrets.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (reply: FastifyReply, error: string) =>
  reply.code(400).send({ error });

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.trim().length <= max
    ? v.trim()
    : null;

interface Parsed {
  name: string;
  api: ModelApi;
  baseUrl: string;
  modelId: string;
  contextWindow: number | null;
  reasoning: boolean;
  image: boolean;
  apiKey: string | null;
}

function parse(body: unknown): Parsed | string {
  if (!isObject(body)) return "bad_request";
  const name = text(body.name, 64);
  if (!name) return "invalid_name";
  if (!MODEL_APIS.includes(body.api as ModelApi)) return "invalid_api";
  const baseUrl = text(body.baseUrl, 512);
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return "invalid_base_url";
  const modelId = text(body.modelId, 200);
  if (!modelId) return "invalid_model_id";
  let contextWindow: number | null = null;
  if (body.contextWindow !== undefined && body.contextWindow !== null) {
    const n = body.contextWindow;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0)
      return "invalid_context_window";
    contextWindow = n;
  }
  const apiKey =
    typeof body.apiKey === "string" && body.apiKey !== "" ? body.apiKey : null;
  return {
    name,
    api: body.api as ModelApi,
    baseUrl,
    modelId,
    contextWindow,
    reasoning: body.reasoning === true,
    image: body.image === true,
    apiKey,
  };
}

// 模型接入向导的后端（ADR-0015）：登记、默认、删除与保存前的真实连接测试。
export async function modelsApi(
  app: FastifyInstance,
  opts: { models: ModelStore; secrets: SecretStore; agentDir: string },
): Promise<void> {
  const { models, secrets, agentDir } = opts;

  app.get("/api/v1/models", async () => ({
    models: models.list().map(toView),
  }));

  app.post("/api/v1/models", async (req, reply) => {
    const p = parse(req.body);
    if (typeof p === "string") return bad(reply, p);
    let secretId: string | null = null;
    if (p.apiKey) {
      const s = secrets.create(`model:${p.name}:${uuidv7().slice(-8)}`, "password", p.apiKey);
      secretId = s?.id ?? null;
    }
    const entry: ModelEntry = {
      id: uuidv7(),
      name: p.name,
      api: p.api,
      baseUrl: p.baseUrl,
      modelId: p.modelId,
      contextWindow: p.contextWindow,
      reasoning: p.reasoning,
      image: p.image,
      secretId,
      isDefault: false,
    };
    models.save(entry);
    return reply.code(201).send(toView(models.get(entry.id) as ModelEntry));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/models/:id",
    async (req, reply) => {
      const entry = models.get(req.params.id);
      if (!entry) return reply.code(404).send({ error: "not_found" });
      const body = isObject(req.body) ? req.body : {};
      if (body.isDefault !== true) return bad(reply, "bad_request");
      models.save({ ...entry, isDefault: true });
      return toView(models.get(entry.id) as ModelEntry);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/models/:id",
    async (req, reply) => {
      const removed = models.remove(req.params.id);
      if (!removed) return reply.code(404).send({ error: "not_found" });
      if (removed.secretId) secrets.remove(removed.secretId);
      return reply.code(204).send();
    },
  );

  // 保存前测试：不落盘，用传入的字段直接发一次真实请求。
  app.post("/api/v1/models/test", async (req, reply) => {
    const p = parse(req.body);
    if (typeof p === "string") return bad(reply, p);
    const entry: ModelEntry = {
      id: `test-${uuidv7().slice(-12)}`,
      name: p.name,
      api: p.api,
      baseUrl: p.baseUrl,
      modelId: p.modelId,
      contextWindow: p.contextWindow,
      reasoning: p.reasoning,
      image: p.image,
      secretId: null,
      isDefault: false,
    };
    try {
      const { runtime, model } = await buildRuntime(
        path.join(agentDir, "test"),
        entry,
        secrets,
        p.apiKey ?? undefined,
      );
      const reply1 = await runtime.completeSimple(
        model,
        {
          messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
        },
        { signal: AbortSignal.timeout(20_000) },
      );
      if (reply1.stopReason === "error" || reply1.stopReason === "aborted") {
        return { ok: false, error: reply1.errorMessage ?? "请求失败" };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
