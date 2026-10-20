import type { FastifyInstance, FastifyReply } from "fastify";
import type { EnvHub } from "../env/hub.js";
import { TransferError, transfer } from "../env/transfer.js";
import { recordTransfer, TransferJobs } from "../env/transfer-jobs.js";
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";
import { type AuditLog, auditSession } from "../store/audit.js";
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
  opts: {
    environments: EnvironmentStore;
    secrets: SecretStore;
    hub: EnvHub;
    audit?: AuditLog;
  },
): Promise<void> {
  const { environments, secrets, hub, audit } = opts;
  const jobs = new TransferJobs(audit);

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
      hub.forget(req.params.id);
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/environments/status", async () => ({
    statuses: environments
      .list()
      .map((e) => hub.status(e.id))
      .filter((s) => s !== null),
  }));

  // 主动建立连接并返回结果；失败时状态里带原因，HTTP 仍是 200。
  app.post<{ Params: { id: string } }>(
    "/api/v1/environments/:id/connect",
    async (req, reply) => {
      const env = hub.getSsh(req.params.id);
      if (!env) return reply.code(404).send({ error: "not_found" });
      const t0 = Date.now();
      await env.connect().catch(() => {});
      const status = env.status();
      audit?.record({
        actor: "user",
        kind: "env",
        environmentId: req.params.id,
        summary: `connect ${status.state}`,
        detail: {
          op: "connect",
          result: status.state === "connected" ? "ok" : "error",
          durationMs: Date.now() - t0,
          state: status.state,
        },
      });
      return status;
    },
  );

  // 用户在界面里拖拽触发的跨环境复制，不经 agent 权限判定；两端都必须是绝对路径。
  const endpoint = (v: unknown): { env: ExecEnv; path: string } | null => {
    if (!isObject(v) || typeof v.env !== "string") return null;
    const env = hub.get(v.env);
    const p = v.path;
    if (
      !env ||
      typeof p !== "string" ||
      p.length > 4096 ||
      p.includes("\0") ||
      !pathOf(env).isAbsolute(p)
    )
      return null;
    return { env, path: p };
  };

  app.post("/api/v1/transfers", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const from = endpoint(body.from);
    const to = endpoint(body.to);
    if (!from || !to) return bad(reply, "invalid_endpoint");
    const sessionId = auditSession(body.sessionId);
    const t0 = Date.now();
    try {
      const r = await transfer(from, to, {
        overwrite: body.overwrite === true,
      });
      recordTransfer(audit, {
        from,
        to,
        sessionId,
        outcome: "ok",
        durationMs: Date.now() - t0,
        files: r.files,
        bytes: r.bytes,
      });
      return r;
    } catch (err) {
      if (!(err instanceof TransferError)) throw err;
      recordTransfer(audit, {
        from,
        to,
        sessionId,
        outcome: err.code,
        durationMs: Date.now() - t0,
      });
      const status = {
        src_missing: 404,
        conflict: 409,
        bad_request: 400,
        copy_failed: 502,
      }[err.code];
      return reply.code(status).send({ error: err.code, message: err.message });
    }
  });

  // 后台传输：立即返回任务，进度与结果经 GET 轮询；失败原因在任务的 error 里，HTTP 仍是 200。
  app.post("/api/v1/transfer-jobs", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const from = endpoint(body.from);
    const to = endpoint(body.to);
    if (!from || !to) return bad(reply, "invalid_endpoint");
    const job = jobs.start(from, to, {
      overwrite: body.overwrite === true,
      sessionId: auditSession(body.sessionId),
    });
    return reply.code(202).send(job);
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/transfer-jobs/:id",
    async (req, reply) =>
      jobs.get(req.params.id) ?? reply.code(404).send({ error: "not_found" }),
  );
}
