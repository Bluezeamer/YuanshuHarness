import type { Db } from "./db.js";

// 接口一次最多返回的文件条数。
export const FILES_MAX = 500;
// 表里多留一条：超出 FILES_MAX 的那一条就是「发生过丢弃」的标记，接口据此带 filesTruncated，不必另存标志位。
const KEEP = FILES_MAX + 1;

// 会话内 read / edit / write 命中的文件；只存路径与计数，不存内容。
export interface FileRow {
  path: string;
  hostId: string;
  // 估算 token（见 session/context-files.ts）
  tokens: number;
  reads: number;
  modified: boolean;
  // 读到的是被截断的结果（超大文件或带 offset/limit 的分段）
  truncated: boolean;
  lastAt: string;
}

type Row = {
  host_id: string;
  path: string;
  tokens: number;
  reads: number;
  modified: number;
  truncated: number;
  last_at: string;
};

const toRow = (r: Row): FileRow => ({
  path: r.path,
  hostId: r.host_id,
  tokens: r.tokens,
  reads: r.reads,
  modified: r.modified === 1,
  truncated: r.truncated === 1,
  lastAt: r.last_at,
});

export class SessionFileStore {
  constructor(private readonly db: Db) {}

  get(sessionId: string, hostId: string, path: string): FileRow | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM session_files WHERE session_id = ? AND host_id = ? AND path = ?",
      )
      .get(sessionId, hostId, path) as Row | undefined;
    return r && toRow(r);
  }

  // 按 lastAt 倒序，最多 FILES_MAX 条；表里还有更旧的就带 truncated。
  list(sessionId: string): { files: FileRow[]; truncated: boolean } {
    const rows = this.db
      .prepare(
        "SELECT * FROM session_files WHERE session_id = ? ORDER BY last_at DESC LIMIT ?",
      )
      .all(sessionId, KEEP) as Row[];
    return {
      files: rows.slice(0, FILES_MAX).map(toRow),
      truncated: rows.length > FILES_MAX,
    };
  }

  // 写入后总条数（封顶 FILES_MAX），随 context.updated 通知给订阅者。
  count(sessionId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM session_files WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return Math.min(r.n, FILES_MAX);
  }

  // 整行写入（同 (会话, 主机, 路径) 合并），并丢掉超出上限的最旧行。
  put(sessionId: string, f: FileRow): void {
    this.db
      .prepare(
        `INSERT INTO session_files
           (session_id, host_id, path, tokens, reads, modified, truncated, last_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, host_id, path) DO UPDATE SET
           tokens = excluded.tokens, reads = excluded.reads,
           modified = excluded.modified, truncated = excluded.truncated,
           last_at = excluded.last_at`,
      )
      .run(
        sessionId,
        f.hostId,
        f.path,
        f.tokens,
        f.reads,
        f.modified ? 1 : 0,
        f.truncated ? 1 : 0,
        f.lastAt,
      );
    this.db
      .prepare(
        `DELETE FROM session_files
         WHERE session_id = ? AND (host_id, path) NOT IN (
           SELECT host_id, path FROM session_files
           WHERE session_id = ? ORDER BY last_at DESC LIMIT ?)`,
      )
      .run(sessionId, sessionId, KEEP);
  }

  remove(sessionId: string): void {
    this.db
      .prepare("DELETE FROM session_files WHERE session_id = ?")
      .run(sessionId);
  }
}
