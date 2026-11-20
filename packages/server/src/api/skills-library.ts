import type { FastifyInstance, FastifyReply } from "fastify";
import { isObject } from "../lib/validate.js";
import type { SkillLibrary } from "../skills/library.js";
import { type BatchAction, SkillError, skillView } from "../skills/view.js";
import type { SkillRecord } from "../store/skills.js";
import { toHttp } from "./lib/reply.js";

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const ACTIONS: readonly BatchAction[] = [
  "update",
  "disable",
  "enable",
  "uninstall",
];
const BATCH_MAX = 100;

// 带分发达标度的单个技能（各环境副本状态要联环境，所以只在单项响应里算）。
export async function viewWithDist(library: SkillLibrary, rec: SkillRecord) {
  return skillView(rec, (await library.distribution([rec])).get(rec.name));
}

// 技能库的版本 / 锁定 / 来源 / 分发 / 批量（S5a）。旧的 CRUD 与文件读写在 skills.ts，保持不变。
export async function skillsLibraryApi(
  app: FastifyInstance,
  deps: { library: SkillLibrary },
): Promise<void> {
  const { library } = deps;

  // 业务错误统一成 { error, message }；其余异常交给 Fastify（500）。
  const guard =
    <P = unknown>(
      fn: (req: {
        params: P;
        body: unknown;
        reply: FastifyReply;
      }) => Promise<unknown>,
    ) =>
    async (req: { params: P; body: unknown }, reply: FastifyReply) => {
      try {
        return await fn({ params: req.params, body: req.body, reply });
      } catch (err) {
        return toHttp(reply, err);
      }
    };

  // 安装：来源 {kind:'auto'|'npm'|'git'|'dir', spec, subdir?} 或 {kind:'observed', hostId, path}；
  // auto 按常见写法识别（网页地址 / owner/repo / git@ / 包名 / 本地目录）；名称与描述取自 SKILL.md。
  // 仓库里有多个技能时返回 409 ambiguous_skills 并带候选（path 可当下一次的 subdir）。装完停在「待分发」。
  app.post(
    "/api/v1/skills/install",
    guard(async ({ body, reply }) => {
      const b = isObject(body) ? body : {};
      const rec = await library.install(b.source);
      return reply.code(201).send(await viewWithDist(library, rec));
    }),
  );

  app.post(
    "/api/v1/skills/batch",
    guard(async ({ body }) => {
      const b = isObject(body) ? body : {};
      if (!isStrings(b.names) || b.names.length === 0)
        throw new SkillError("invalid_names", "names 必须是非空字符串数组");
      if (b.names.length > BATCH_MAX)
        throw new SkillError("invalid_names", `一次最多 ${BATCH_MAX} 项`);
      const action = ACTIONS.find((a) => a === b.action);
      if (!action)
        throw new SkillError(
          "invalid_action",
          `action 必须是 ${ACTIONS.join(" / ")} 之一`,
        );
      return { results: await library.batch([...new Set(b.names)], action) };
    }),
  );

  app.get<{ Params: { name: string } }>(
    "/api/v1/skills/:name/versions",
    guard<{ name: string }>(async ({ params }) => ({
      name: params.name,
      ...(await library.versions(params.name)),
    })),
  );

  // 跟最新：只改库版本，环境在下次会话启动或手动同步时才拉取。
  app.post<{ Params: { name: string } }>(
    "/api/v1/skills/:name/update",
    guard<{ name: string }>(async ({ params }) => {
      const { skill, changed } = await library.update(params.name);
      return { skill: await viewWithDist(library, skill), changed };
    }),
  );

  app.post<{ Params: { name: string } }>(
    "/api/v1/skills/:name/lock",
    guard<{ name: string }>(async ({ params, body }) => {
      const b = isObject(body) ? body : {};
      return viewWithDist(library, await library.lock(params.name, b.version));
    }),
  );

  app.post<{ Params: { name: string } }>(
    "/api/v1/skills/:name/unlock",
    guard<{ name: string }>(async ({ params }) =>
      viewWithDist(library, library.unlock(params.name)),
    ),
  );

  // 补齐：把库里现有版本（锁定时即锁定版）推到落后的环境；可用 hostIds 指定环境。从不联网、不换版本。
  app.post<{ Params: { name: string } }>(
    "/api/v1/skills/:name/sync",
    guard<{ name: string }>(async ({ params, body }) => {
      const b = isObject(body) ? body : {};
      if (b.hostIds !== undefined && !isStrings(b.hostIds))
        throw new SkillError("invalid_hosts", "hostIds 必须是字符串数组");
      const results = await library.sync(params.name, b.hostIds);
      return {
        skill: await viewWithDist(library, library.must(params.name)),
        results,
      };
    }),
  );

  // 分发：把库版本推到指定环境。
  app.post<{ Params: { name: string } }>(
    "/api/v1/skills/:name/distribute",
    guard<{ name: string }>(async ({ params, body }) => {
      const b = isObject(body) ? body : {};
      if (!isStrings(b.hostIds) || b.hostIds.length === 0)
        throw new SkillError("invalid_hosts", "hostIds 必须是非空字符串数组");
      const results = await library.distribute(params.name, b.hostIds);
      return {
        skill: await viewWithDist(library, library.must(params.name)),
        results,
      };
    }),
  );
}
