import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

// Server 不解析文档内部结构：文档是带整数 version 的 JSON 对象，原样存取。
export type Doc = Record<string, unknown>;

export interface Snapshot {
  revision: number;
  document: Doc | null;
}

export interface SavedLayout {
  id: string;
  revision: number;
  document: Doc;
}

export type WriteResult =
  | { ok: true; revision: number }
  | { ok: false; current: Snapshot };

interface Row {
  revision: number;
  document: string;
}

export class WorkbenchStore {
  constructor(private readonly db: Db) {}

  get(): Snapshot {
    const row = this.db
      .prepare("SELECT revision, document FROM workbench WHERE id = 1")
      .get() as Row | undefined;
    return row
      ? { revision: row.revision, document: JSON.parse(row.document) as Doc }
      : { revision: 0, document: null };
  }

  // baseRevision 必须等于当前值才写入；比较与写入在同一个事务里。
  put(baseRevision: number, document: Doc): WriteResult {
    return this.db.transaction((): WriteResult => {
      const current = this.get();
      if (current.revision !== baseRevision) return { ok: false, current };
      const revision = current.revision + 1;
      this.db
        .prepare(
          `INSERT INTO workbench (id, revision, document) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, document = excluded.document`,
        )
        .run(revision, JSON.stringify(document));
      return { ok: true, revision };
    })();
  }

  listSaved(): SavedLayout[] {
    const rows = this.db
      .prepare(
        "SELECT id, revision, document FROM saved_layouts ORDER BY created_at, id",
      )
      .all() as (Row & { id: string })[];
    return rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      document: JSON.parse(r.document) as Doc,
    }));
  }

  createSaved(document: Doc, now = new Date()): SavedLayout {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO saved_layouts (id, revision, document, created_at) VALUES (?, 1, ?, ?)",
      )
      .run(id, JSON.stringify(document), now.toISOString());
    return { id, revision: 1, document };
  }

  // 返回 null 表示 id 不存在。
  putSaved(
    id: string,
    baseRevision: number,
    document: Doc,
  ): WriteResult | null {
    return this.db.transaction((): WriteResult | null => {
      const row = this.db
        .prepare("SELECT revision, document FROM saved_layouts WHERE id = ?")
        .get(id) as Row | undefined;
      if (!row) return null;
      if (row.revision !== baseRevision) {
        return {
          ok: false,
          current: {
            revision: row.revision,
            document: JSON.parse(row.document) as Doc,
          },
        };
      }
      const revision = row.revision + 1;
      this.db
        .prepare(
          "UPDATE saved_layouts SET revision = ?, document = ? WHERE id = ?",
        )
        .run(revision, JSON.stringify(document), id);
      return { ok: true, revision };
    })();
  }

  deleteSaved(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM saved_layouts WHERE id = ?").run(id)
        .changes > 0
    );
  }
}
