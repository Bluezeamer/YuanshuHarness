import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { EnvHub } from "../env/hub.js";
import type { SessionPool } from "../session/pool.js";
import { LOCAL_ENV_ID } from "../store/environments.js";
import type { RuleStore } from "../store/rules.js";
import {
  cleanName,
  isTier,
  resolveDirectory,
  type WorkspaceStore,
} from "../store/workspaces.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (reply: FastifyReply, error = "bad_request") =>
  reply.code(400).send({ error });

export async function workspacesApi(
  app: FastifyInstance,
  opts: {
    workspaces: WorkspaceStore;
    rules: RuleStore;
    pool: SessionPool | null;
    hub: EnvHub;
  },
): Promise<void> {
  const { workspaces, rules, pool, hub } = opts;

  app.get("/api/v1/workspaces", async () => ({
    workspaces: workspaces.list(),
  }));

  // 远程目录经环境原语解析：必须是 POSIX 绝对路径、真实存在且是目录。
  async function resolveRemote(
    environmentId: string,
    raw: unknown,
  ): Promise<string | null> {
    const env = hub.getSsh(environmentId);
    if (!env || typeof raw !== "string" || !path.posix.isAbsolute(raw))
      return null;
    const real = await env.realpath(raw);
    if (real === null) return null;
    return (await env.stat(real))?.isDirectory ? real : null;
  }

  app.post("/api/v1/workspaces", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const environmentId =
      body.environmentId === undefined ? LOCAL_ENV_ID : body.environmentId;
    if (typeof environmentId !== "string")
      return bad(reply, "invalid_environment");
    const remote = environmentId !== LOCAL_ENV_ID;
    let dirPath: string;
    if (!remote) {
      const dir = resolveDirectory(body.path);
      if (!dir.ok) return bad(reply, "invalid_path");
      dirPath = dir.path;
    } else {
      if (!hub.getSsh(environmentId)) return bad(reply, "invalid_environment");
      let real: string | null;
      try {
        real = await resolveRemote(environmentId, body.path);
      } catch {
        return reply.code(502).send({ error: "env_unreachable" });
      }
      if (real === null) return bad(reply, "invalid_path");
      dirPath = real;
    }
    const base = remote ? path.posix : path;
    const name =
      body.name === undefined
        ? cleanName(base.basename(dirPath) || dirPath)
        : cleanName(body.name);
    if (name === null) return bad(reply, "invalid_name");
    const ws = workspaces.create(name, dirPath, new Date(), environmentId);
    if (!ws) return reply.code(409).send({ error: "path_exists" });
    return reply.code(201).send(ws);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (
        body.name === undefined &&
        body.tier === undefined &&
        body.injectConventions === undefined
      )
        return bad(reply);
      let name: string | undefined;
      if (body.name !== undefined) {
        const n = cleanName(body.name);
        if (n === null) return bad(reply, "invalid_name");
        name = n;
      }
      if (body.tier !== undefined && !isTier(body.tier))
        return bad(reply, "invalid_tier");
      if (
        body.injectConventions !== undefined &&
        typeof body.injectConventions !== "boolean"
      )
        return bad(reply, "invalid_inject_conventions");
      const ws = workspaces.update(req.params.id, {
        ...(name === undefined ? {} : { name }),
        ...(isTier(body.tier) ? { tier: body.tier } : {}),
        ...(typeof body.injectConventions === "boolean"
          ? { injectConventions: body.injectConventions }
          : {}),
      });
      if (!ws) return reply.code(404).send({ error: "not_found" });
      return ws;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id",
    async (req, reply) => {
      if (!workspaces.get(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      const inUse = pool
        ? pool.workspaceInUse(req.params.id)
        : workspaces.sessionCount(req.params.id) > 0;
      if (inUse) return reply.code(409).send({ error: "workspace_in_use" });
      workspaces.remove(req.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/rules",
    async (req, reply) => {
      if (!workspaces.get(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return { rules: rules.list(req.params.id) };
    },
  );

  app.delete<{ Params: { id: string; ruleId: string } }>(
    "/api/v1/workspaces/:id/rules/:ruleId",
    async (req, reply) => {
      if (!rules.remove(req.params.id, req.params.ruleId))
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}
