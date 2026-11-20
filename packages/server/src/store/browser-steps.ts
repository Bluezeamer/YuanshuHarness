import type { Db } from "./db.js";

// 回放的一步：agent 改变页面的动作做完后的一张画面（图片在 frames 里）。行记在根会话名下，
// 每个会话只留最近 keep 步，超出的最旧行被挤掉（调用方据返回的 id 删图片）。
export interface StepRow {
  id: number;
  workspaceKey: string;
  sessionId: string; // 根会话
  pageId: string;
  ts: string; // ISO
  tool: string;
  summary: string;
  url: string;
  title: string;
}

/** 一个会话的回放概况：多少步、跨哪段时间。 */
export interface SessionSteps {
  sessionId: string;
  steps: number;
  firstTs: string;
  lastTs: string;
}

type Row = {
  id: number;
  workspace_key: string;
  session_id: string;
  page_id: string;
  ts: string;
  tool: string;
  summary: string;
  url: string;
  title: string;
};

const toRow = (r: Row): StepRow => ({
  id: r.id,
  workspaceKey: r.workspace_key,
  sessionId: r.session_id,
  pageId: r.page_id,
  ts: r.ts,
  tool: r.tool,
  summary: r.summary,
  url: r.url,
  title: r.title,
});

export class BrowserStepStore {
  constructor(private readonly db: Db) {}

  /** 插入一步，并把这个会话只保留最新 keep 步；返回新行 id 与被挤掉的行 id（调用方据此删图片）。同一事务。 */
  insert(
    row: Omit<StepRow, "id">,
    keep: number,
  ): { id: number; dropped: number[] } {
    return this.db.transaction((): { id: number; dropped: number[] } => {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO browser_steps (workspace_key, session_id, page_id, ts, tool, summary, url, title)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.workspaceKey,
          row.sessionId,
          row.pageId,
          row.ts,
          row.tool,
          row.summary,
          row.url,
          row.title,
        );
      const id = Number(lastInsertRowid);
      const dropped = (
        this.db
          .prepare(
            "SELECT id FROM browser_steps WHERE session_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?",
          )
          .all(row.sessionId, keep) as { id: number }[]
      ).map((r) => r.id);
      if (dropped.length > 0) {
        const del = this.db.prepare("DELETE FROM browser_steps WHERE id = ?");
        for (const gone of dropped) del.run(gone);
      }
      return { id, dropped };
    })();
  }

  /** 这个工作区里有回放的会话，最近有动作的在前。 */
  listSessions(workspaceKey: string): SessionSteps[] {
    return (
      this.db
        .prepare(
          `SELECT session_id, count(*) AS steps, min(ts) AS first_ts, max(ts) AS last_ts
           FROM browser_steps WHERE workspace_key = ?
           GROUP BY session_id ORDER BY max(ts) DESC, max(id) DESC`,
        )
        .all(workspaceKey) as {
        session_id: string;
        steps: number;
        first_ts: string;
        last_ts: string;
      }[]
    ).map((r) => ({
      sessionId: r.session_id,
      steps: r.steps,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
    }));
  }

  /** 一个会话的全部步，按 id 升序；工作区不符返回空数组。 */
  list(workspaceKey: string, sessionId: string): StepRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM browser_steps WHERE session_id = ? AND workspace_key = ? ORDER BY id",
      )
      .all(sessionId, workspaceKey) as Row[];
    return rows.map(toRow);
  }

  get(
    workspaceKey: string,
    sessionId: string,
    id: number,
  ): StepRow | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM browser_steps WHERE id = ? AND session_id = ? AND workspace_key = ?",
      )
      .get(id, sessionId, workspaceKey) as Row | undefined;
    return r === undefined ? undefined : toRow(r);
  }

  /** 会话删除：删它的全部步，返回被删的行 id。 */
  removeSession(sessionId: string): number[] {
    return this.db.transaction((): number[] => {
      const ids = (
        this.db
          .prepare(
            "SELECT id FROM browser_steps WHERE session_id = ? ORDER BY id",
          )
          .all(sessionId) as { id: number }[]
      ).map((r) => r.id);
      this.db
        .prepare("DELETE FROM browser_steps WHERE session_id = ?")
        .run(sessionId);
      return ids;
    })();
  }
}
