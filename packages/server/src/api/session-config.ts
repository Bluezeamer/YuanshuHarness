import type { FastifyInstance, FastifyReply } from "fastify";
import type { SessionPool } from "../session/pool.js";
import {
  ConfigError,
  needsReload,
  type SessionConfigService,
} from "../session/session-config.js";

// 业务错误翻成统一的 {error}：400 带可读 code 与 detail，409 带服务端当前配置；其余原样抛出。
export function configError(err: unknown, reply: FastifyReply) {
  if (!(err instanceof ConfigError)) throw err;
  if (err.status === 409)
    return reply
      .code(409)
      .send({ error: "conflict", current: err.current ?? null });
  return reply
    .code(err.status)
    .send({ error: err.code, ...(err.detail ? { detail: err.detail } : {}) });
}

// GET / PATCH /sessions/:id/config。创建时带 config 见 sessions.ts 的 POST /sessions。
export function registerSessionConfig(
  app: FastifyInstance,
  pool: SessionPool,
  configs: SessionConfigService,
): void {
  // 没有落库的会话按最宽松的默认值合成，rev 为 0，不写库。
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/config",
    async (req, reply) => {
      const info = pool.info(req.params.id);
      if (!info) return reply.code(404).send({ error: "not_found" });
      return configs.get(info.id);
    },
  );

  // 顶层分区整体替换：模型当下一次同步生效，能力要等会话重新装载，权限档位每次工具调用即时重读。
  app.patch<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/config",
    async (req, reply) => {
      const info = pool.info(req.params.id);
      if (!info) return reply.code(404).send({ error: "not_found" });
      try {
        const { config, changed } = configs.patch(info.id, req.body);
        let appliedAt =
          pool.get(info.id) && needsReload(changed) ? "next-run" : "now";
        if (changed.includes("model") && !(await pool.syncModel(info.id)))
          appliedAt = "next-run";
        return { config, appliedAt };
      } catch (err) {
        return configError(err, reply);
      }
    },
  );
}
