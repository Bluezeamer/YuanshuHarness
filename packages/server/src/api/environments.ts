import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type EnvironmentInput,
  type EnvironmentStore,
  isOsType,
} from "../store/environments.js";
import { isSecretKind, type SecretStore } from "../store/secrets.js";
import { cleanName } from "../store/workspaces.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (reply: FastifyReply, error = "bad_request") =>
  reply.code(400).send({ error });

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.trim().length <= max
    ? v.trim()
    : null;

// 密码库与 ssh 环境的登记接口。密码值只进不出：列表与返回体都不含 value。
export async function environmentsApi(
  app: FastifyInstance,
  opts: { environments: EnvironmentStore; secrets: SecretStore },
): Promise<void> {
  const { environments, secrets } = opts;

  app.get("/api/v1/secrets", async () => ({ secrets: secrets.list() }));

  app.post("/api/v1/secrets", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const name = cleanName(body.name);
    if (name === null) return bad(reply, "invalid_name");
    if (!isSecretKind(body.kind)) return bad(reply, "invalid_kind");
    if (typeof body.value !== "string" || body.value === "")
      return bad(reply, "invalid_value");
    let created: ReturnType<SecretStore["create"]>;
    try {
      created = secrets.create(name, body.kind, body.value);
    } catch (err) {
      if (err instanceof RangeError) return bad(reply, "invalid_value");
      throw err;
    }
    if (!created) return reply.code(409).send({ error: "name_exists" });
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/secrets/:id",
    async (req, reply) => {
      const r = secrets.remove(req.params.id);
      if (r === "not_found")
        return reply.code(404).send({ error: "not_found" });
      if (r === "in_use") return reply.code(409).send({ error: "in_use" });
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/environments", async () => ({
    environments: environments.list(),
  }));

  // 解析并校验字段；partial=true 用于 PATCH（只校验出现的字段）。
  function parse(
    body: Record<string, unknown>,
    partial: boolean,
  ):
    | { ok: true; value: Partial<EnvironmentInput> }
    | { ok: false; error: string } {
    const v: Partial<EnvironmentInput> = {};
    if (!partial || body.name !== undefined) {
      const n = cleanName(body.name);
      if (n === null) return { ok: false, error: "invalid_name" };
      v.name = n;
    }
    if (!partial || body.host !== undefined) {
      const h = str(body.host, 253);
      if (h === null) return { ok: false, error: "invalid_host" };
      v.host = h;
    }
    if (!partial || body.username !== undefined) {
      const u = str(body.username, 64);
      if (u === null) return { ok: false, error: "invalid_username" };
      v.username = u;
    }
    if (body.port !== undefined || !partial) {
      const p = body.port === undefined ? 22 : body.port;
      if (!Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535)
        return { ok: false, error: "invalid_port" };
      v.port = p as number;
    }
    if (body.os !== undefined || !partial) {
      const o = body.os === undefined ? "posix" : body.os;
      if (!isOsType(o)) return { ok: false, error: "invalid_os" };
      v.os = o;
    }
    if (body.secretId !== undefined) {
      if (body.secretId !== null) {
        if (typeof body.secretId !== "string" || !secrets.get(body.secretId))
          return { ok: false, error: "invalid_secret" };
      }
      v.secretId = body.secretId as string | null;
    } else if (!partial) v.secretId = null;
    return { ok: true, value: v };
  }

  app.post("/api/v1/environments", async (req, reply) => {
    const parsed = parse(isObject(req.body) ? req.body : {}, false);
    if (!parsed.ok) return bad(reply, parsed.error);
    const created = environments.create(parsed.value as EnvironmentInput);
    if (!created) return reply.code(409).send({ error: "name_exists" });
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/environments/:id",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      const parsed = parse(body, true);
      if (!parsed.ok) return bad(reply, parsed.error);
      if (Object.keys(parsed.value).length === 0) return bad(reply);
      const r = environments.update(req.params.id, parsed.value);
      if (r === undefined) return reply.code(404).send({ error: "not_found" });
      if (r === null) return reply.code(409).send({ error: "name_exists" });
      return r;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/environments/:id",
    async (req, reply) => {
      const r = environments.remove(req.params.id);
      if (r === "not_found")
        return reply.code(404).send({ error: "not_found" });
      if (r === "in_use") return reply.code(409).send({ error: "in_use" });
      return reply.code(204).send();
    },
  );
}
