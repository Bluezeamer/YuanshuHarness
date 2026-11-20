import type { Db } from "./db.js";

// running 之外都是终态：done 正常结束；failed 异常退出（退出码非 0 / 工具报错）；
// stopped 被停止；interrupted 因 Server 重启而中断。
export type JobState =
  | "running"
  | "done"
  | "failed"
  | "stopped"
  | "interrupted";

/** 任务输入（完整命令 / 工具参数）最多留这么多字符：界面详情用，超出的截掉。 */
export const INPUT_MAX = 20_000;

export interface JobRow {
  id: string;
  /** 直接调用方（回调送给它） */
  sessionId: string;
  kind: "command" | "tool" | "subagent";
  /** 被后台运行的工具名 */
  name: string;
  label: string;
  /** 完整输入：命令原文，或工具参数的 JSON；子代理 / 工作流等留空串 */
  input: string;
  /** 子代理任务：子会话 id */
  ref: string | null;
  state: JobState;
  exitCode: number | null;
  /** 提醒间隔；0 = 不提醒 */
  remindMs: number;
  /** 调用方是否已得知终态（回调送出，或它自己停的） */
  told: boolean;
  startedAt: string;
  endedAt: string | null;
}

type Row = {
  id: string;
  session_id: string;
  kind: string;
  name: string;
  label: string;
  input: string;
  ref: string | null;
  state: string;
  exit_code: number | null;
  remind_ms: number;
  told: number;
  started_at: string;
  ended_at: string | null;
};

const toRow = (r: Row): JobRow => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind as JobRow["kind"],
  name: r.name,
  label: r.label,
  input: r.input,
  ref: r.ref,
  state: r.state as JobState,
  exitCode: r.exit_code,
  remindMs: r.remind_ms,
  told: r.told === 1,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export class JobStore {
  constructor(private readonly db: Db) {}

  create(
    r: Pick<
      JobRow,
      "id" | "sessionId" | "kind" | "name" | "label" | "remindMs"
    > & { ref?: string | null; startedAt?: string; input?: string },
  ): void {
    this.db
      .prepare(
        "INSERT INTO jobs (id, session_id, kind, name, label, input, ref, state, remind_ms, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)",
      )
      .run(
        r.id,
        r.sessionId,
        r.kind,
        r.name,
        r.label,
        (r.input ?? "").slice(0, INPUT_MAX),
        r.ref ?? null,
        r.remindMs,
        r.startedAt ?? new Date().toISOString(),
      );
  }

  get(id: string): JobRow | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r && toRow(r);
  }

  /** 按启动时间升序；session 缺省列全部。 */
  list(session?: string): JobRow[] {
    const rows = (
      session === undefined
        ? this.db.prepare("SELECT * FROM jobs ORDER BY started_at, id").all()
        : this.db
            .prepare(
              "SELECT * FROM jobs WHERE session_id = ? ORDER BY started_at, id",
            )
            .all(session)
    ) as Row[];
    return rows.map(toRow);
  }

  /** 只在仍是 running 时落终态，返回是否生效：自然结束与停止的竞争以先到者为准。 */
  finish(
    id: string,
    state: Exclude<JobState, "running">,
    exitCode: number | null,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET state = ?, exit_code = ?, ended_at = ? WHERE id = ? AND state = 'running'",
        )
        .run(state, exitCode, new Date().toISOString(), id).changes > 0
    );
  }

  /** 任务是个子代理：记下子会话，kind 改成 subagent（job_start 包着 spawn_subagent 时事后才知道）。 */
  link(id: string, ref: string): void {
    this.db
      .prepare("UPDATE jobs SET kind = 'subagent', ref = ? WHERE id = ?")
      .run(ref, id);
  }

  byRef(ref: string): JobRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM jobs WHERE ref = ? ORDER BY started_at DESC")
      .get(ref) as Row | undefined;
    return r && toRow(r);
  }

  /** 已结束的任务回到运行中（子代理被唤醒开新一轮）。 */
  reopen(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET state = 'running', exit_code = NULL, ended_at = NULL, told = 0 WHERE id = ? AND state != 'running'",
        )
        .run(id).changes > 0
    );
  }

  setRemind(id: string, remindMs: number): void {
    this.db
      .prepare("UPDATE jobs SET remind_ms = ? WHERE id = ?")
      .run(remindMs, id);
  }

  markTold(id: string): void {
    this.db.prepare("UPDATE jobs SET told = 1 WHERE id = ?").run(id);
  }

  /** 调用方还没得知的终态任务（它当时不在线，或重启中断） */
  untold(session: string): JobRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE session_id = ? AND told = 0 AND state != 'running' ORDER BY started_at, id",
        )
        .all(session) as Row[]
    ).map(toRow);
  }

  /** Server 启动时调用：上一进程里还在跑的任务都已不存在，统一落成 interrupted。 */
  interruptRunning(): void {
    this.db
      .prepare(
        "UPDATE jobs SET state = 'interrupted', ended_at = ? WHERE state = 'running'",
      )
      .run(new Date().toISOString());
  }

  removeSession(session: string): void {
    this.db.prepare("DELETE FROM jobs WHERE session_id = ?").run(session);
  }
}
