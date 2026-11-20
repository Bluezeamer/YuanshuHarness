import type { FastifyInstance } from "fastify";
import { isObject } from "../lib/validate.js";
import {
  DirectoryInputError,
  type DirectoryResolver,
  type ResolvedDirectory,
} from "../session/directory-resolver.js";
import type { SessionPool } from "../session/pool.js";
import { cleanName, type DirectoryStore } from "../store/directories.js";
import type { RuleStore } from "../store/rules.js";
import { bad } from "./lib/reply.js";

export async function directoriesApi(
  app: FastifyInstance,
  opts: {
    directories: DirectoryStore;
    rules: RuleStore;
    pool: SessionPool | null;
    resolver: DirectoryResolver;
  },
): Promise<void> {
  const { directories, rules, pool, resolver } = opts;

  app.get("/api/v1/directories", async () => ({
    directories: directories.list(),
  }));

  app.post("/api/v1/directories", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    let input: ResolvedDirectory;
    try {
      input = await resolver.resolve({
        environmentId: body.environmentId,
        path: body.path,
        name: body.name,
      });
    } catch (err) {
      // 解析入参的失败与以前同样只回 {error}，不带 message。
      if (err instanceof DirectoryInputError)
        return reply.code(err.status).send({ error: err.code });
      throw err;
    }
    const ws = directories.create(
      input.name,
      input.path,
      new Date(),
      input.environmentId,
    );
    if (!ws) return reply.code(409).send({ error: "path_exists" });
    return reply.code(201).send(ws);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/directories/:id",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (body.name === undefined) return bad(reply);
      const name = cleanName(body.name);
      if (name === null) return bad(reply, "invalid_name");
      const current = directories.get(req.params.id);
      if (!current) return reply.code(404).send({ error: "not_found" });
      // 同一主机上名字唯一；改成自己现在的名字不算冲突。
      if (directories.nameTaken(current.environmentId, name, current.id))
        return reply.code(409).send({ error: "name_exists" });
      return directories.rename(req.params.id, name);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/directories/:id",
    async (req, reply) => {
      if (!directories.get(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      const inUse = pool
        ? pool.directoryInUse(req.params.id)
        : directories.sessionCount(req.params.id) > 0;
      if (inUse) return reply.code(409).send({ error: "directory_in_use" });
      directories.remove(req.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/directories/:id/rules",
    async (req, reply) => {
      if (!directories.get(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return { rules: rules.list(req.params.id) };
    },
  );

  app.delete<{ Params: { id: string; ruleId: string } }>(
    "/api/v1/directories/:id/rules/:ruleId",
    async (req, reply) => {
      if (!rules.remove(req.params.id, req.params.ruleId))
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}
