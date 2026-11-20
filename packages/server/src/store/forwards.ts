import type { Db } from "./db.js";

// 服务转发：一条记录就是一个转发出口端口（local_port）到「环境回环上的 port」的映射。
// 落库是为了重启后拿回同一个出口端口；监听本身在 forward/service.ts 里活着。
export interface ForwardRow {
  id: string;
  workspaceKey: string;
  envId: string;
  port: number;
  localPort: number;
  createdAt: string;
}

type Row = {
  id: string;
  workspace_key: string;
  env_id: string;
  port: number;
  local_port: number;
  created_at: string;
};

const toRow = (r: Row): ForwardRow => ({
  id: r.id,
  workspaceKey: r.workspace_key,
  envId: r.env_id,
  port: r.port,
  localPort: r.local_port,
  createdAt: r.created_at,
});

export class ForwardStore {
  constructor(private readonly db: Db) {}

  list(workspaceKey: string): ForwardRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM forwards WHERE workspace_key = ? ORDER BY local_port",
      )
      .all(workspaceKey) as Row[];
    return rows.map(toRow);
  }

  all(): ForwardRow[] {
    const rows = this.db
      .prepare("SELECT * FROM forwards ORDER BY local_port")
      .all() as Row[];
    return rows.map(toRow);
  }

  get(id: string): ForwardRow | null {
    const r = this.db.prepare("SELECT * FROM forwards WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? toRow(r) : null;
  }

  find(workspaceKey: string, envId: string, port: number): ForwardRow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM forwards WHERE workspace_key = ? AND env_id = ? AND port = ?",
      )
      .get(workspaceKey, envId, port) as Row | undefined;
    return r ? toRow(r) : null;
  }

  insert(row: ForwardRow): void {
    this.db
      .prepare(
        `INSERT INTO forwards (id, workspace_key, env_id, port, local_port, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workspaceKey,
        row.envId,
        row.port,
        row.localPort,
        row.createdAt,
      );
  }

  delete(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM forwards WHERE id = ?").run(id).changes > 0
    );
  }
}
