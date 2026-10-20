import type { FastifyInstance, FastifyReply } from "fastify";
import {
  checkVariable,
  isScopeKind,
  isVarTier,
  type SecretStore,
  type VariableInput,
} from "../store/secrets.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (reply: FastifyReply, error = "bad_request") =>
  reply.code(400).send({ error });

// 隐私变量登记接口（ADR-0050）。值只进不出：任何响应都不含 value，只给 maskable 标志。
export async function variablesApi(
  app: FastifyInstance,
  opts: { secrets: SecretStore },
): Promise<void> {
  const { secrets } = opts;

  // 解析请求体；partial=true 用于 PATCH（只处理出现的字段）。
  function parse(
    body: Record<string, unknown>,
    partial: boolean,
  ):
    | { ok: true; value: Partial<VariableInput> }
    | { ok: false; error: string } {
    const v: Partial<VariableInput> = {};
    if (!partial || body.name !== undefined) v.name = body.name as string;
    if (!partial || body.purpose !== undefined)
      v.purpose = typeof body.purpose === "string" ? body.purpose : "";
    if (!partial || body.value !== undefined) v.value = body.value as string;
    if (body.scopeKind !== undefined || !partial) {
      const k = body.scopeKind === undefined ? "any" : body.scopeKind;
      if (!isScopeKind(k)) return { ok: false, error: "invalid_scope" };
      v.scopeKind = k;
      v.scopeTarget =
        typeof body.scopeTarget === "string" ? body.scopeTarget : null;
    }
    if (body.tier !== undefined || !partial) {
      const t = body.tier === undefined ? "rules" : body.tier;
      if (!isVarTier(t)) return { ok: false, error: "invalid_tier" };
      v.tier = t;
    }
    const err = checkVariable(v, !partial);
    return err ? { ok: false, error: err } : { ok: true, value: v };
  }

  app.get("/api/v1/variables", async () => ({
    variables: secrets.listVariables(),
  }));

  app.post("/api/v1/variables", async (req, reply) => {
    const parsed = parse(isObject(req.body) ? req.body : {}, false);
    if (!parsed.ok) return bad(reply, parsed.error);
    const created = secrets.createVariable(parsed.value as VariableInput);
    if (!created) return reply.code(409).send({ error: "name_exists" });
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/variables/:id",
    async (req, reply) => {
      const parsed = parse(isObject(req.body) ? req.body : {}, true);
      if (!parsed.ok) return bad(reply, parsed.error);
      if (Object.keys(parsed.value).length === 0) return bad(reply);
      const r = secrets.updateVariable(req.params.id, parsed.value);
      if (r === undefined) return reply.code(404).send({ error: "not_found" });
      if (r === null) return reply.code(409).send({ error: "name_exists" });
      return r;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/variables/:id",
    async (req, reply) => {
      if (!secrets.removeVariable(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}
