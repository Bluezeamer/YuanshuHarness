// 轮次改动清单与按需 diff：对话里轮末卡片用的两个只读接口。
import type { FastifyInstance } from "fastify";
import type { TurnChangeStore } from "../changes/store.js";
import type { ChangeTracker } from "../changes/tracker.js";
import type { EnvHub } from "../env/hub.js";
import type { DirectoryStore } from "../store/directories.js";

export interface TurnChangesDeps {
  changes: TurnChangeStore;
  tracker: ChangeTracker;
  directories: DirectoryStore;
  hub: EnvHub;
  /** 会话当前所在 directory（用于取环境与仓库根）。 */
  directoryOf(sessionId: string): string | null;
}

export async function turnChangesApi(
  app: FastifyInstance,
  deps: TurnChangesDeps,
): Promise<void> {
  const base = "/api/v1/sessions/:id/turn-changes";
  type Params = { id: string };

  app.get<{ Params: Params }>(base, async (req) => ({
    turns: deps.changes.list(req.params.id),
  }));

  // 单个文件的 diff 文本（已拼成 unified 形式，前端只负责着色）。
  app.get<{
    Params: Params & { turn: string };
    Querystring: { path?: string };
  }>(`${base}/:turn/diff`, async (req, reply) => {
    const turn = Number(req.params.turn);
    const rel = req.query.path;
    if (!Number.isInteger(turn) || turn < 1 || typeof rel !== "string" || !rel)
      return reply.code(400).send({ error: "bad_request" });
    const wsId = deps.directoryOf(req.params.id);
    const ws = wsId ? deps.directories.get(wsId) : null;
    const env = ws ? deps.hub.get(ws.environmentId) : null;
    if (!ws || !env) return reply.code(404).send({ error: "no_directory" });
    const text = await deps.tracker
      .diff(`${req.params.id}:${turn}`, env, rel)
      .catch(() => null);
    if (text === null) return reply.code(410).send({ error: "unavailable" });
    return { path: rel, diff: text };
  });
}
