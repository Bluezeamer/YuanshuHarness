import type { Db } from "./db.js";

// 一个工作区最多挂的目录个数（含主目录）。
export const WORKSPACE_DIRECTORIES_MAX = 12;

// 工作区的目录清单：有序，position 0 是主目录（逻辑 local）。
export class WorkspaceDirectoryStore {
  constructor(private readonly db: Db) {}

  get(workspaceId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT directory_id FROM workspace_directories WHERE workspace_id = ? ORDER BY position",
        )
        .all(workspaceId) as { directory_id: string }[]
    ).map((r) => r.directory_id);
  }

  // 整份替换；调用方已校验过非空、无重复、不超上限、id 存在。
  set(workspaceId: string, ids: readonly string[]): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM workspace_directories WHERE workspace_id = ?")
        .run(workspaceId);
      const ins = this.db.prepare(
        "INSERT INTO workspace_directories (workspace_id, position, directory_id) VALUES (?, ?, ?)",
      );
      ids.forEach((id, i) => {
        ins.run(workspaceId, i, id);
      });
    })();
  }

  // 哪个工作区把这个目录当主目录；没有就是 null。
  primaryOwner(directoryId: string): string | null {
    const r = this.db
      .prepare(
        "SELECT workspace_id FROM workspace_directories WHERE directory_id = ? AND position = 0",
      )
      .get(directoryId) as { workspace_id: string } | undefined;
    return r?.workspace_id ?? null;
  }

  workspacesOf(directoryId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT workspace_id FROM workspace_directories WHERE directory_id = ? ORDER BY workspace_id",
        )
        .all(directoryId) as { workspace_id: string }[]
    ).map((r) => r.workspace_id);
  }

  // 被多少个工作区引用（主目录与附加目录都算）：目录随引用存亡用的计数。
  referenceCount(directoryId: string): number {
    return (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM workspace_directories WHERE directory_id = ?",
        )
        .get(directoryId) as { n: number }
    ).n;
  }

  remove(workspaceId: string): void {
    this.db
      .prepare("DELETE FROM workspace_directories WHERE workspace_id = ?")
      .run(workspaceId);
  }
}
