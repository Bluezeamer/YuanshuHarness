import type { FastifyInstance, FastifyReply } from "fastify";
import type { EnvHub } from "../env/hub.js";
import { isObject } from "../lib/validate.js";
import { readEnvSkillDir, scanEnvSkills } from "../skills/env.js";
import type { SkillLibrary } from "../skills/library.js";
import type { SkillRuntime } from "../skills/runtime.js";
import {
  checkSkillMd,
  FILE_MAX,
  nameProblems,
  SKILL_FILE,
  safeRelPath,
} from "../skills/spec.js";
import { skillView } from "../skills/view.js";
import type { DirectoryStore } from "../store/directories.js";
import type { EnvironmentStore } from "../store/environments.js";
import { isScope, type SkillStore } from "../store/skills.js";
import { bad, notFound } from "./lib/reply.js";
import { skillsLibraryApi, viewWithDist } from "./skills-library.js";

// 经来源安装的 skill 是来源的镜像，库里不手改（改了下次更新就被覆盖）。
const readOnlySource = (reply: FastifyReply) =>
  reply.code(409).send({
    error: "read_only_source",
    message: "该技能来自外部来源，库里的文件不可编辑",
  });

export interface SkillsApiDeps {
  skills: SkillStore;
  directories: DirectoryStore;
  environments: EnvironmentStore;
  hub: EnvHub;
  runtime: SkillRuntime;
  library: SkillLibrary;
}

// 能力库 skill 的 REST（ADR-0055）：库 CRUD + 文件树读写 + 环境识别/纳入。
// 版本 / 锁定 / 来源安装 / 分发 / 批量在 skills-library.ts（S5a）；这里的旧路由保持可用，响应只追加字段。
export async function skillsApi(
  app: FastifyInstance,
  deps: SkillsApiDeps,
): Promise<void> {
  const { skills, directories, environments, hub, runtime } = deps;
  const { library } = deps;
  await app.register(skillsLibraryApi, { library });

  // 每项带各环境的分发达标度 dist；环境探测有超时，探测不到的环境标 missing 并说明原因。
  app.get("/api/v1/skills", async () => {
    const recs = skills.list();
    const dist = await library.distribution(recs);
    return { skills: recs.map((r) => skillView(r, dist.get(r.name))) };
  });

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
      ? reply.code(201).send(skillView(r.value))
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
      try {
        return {
          skill: await viewWithDist(library, skill),
          files: await library.listFiles(skill),
        };
      } catch (err) {
        return reply.code(502).send({
          error: "env_unavailable",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.patch<{ Params: { name: string } }>(
    "/api/v1/skills/:name",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (!isScope(body.scope)) return bad(reply, "invalid_scope");
      const r = skills.setScope(req.params.name, body.scope);
      return r ? skillView(r) : notFound(reply);
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
      const skill = skills.get(req.params.name);
      if (!skill) return notFound(reply);
      const buf = await library.readFile(skill, rel).catch(() => null);
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
      const skill = skills.get(req.params.name);
      if (!skill) return notFound(reply);
      if (skill.origin !== null) return readOnlySource(reply);
      const r = skills.writeFile(
        req.params.name,
        rel,
        Buffer.from(body.content),
      );
      return r.ok ? skillView(r.value) : bad(reply, "invalid_file", r.error);
    },
  );

  app.delete<{ Params: { name: string }; Querystring: { path?: string } }>(
    "/api/v1/skills/:name/file",
    async (req, reply) => {
      const rel = safeRelPath(req.query.path);
      if (!rel) return bad(reply, "invalid_path");
      const skill = skills.get(req.params.name);
      if (!skill) return notFound(reply);
      if (skill.origin !== null) return readOnlySource(reply);
      const r = skills.removeFile(req.params.name, rel);
      return r.ok ? skillView(r.value) : bad(reply, "invalid_file", r.error);
    },
  );

  // 识别环境里已有的 skill；带 directoryId 时一并扫该项目目录。
  app.get<{ Params: { id: string }; Querystring: { directoryId?: string } }>(
    "/api/v1/environments/:id/skills",
    async (req, reply) => {
      const env = hub.get(req.params.id);
      if (!env) return notFound(reply);
      let projectPath: string | null = null;
      if (req.query.directoryId !== undefined) {
        const ws = directories.get(req.query.directoryId);
        if (!ws || ws.environmentId !== env.id)
          return bad(reply, "invalid_directory");
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
    const directoryId =
      typeof body.directoryId === "string"
        ? directories.get(body.directoryId)
        : undefined;
    const found = await scanEnvSkills(env, directoryId?.path ?? null).catch(
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
      ? reply.code(201).send(skillView(r.value))
      : bad(reply, "invalid_skill", r.error);
  });

  // 同步状态：最近一次对该 directory 的同步结果（会话挂载时与手动触发都会更新）。
  app.get<{ Params: { id: string } }>(
    "/api/v1/directories/:id/skills/sync",
    async (req, reply) =>
      directories.get(req.params.id)
        ? { report: runtime.last(req.params.id) ?? null }
        : notFound(reply),
  );

  // 立即同步该 directory 的项目级 skill（agent 级的随会话挂载同步）。
  app.post<{ Params: { id: string } }>(
    "/api/v1/directories/:id/skills/sync",
    async (req, reply) => {
      const ws = directories.get(req.params.id);
      if (!ws) return notFound(reply);
      const env = hub.get(ws.environmentId);
      if (!env) return reply.code(502).send({ error: "env_unavailable" });
      return { report: (await runtime.prepare(null, ws, env)).report };
    },
  );
}
