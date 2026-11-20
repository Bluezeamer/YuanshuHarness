// 轮次改动清单的存储：只存路径/状态/增删行数（diff 正文不落库）。

import type { Db } from "../store/db.js";
import type { ChangeStatus, FileChange, TurnChangeSet } from "./tracker.js";

export interface StoredTurn {
  turn: number;
  mode: "git" | "files";
  total: number;
  createdAt: string;
  /** 这一轮最后一条助手消息的 ts：前端用它把卡片挂到对应消息下面 */
  anchorTs: string | null;
  files: FileChange[];
}

type Row = {
  turn: number;
  path: string;
  status: string;
  added: number;
  removed: number;
  total: number;
  mode: string;
  created_at: string;
  anchor_ts: string | null;
};

export class TurnChangeStore {
  constructor(private readonly db: Db) {}

  /** 一轮的清单落库；空轮不写（避免历史里全是没有信息的卡片）。 */
  save(
    sessionId: string,
    turn: number,
    set: TurnChangeSet,
    anchorTs: string | null = null,
  ): void {
    if (set.files.length === 0) return;
    const at = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO turn_changes
         (session_id, turn, path, status, added, removed, total, mode, created_at, anchor_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const f of set.files)
        stmt.run(
          sessionId,
          turn,
          f.path,
          f.status,
          f.added,
          f.removed,
          set.total,
          set.mode,
          at,
          anchorTs,
        );
    });
    tx();
  }

  /** 该会话所有轮次，按轮次升序。 */
  list(sessionId: string): StoredTurn[] {
    const rows = this.db
      .prepare(
        `SELECT turn, path, status, added, removed, total, mode, created_at, anchor_ts
           FROM turn_changes WHERE session_id = ?
          ORDER BY turn ASC, path ASC`,
      )
      .all(sessionId) as Row[];
    const byTurn = new Map<number, StoredTurn>();
    for (const r of rows) {
      let t = byTurn.get(r.turn);
      if (!t) {
        t = {
          turn: r.turn,
          mode: r.mode === "git" ? "git" : "files",
          total: r.total,
          createdAt: r.created_at,
          anchorTs: r.anchor_ts ?? null,
          files: [],
        };
        byTurn.set(r.turn, t);
      }
      t.files.push({
        path: r.path,
        status: (r.status as ChangeStatus) ?? "modified",
        added: r.added,
        removed: r.removed,
      });
    }
    return [...byTurn.values()];
  }

  /** 下一个轮次号（1 起）。 */
  nextTurn(sessionId: string): number {
    const r = this.db
      .prepare(
        `SELECT COALESCE(MAX(turn), 0) AS n FROM turn_changes WHERE session_id = ?`,
      )
      .get(sessionId) as { n: number } | undefined;
    return (r?.n ?? 0) + 1;
  }

  /** 会话被删时清掉（调用方负责）。 */
  clear(sessionId: string): void {
    this.db
      .prepare(`DELETE FROM turn_changes WHERE session_id = ?`)
      .run(sessionId);
  }
}
