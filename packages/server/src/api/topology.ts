import type { FastifyInstance } from "fastify";
import type { SessionPool } from "../session/pool.js";
import type { SubagentState, SubagentStore } from "../store/subagents.js";

// 根会话只有 running/idle；子会话在 running 之外沿用父子关系里的终态。
export type NodeState = "running" | "idle" | SubagentState;

export interface TopologyNode {
  id: string;
  name: string | null;
  // 父会话已删除时为 null，按根处理。
  parentId: string | null;
  depth: number;
  state: NodeState;
  // 子会话的派发任务；根为 null。
  task: string | null;
  // 子会话被拒绝的操作：次数与最近几条原因。
  denied: number;
  deniedReasons: string[];
  updatedAt: string | null;
}

// 协作拓扑（ADR-0060）：只列出处在父子关系里的会话，没有子代理的普通会话不进图。
export async function topologyApi(
  app: FastifyInstance,
  opts: { pool: SessionPool; subagents: SubagentStore },
): Promise<void> {
  app.get("/api/v1/topology", async () => {
    const rows = opts.subagents.list();
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.childId);
      ids.add(r.parentId);
    }
    const byChild = new Map(rows.map((r) => [r.childId, r]));
    const nodes: TopologyNode[] = [];
    for (const id of ids) {
      const info = opts.pool.info(id);
      const row = byChild.get(id);
      // 父已被删除（索引里没有）又不是任何人的子：孤儿根，不画。
      if (!info && !row) continue;
      const running = info?.running === true;
      nodes.push({
        id,
        name: info?.name ?? null,
        parentId: row && opts.pool.info(row.parentId) ? row.parentId : null,
        depth: row?.depth ?? 0,
        state: row
          ? row.state === "running" || running
            ? "running"
            : row.state
          : running
            ? "running"
            : "idle",
        task: row?.task ?? null,
        denied: row?.denied ?? 0,
        deniedReasons: row?.deniedReasons ?? [],
        updatedAt: info?.updatedAt ?? row?.finishedAt ?? row?.createdAt ?? null,
      });
    }
    return { nodes };
  });
}
