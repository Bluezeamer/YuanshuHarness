import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { SessionPool } from "../session/pool.js";
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
  },
): Promise<void> {
  const { workspaces, rules, pool } = opts;

  app.get("/api/v1/workspaces", async () => ({
    workspaces: workspaces.list(),
  }));

  app.post("/api/v1/workspaces", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const dir = resolveDirectory(body.path);
    if (!dir.ok) return bad(reply, "invalid_path");
    const name =
      body.name === undefined
        ? cleanName(path.basename(dir.path) || dir.path)
        : cleanName(body.name);
    if (name === null) return bad(reply, "invalid_name");
    const ws = workspaces.create(name, dir.path);
    if (!ws) return reply.code(409).send({ error: "path_exists" });
    return reply.code(201).send(ws);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (body.name === undefined && body.tier === undefined) return bad(reply);
      let name: string | undefined;
      if (body.name !== undefined) {
        const n = cleanName(body.name);
        if (n === null) return bad(reply, "invalid_name");
        name = n;
      }
      if (body.tier !== undefined && !isTier(body.tier))
        return bad(reply, "invalid_tier");
      const ws = workspaces.update(req.params.id, {
        ...(name === undefined ? {} : { name }),
        ...(isTier(body.tier) ? { tier: body.tier } : {}),
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
