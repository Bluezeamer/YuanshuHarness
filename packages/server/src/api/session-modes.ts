import type { FastifyInstance } from "fastify";
import { isObject } from "../lib/validate.js";
import { PoolError, type SessionPool } from "../session/pool.js";
import { bad, notFound } from "./lib/reply.js";

// 会话的模式：可切换的清单与当前激活的模式。切换静默，下一次运行由状态通知带给模型。
export function registerSessionModes(
  app: FastifyInstance,
  pool: SessionPool,
): void {
  const view = (id: string) => {
    const e = pool.get(id);
    return {
      modes: pool.modeChoices(id),
      activeModeId: e?.activeModeId ?? null,
    };
  };

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/modes",
    async (req, reply) => {
      const entry = await pool.acquire(req.params.id);
      return entry ? view(req.params.id) : notFound(reply);
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/sessions/:id/modes",
    async (req, reply) => {
      const b = isObject(req.body) ? req.body : {};
      const ids = b.modePresetIds;
      if (
        ids !== undefined &&
        !(Array.isArray(ids) && ids.every((m) => typeof m === "string"))
      )
        return bad(reply, "bad_modes");
      const active = b.activeModeId;
      if (active !== undefined && active !== null && typeof active !== "string")
        return bad(reply, "bad_active_mode");
      if (ids === undefined && active === undefined)
        return bad(reply, "nothing_to_change");
      const entry = await pool.acquire(req.params.id);
      if (!entry) return notFound(reply);
      try {
        if (ids !== undefined) pool.setModePresetIds(req.params.id, ids);
        if (active !== undefined) pool.setActiveMode(req.params.id, active);
      } catch (err) {
        if (err instanceof PoolError && err.code === "bad_request")
          return bad(reply, "mode_not_available");
        throw err;
      }
      return view(req.params.id);
    },
  );
}
