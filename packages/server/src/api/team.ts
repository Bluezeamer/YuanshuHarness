import type { FastifyInstance } from "fastify";
import type { TurnChangeSet } from "../changes/tracker.js";
import type { TeamStore } from "../store/teams.js";
import type { CollabArea } from "../subagent/collab.js";
import { type BoardEntry, parseEntries, readBoard } from "../team/board.js";
import type { TeamRuntime } from "../team/runtime.js";

/** 界面上悬停卡里给的最近公告条数 */
const RECENT = 3;

export interface TeamView {
  board: {
    /** 公告板文件（Server 本机的路径），界面用预览标签打开 */
    file: string;
    count: number;
    recent: BoardEntry[];
  };
  /** 建队以来改动的文件；目录不可用或没开改动追踪时为 null */
  changes: TurnChangeSet | null;
}

// 右侧状态「团队」块的两行（公告板、团队改动）的数据源；名册走 /flows。
export async function teamApi(
  app: FastifyInstance,
  deps: {
    teams: Pick<TeamStore, "get">;
    collab: Pick<CollabArea, "boardPath">;
    runtime: Pick<TeamRuntime, "changeSet" | "fileDiff">;
  },
): Promise<void> {
  const base = "/api/v1/sessions/:id/team";
  type Params = { id: string };

  app.get<{ Params: Params }>(base, async (req, reply): Promise<TeamView> => {
    const id = req.params.id;
    if (!deps.teams.get(id)) return reply.code(404).send({ error: "no_team" });
    const file = deps.collab.boardPath(id);
    const entries = parseEntries(readBoard(file));
    return {
      board: { file, count: entries.length, recent: entries.slice(-RECENT) },
      changes: await deps.runtime.changeSet(id).catch(() => null),
    };
  });

  // 单个文件建队以来的 diff（unified 文本，前端只负责着色）。
  app.get<{ Params: Params; Querystring: { path?: string } }>(
    `${base}/diff`,
    async (req, reply) => {
      const rel = req.query.path;
      if (typeof rel !== "string" || !rel)
        return reply.code(400).send({ error: "bad_request" });
      if (!deps.teams.get(req.params.id))
        return reply.code(404).send({ error: "no_team" });
      const r = await deps.runtime
        .fileDiff(req.params.id, rel)
        .catch(() => null);
      if (r === null) return reply.code(400).send({ error: "bad_request" });
      if (r.diff === null)
        return reply.code(410).send({ error: "unavailable" });
      return { path: r.rel, diff: r.diff };
    },
  );
}
