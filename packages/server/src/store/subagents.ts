import type { Db } from "./db.js";

// 子会话的终态之外只有 running；interrupted 来自父被中断、显式 interrupt 或 Server 重启。
export type SubagentState = "running" | "done" | "failed" | "interrupted";

// 派发时定下的约束；子会话被恢复时按它重建，保证“只收窄不放宽”跨重启成立。
export interface SubagentSpec {
  agentId: string;
  // 子会话可见/可切换的 workspace（父已登记 workspace 的子集），第一个是起始。
  workspaceIds: string[];
  // 档位上限：子会话的生效档位不会高于它（也不高于 workspace 当前档位）。
  tierCap: "rules" | "auto";
  // 继承自父 agent 的工具名（派发时的快照）；空表示不继承。
  inheritTools: string[];
  modelId: string | null;
}

export interface SubagentRow {
  childId: string;
  parentId: string;
  depth: number;
  task: string;
  spec: SubagentSpec;
  state: SubagentState;
  result: string | null;
  // 子会话被拒绝的操作：次数与最近几条原因（拓扑节点上展示）。
  denied: number;
  deniedReasons: string[];
  // 父是否已得知终态（结果已送达、已被 wait 取走，或中断已通知）。
  told: boolean;
  createdAt: string;
  finishedAt: string | null;
}

type Row = {
  child_id: string;
  parent_id: string;
  depth: number;
  task: string;
  spec: string;
  state: string;
  result: string | null;
  told: number;
  denied: number;
  denied_reasons: string;
  created_at: string;
  finished_at: string | null;
};

const toRow = (r: Row): SubagentRow => ({
  childId: r.child_id,
  parentId: r.parent_id,
  depth: r.depth,
  task: r.task,
  spec: JSON.parse(r.spec) as SubagentSpec,
  state: r.state as SubagentState,
  result: r.result,
  told: r.told === 1,
  denied: r.denied,
  deniedReasons: JSON.parse(r.denied_reasons) as string[],
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export class SubagentStore {
  constructor(private readonly db: Db) {}

  create(r: {
    childId: string;
    parentId: string;
    depth: number;
    task: string;
    spec: SubagentSpec;
  }): void {
    this.db
      .prepare(
        "INSERT INTO subagents (child_id, parent_id, depth, task, spec, state, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
      )
      .run(
        r.childId,
        r.parentId,
        r.depth,
        r.task,
        JSON.stringify(r.spec),
        new Date().toISOString(),
      );
  }

  get(childId: string): SubagentRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM subagents WHERE child_id = ?")
      .get(childId) as Row | undefined;
    return r && toRow(r);
  }

  list(): SubagentRow[] {
    return (
      this.db
        .prepare("SELECT * FROM subagents ORDER BY created_at, child_id")
        .all() as Row[]
    ).map(toRow);
  }

  children(parentId: string): SubagentRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM subagents WHERE parent_id = ? ORDER BY created_at, child_id",
        )
        .all(parentId) as Row[]
    ).map(toRow);
  }

  runningCount(parentId: string): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM subagents WHERE parent_id = ? AND state = 'running'",
      )
      .get(parentId) as { n: number };
    return r.n;
  }

  // 只在仍是 running 时落终态，返回是否生效：显式中断与自然结束的竞争以先到者为准。
  finish(
    childId: string,
    state: Exclude<SubagentState, "running">,
    result: string | null,
  ): boolean {
    const r = this.db
      .prepare(
        "UPDATE subagents SET state = ?, result = ?, finished_at = ? WHERE child_id = ? AND state = 'running'",
      )
      .run(state, result, new Date().toISOString(), childId);
    return r.changes > 0;
  }

  markTold(childIds: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE subagents SET told = 1 WHERE child_id = ?",
    );
    for (const id of childIds) stmt.run(id);
  }

  // Server 启动时调用：上一进程里还在跑的子会话都已不存在，统一落成 interrupted。
  interruptRunning(): number {
    return this.db
      .prepare(
        "UPDATE subagents SET state = 'interrupted', finished_at = ? WHERE state = 'running'",
      )
      .run(new Date().toISOString()).changes;
  }

  // 父还没被告知的中断：下一次发消息时作为通知带给父。
  untoldInterrupted(parentId: string): SubagentRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM subagents WHERE parent_id = ? AND state = 'interrupted' AND told = 0 ORDER BY created_at, child_id",
        )
        .all(parentId) as Row[]
    ).map(toRow);
  }

  // 记一次被拒：次数累加，原因只留最近 keep 条不重复的。
  addDenial(childId: string, reason: string, keep: number): void {
    const row = this.get(childId);
    if (!row) return;
    const reasons = [...row.deniedReasons.filter((x) => x !== reason), reason];
    this.db
      .prepare(
        "UPDATE subagents SET denied = denied + 1, denied_reasons = ? WHERE child_id = ?",
      )
      .run(JSON.stringify(reasons.slice(-keep)), childId);
  }

  // 会话被删除时清掉它作为子的行；它的子会话行要留着，恢复时还靠它们重建约束。
  removeSession(id: string): void {
    this.db.prepare("DELETE FROM subagents WHERE child_id = ?").run(id);
  }
}
