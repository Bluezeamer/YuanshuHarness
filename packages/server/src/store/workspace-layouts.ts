import type { Db } from "./db.js";

export interface WorkspaceLayoutSnapshot {
  revision: number;
  document: unknown;
}

export type WorkspaceLayoutWrite =
  | { ok: true; revision: number }
  | { ok: false; current: WorkspaceLayoutSnapshot };

type Row = { revision: number; document: string };

// 每个工作区一份布局文档；服务端不解析结构，原样存取。
export class WorkspaceLayoutStore {
  constructor(private readonly db: Db) {}

  get(workspaceId: string): WorkspaceLayoutSnapshot {
    const row = this.db
      .prepare(
        "SELECT revision, document FROM workspace_layouts WHERE workspace_id = ?",
      )
      .get(workspaceId) as Row | undefined;
    return row
      ? { revision: row.revision, document: JSON.parse(row.document) }
      : { revision: 0, document: null };
  }

  // baseRevision 必须等于当前值才写入；比较与写入在同一个事务里。
  put(
    workspaceId: string,
    baseRevision: number,
    document: unknown,
  ): WorkspaceLayoutWrite {
    return this.db.transaction((): WorkspaceLayoutWrite => {
      const current = this.get(workspaceId);
      if (current.revision !== baseRevision) return { ok: false, current };
      const revision = current.revision + 1;
      this.db
        .prepare(
          `INSERT INTO workspace_layouts (workspace_id, revision, document, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET revision = excluded.revision, document = excluded.document, updated_at = excluded.updated_at`,
        )
        .run(
          workspaceId,
          revision,
          JSON.stringify(document),
          new Date().toISOString(),
        );
      return { ok: true, revision };
    })();
  }
}
