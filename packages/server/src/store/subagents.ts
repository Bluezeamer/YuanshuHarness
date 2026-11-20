import type { Db } from "./db.js";

// 子会话的终态之外只有 running；interrupted 来自父被中断、显式 interrupt 或 Server 重启。
export type SubagentState = "running" | "done" | "failed" | "interrupted";

// 派发时定下的约束；子会话被恢复时按它重建，保证“只收窄不放宽”跨重启成立。
export interface SubagentSpec {
  /** 派发时选的 agent 预设；子会话恢复时按它重建提示词 */
  agentPresetId: string;
  // 子会话可见的 directory：派发时定下的子集，但子代理只在一个目录里工作、不能切换，所以永远只有一个元素。
  directoryIds: string[];
  // 派发时父会话的主目录：子代理里的 local 指的是它所在的主机，不是子集里的第一个。
  primaryDirectoryId: string;
  // 档位上限：子会话的生效档位不会高于它（也不高于 directory 当前档位）。
  tierCap: "rules" | "auto";
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
  // 是否计入存活上限：工作流的 agent 走工作流自己的并发限制，不计入。
  counted: boolean;
  // 交付时 report 存成的文件路径（协作区里）；没有长报告为 null。
  report: string | null;
  // 工作流里的 agent：所属运行（工作流任务 id）与阶段；其他子代理为 null。
  runId: string | null;
  phase: string | null;
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
  report: string | null;
  denied: number;
  denied_reasons: string;
  counted: number;
  run_id: string | null;
  phase: string | null;
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
  report: r.report,
  denied: r.denied,
  deniedReasons: JSON.parse(r.denied_reasons) as string[],
  counted: r.counted === 1,
  runId: r.run_id,
  phase: r.phase,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export class SubagentStore {
  /** 行被增删或改了 state 时通知（server.ts 接到列表流上）；库内不关心谁在用。 */
  onChange: ((childId: string) => void) | null = null;

  constructor(private readonly db: Db) {}

  private changed(childId: string): void {
    this.onChange?.(childId);
  }

  create(r: {
    childId: string;
    parentId: string;
    depth: number;
    task: string;
    spec: SubagentSpec;
    counted?: boolean;
    run?: { id: string; phase: string | null };
  }): void {
    this.db
      .prepare(
        "INSERT INTO subagents (child_id, parent_id, depth, task, spec, state, counted, run_id, phase, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)",
      )
      .run(
        r.childId,
        r.parentId,
        r.depth,
        r.task,
        JSON.stringify(r.spec),
        r.counted === false ? 0 : 1,
        r.run?.id ?? null,
        r.run?.phase ?? null,
        new Date().toISOString(),
      );
    this.changed(r.childId);
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
        "SELECT COUNT(*) AS n FROM subagents WHERE parent_id = ? AND state = 'running' AND counted = 1",
      )
      .get(parentId) as { n: number };
    return r.n;
  }

  // 只在仍是 running 时落终态，返回是否生效：显式中断与自然结束的竞争以先到者为准。
  finish(
    childId: string,
    state: Exclude<SubagentState, "running">,
    result: string | null,
    report: string | null = null,
  ): boolean {
    const r = this.db
      .prepare(
        "UPDATE subagents SET state = ?, result = ?, report = ?, finished_at = ? WHERE child_id = ? AND state = 'running'",
      )
      .run(state, result, report, new Date().toISOString(), childId);
    if (r.changes > 0) this.changed(childId);
    return r.changes > 0;
  }

  // 已结束的子代理被 message_subagent 唤醒：回到运行中，开新一轮。
  reopen(childId: string): boolean {
    const done =
      this.db
        .prepare(
          "UPDATE subagents SET state = 'running', finished_at = NULL WHERE child_id = ? AND state != 'running'",
        )
        .run(childId).changes > 0;
    if (done) this.changed(childId);
    return done;
  }

  /**
   * 从根会话往下整棵树里仍存活的子代理数（不含根）。工作流的 agent 本身不数，但它名下的子代理照数。
   */
  aliveInTree(rootId: string): number {
    let n = 0;
    const stack = [rootId];
    while (stack.length > 0) {
      for (const c of this.children(stack.pop() as string)) {
        if (c.state === "running" && c.counted) n++;
        stack.push(c.childId);
      }
    }
    return n;
  }

  // 与 aliveInTree 同一个遍历，但不论 counted：工作流 agent 不算存活名额，在跑也要算「执行中」。
  hasRunningInTree(rootId: string): boolean {
    const stack = [rootId];
    while (stack.length > 0) {
      for (const c of this.children(stack.pop() as string)) {
        if (c.state === "running") return true;
        stack.push(c.childId);
      }
    }
    return false;
  }

  /** 某会话所在那棵树的根：沿 parent 一路往上。 */
  rootOf(id: string): string {
    let cur = id;
    for (let row = this.get(cur); row; row = this.get(cur)) cur = row.parentId;
    return cur;
  }

  // Server 启动时调用：上一进程里还在跑的子会话都已不存在，统一落成 interrupted。
  interruptRunning(): number {
    const running = this.list().filter((r) => r.state === "running");
    const n = this.db
      .prepare(
        "UPDATE subagents SET state = 'interrupted', finished_at = ? WHERE state = 'running'",
      )
      .run(new Date().toISOString()).changes;
    for (const r of running) this.changed(r.childId);
    return n;
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
    const row = this.get(id);
    this.db.prepare("DELETE FROM subagents WHERE child_id = ?").run(id);
    if (row) this.changed(id);
  }
}
