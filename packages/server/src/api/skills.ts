import type { FastifyInstance, FastifyReply } from "fastify";
import type { EnvHub } from "../env/hub.js";
import { readEnvSkillDir, scanEnvSkills } from "../skills/env.js";
import type { SkillRuntime } from "../skills/runtime.js";
import {
  checkSkillMd,
  FILE_MAX,
  nameProblems,
  SKILL_FILE,
  safeRelPath,
} from "../skills/spec.js";
import type { CapabilityStore } from "../store/capabilities.js";
import type { EnvironmentStore } from "../store/environments.js";
import { isScope, type SkillStore } from "../store/skills.js";
import type { WorkspaceStore } from "../store/workspaces.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (reply: FastifyReply, error = "bad_request", message?: string) =>
  reply.code(400).send(message === undefined ? { error } : { error, message });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: "not_found" });

export interface SkillsApiDeps {
  skills: SkillStore;
  capabilities: CapabilityStore;
  workspaces: WorkspaceStore;
  environments: EnvironmentStore;
  hub: EnvHub;
  runtime: SkillRuntime;
}

// 能力库 skill 的 REST（ADR-0055）：库 CRUD + 文件树读写 + 环境识别/纳入 + workspace 级分配。
export async function skillsApi(
  app: FastifyInstance,
  deps: SkillsApiDeps,
): Promise<void> {
  const { skills, capabilities, workspaces, environments, hub, runtime } = deps;

  app.get("/api/v1/skills", async () => ({ skills: skills.list() }));

  app.post("/api/v1/skills", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    if (typeof body.name !== "string" || nameProblems(body.name).length > 0)
      return bad(
        reply,
        "invalid_name",
        nameProblems(String(body.name)).join("；"),
      );
    if (!isScope(body.scope)) return bad(reply, "invalid_scope");
    if (typeof body.content !== "string") return bad(reply, "invalid_content");
    if (skills.get(body.name))
      return reply.code(409).send({ error: "name_exists" });
    const r = skills.create(body.name, body.scope, "local", [
      { path: SKILL_FILE, content: Buffer.from(body.content) },
    ]);
    return r.ok
      ? reply.code(201).send(r.value)
      : bad(reply, "invalid_skill", r.error);
  });

  // 编辑器实时校验：不落盘。
  app.post("/api/v1/skills/validate", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    if (typeof body.name !== "string" || typeof body.content !== "string")
      return bad(reply);
    const { errors, warnings } = checkSkillMd(body.name, body.content);
    return { errors, warnings };
  });

  app.get<{ Params: { name: string } }>(
    "/api/v1/skills/:name",
    async (req, reply) => {
      const skill = skills.get(req.params.name);
      if (!skill) return notFound(reply);
      return {
        skill,
        files: skills
          .files(skill.name)
          .map((f) => ({ path: f.path, size: f.content.length }))
          .sort((a, b) => (a.path < b.path ? -1 : 1)),
      };
    },
  );

  app.patch<{ Params: { name: string } }>(
    "/api/v1/skills/:name",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (!isScope(body.scope)) return bad(reply, "invalid_scope");
      const r = skills.setScope(req.params.name, body.scope);
      return r ?? notFound(reply);
    },
  );

  app.delete<{ Params: { name: string } }>(
    "/api/v1/skills/:name",
    async (req, reply) =>
      skills.remove(req.params.name) ? reply.code(204).send() : notFound(reply),
  );

  app.get<{ Params: { name: string }; Querystring: { path?: string } }>(
    "/api/v1/skills/:name/file",
    async (req, reply) => {
      const rel = safeRelPath(req.query.path);
      if (!rel) return bad(reply, "invalid_path");
      const buf = skills.readFile(req.params.name, rel);
      if (!buf) return notFound(reply);
      if (buf.includes(0))
        return reply.code(415).send({ error: "binary_file" });
      return { path: rel, content: buf.toString("utf8") };
    },
  );

  app.put<{ Params: { name: string } }>(
    "/api/v1/skills/:name/file",
    { bodyLimit: FILE_MAX * 2 },
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      const rel = safeRelPath(body.path);
      if (!rel) return bad(reply, "invalid_path");
      if (typeof body.content !== "string")
        return bad(reply, "invalid_content");
      if (!skills.get(req.params.name)) return notFound(reply);
      const r = skills.writeFile(
        req.params.name,
        rel,
        Buffer.from(body.content),
      );
      return r.ok ? r.value : bad(reply, "invalid_file", r.error);
    },
  );

  app.delete<{ Params: { name: string }; Querystring: { path?: string } }>(
    "/api/v1/skills/:name/file",
    async (req, reply) => {
      const rel = safeRelPath(req.query.path);
      if (!rel) return bad(reply, "invalid_path");
      if (!skills.get(req.params.name)) return notFound(reply);
      const r = skills.removeFile(req.params.name, rel);
      return r.ok ? r.value : bad(reply, "invalid_file", r.error);
    },
  );

  // 识别环境里已有的 skill；带 workspaceId 时一并扫该项目目录。
  app.get<{ Params: { id: string }; Querystring: { workspaceId?: string } }>(
    "/api/v1/environments/:id/skills",
    async (req, reply) => {
      const env = hub.get(req.params.id);
      if (!env) return notFound(reply);
      let projectPath: string | null = null;
      if (req.query.workspaceId !== undefined) {
        const ws = workspaces.get(req.query.workspaceId);
        if (!ws || ws.environmentId !== env.id)
          return bad(reply, "invalid_workspace");
        projectPath = ws.path;
      }
      try {
        const found = await scanEnvSkills(env, projectPath);
        return {
          skills: found.map((s) => ({
            ...s,
            inLibrary: skills.get(s.name) !== undefined,
          })),
        };
      } catch (err) {
        return reply.code(502).send({
          error: "env_unavailable",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // 把环境里的某个 skill 目录纳入库（环境里的原件不动）。
  app.post("/api/v1/skills/import", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    if (typeof body.environmentId !== "string" || typeof body.dir !== "string")
      return bad(reply);
    if (!isScope(body.scope)) return bad(reply, "invalid_scope");
    const env = hub.get(body.environmentId);
    if (!env) return notFound(reply);
    // 只允许纳入识别范围内的目录，免得借此读环境里的任意文件。
    const workspaceId =
      typeof body.workspaceId === "string"
        ? workspaces.get(body.workspaceId)
        : undefined;
    const found = await scanEnvSkills(env, workspaceId?.path ?? null).catch(
      () => [],
    );
    const hit = found.find((s) => s.dir === body.dir && !s.managed);
    if (!hit) return bad(reply, "not_a_skill_dir");
    if (skills.get(hit.name))
      return reply.code(409).send({ error: "name_exists" });
    let files: Awaited<ReturnType<typeof readEnvSkillDir>>;
    try {
      files = await readEnvSkillDir(env, hit.dir);
    } catch (err) {
      return bad(
        reply,
        "invalid_skill",
        err instanceof Error ? err.message : String(err),
      );
    }
    const envName = environments.get(env.id)?.name ?? env.id;
    const r = skills.create(hit.name, body.scope, `env:${envName}`, files);
    return r.ok
      ? reply.code(201).send(r.value)
      : bad(reply, "invalid_skill", r.error);
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/skills",
    async (req, reply) =>
      workspaces.get(req.params.id)
        ? { names: capabilities.list(req.params.id, "skill") }
        : notFound(reply),
  );

  // workspace 级只分配项目级 skill（ADR-0008）；整体替换。
  app.put<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/skills",
    async (req, reply) => {
      if (!workspaces.get(req.params.id)) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      const names = body.names;
      if (!Array.isArray(names) || !names.every((n) => typeof n === "string"))
        return bad(reply, "invalid_names");
      for (const n of names) {
        const s = skills.get(n);
        if (!s) return bad(reply, "unknown_skill", n);
        if (s.scope !== "project") return bad(reply, "not_project_scope", n);
      }
      capabilities.set(req.params.id, "skill", names);
      return { names: capabilities.list(req.params.id, "skill") };
    },
  );

  // 同步状态：最近一次对该 workspace 的同步结果（会话挂载时与手动触发都会更新）。
  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/skills/sync",
    async (req, reply) =>
      workspaces.get(req.params.id)
        ? { report: runtime.last(req.params.id) ?? null }
        : notFound(reply),
  );

  // 立即同步该 workspace 的项目级 skill（agent 级的随会话挂载同步）。
  app.post<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/skills/sync",
    async (req, reply) => {
      const ws = workspaces.get(req.params.id);
      if (!ws) return notFound(reply);
      const env = hub.get(ws.environmentId);
      if (!env) return reply.code(502).send({ error: "env_unavailable" });
      return { report: (await runtime.prepare(null, ws, env)).report };
    },
  );
}
