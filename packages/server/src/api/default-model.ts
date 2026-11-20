import type { FastifyInstance } from "fastify";
import { isObject } from "../lib/validate.js";
import type { ModelResolver } from "../provider/resolve.js";
import { THINKING_LEVELS } from "../store/providers.js";

// 全局默认模型：agent 与会话都没指定模型时用它。GET 在没设置时回落到旧登记里标默认的那条。
export async function defaultModelApi(
  app: FastifyInstance,
  opts: { resolver: ModelResolver },
): Promise<void> {
  const { resolver } = opts;

  app.get("/api/v1/default-model", async () => ({
    default: resolver.default(),
  }));

  app.put("/api/v1/default-model", async (req, reply) => {
    const b = isObject(req.body) ? req.body : {};
    const { provider, model, thinking } = b;
    if (typeof provider !== "string" || typeof model !== "string")
      return reply.code(400).send({ error: "bad_request" });
    if (
      thinking !== undefined &&
      thinking !== null &&
      !(THINKING_LEVELS as readonly unknown[]).includes(thinking)
    )
      return reply.code(400).send({ error: "invalid_thinking" });
    if (!resolver.has(provider, model))
      return reply.code(404).send({ error: "unknown_model" });
    resolver.setDefault({
      provider,
      model,
      thinking: typeof thinking === "string" ? thinking : null,
    });
    return { default: resolver.default() };
  });
}
