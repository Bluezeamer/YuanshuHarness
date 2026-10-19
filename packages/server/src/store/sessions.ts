import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";

export interface IndexRow {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  // 空表示迁移前或对账补建的会话，读作默认 workspace。
  workspaceId?: string | null;
  reviewPolicy?: string | null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID_RE = new RegExp(`^${UUID}$`);
const FILE_RE = new RegExp(`^.+_(${UUID})\\.jsonl$`);
const HEADER_MAX = 64 * 1024;

// 只按文件名后缀精确匹配；id 先过格式校验，绝不拼进路径。
export function findSessionFile(dir: string, id: string): string | null {
  if (!UUID_RE.test(id)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.filter((n) => FILE_RE.exec(n)?.[1] === id).sort()[0];
  return hit === undefined ? null : path.join(dir, hit);
}

// 只读校验文件头：首行是 JSON 对象，type 为 session，id 与文件名一致，带时间戳。
// SDK 的 open 会重写空文件并换 id，所以任何文件交给 SDK 之前都必须先过这里。
export function readHeader(
  file: string,
  expectedId: string,
): { createdAt: string } | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEADER_MAX);
    const n = readSync(fd, buf, 0, HEADER_MAX, 0);
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
    const h = JSON.parse(first) as Record<string, unknown>;
    if (
      h &&
      h.type === "session" &&
      h.id === expectedId &&
      typeof h.timestamp === "string"
    )
      return { createdAt: h.timestamp };
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// 最后一条会话名称；逐行解析，坏行跳过。
export function readName(file: string): string | null {
  let name: string | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"session_info"')) continue;
    try {
      const e = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (e.type === "session_info")
        name = typeof e.name === "string" && e.name !== "" ? e.name : null;
    } catch {}
  }
  return name;
}

type Row = {
  id: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  workspace_id: string | null;
  review_policy: string | null;
};
const toRow = (r: Row): IndexRow => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  workspaceId: r.workspace_id,
  reviewPolicy: r.review_policy,
});

export class SessionStore {
  constructor(private readonly db: Db) {}

  upsert(row: IndexRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, created_at, updated_at, workspace_id, review_policy) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.name,
        row.createdAt,
        row.updatedAt,
        row.workspaceId ?? null,
        row.reviewPolicy ?? null,
      );
  }

  touch(id: string, updatedAt: string): void {
    this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(updatedAt, id);
  }

  // 改名不算活动，不改 updated_at。
  rename(id: string, name: string): void {
    this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
  }

  setReviewPolicy(id: string, policy: string | null): void {
    this.db
      .prepare("UPDATE sessions SET review_policy = ? WHERE id = ?")
      .run(policy, id);
  }

  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0
    );
  }

  get(id: string): IndexRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r && toRow(r);
  }

  list(): IndexRow[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id")
        .all() as Row[]
    ).map(toRow);
  }

  // JSONL 为准：补建缺失的索引行，删除没有文件的索引行；不修改、不删除任何 JSONL。
  reconcile(
    sessionDir: string,
    warn: (msg: string) => void,
  ): { added: number; removed: number; skipped: number } {
    let names: string[] = [];
    try {
      names = readdirSync(sessionDir);
    } catch {}
    const files = new Map<string, string>();
    let skipped = 0;
    for (const n of names.sort()) {
      if (!n.endsWith(".jsonl")) continue;
      const id = FILE_RE.exec(n)?.[1];
      const file = path.join(sessionDir, n);
      if (id === undefined) {
        warn(`跳过无法识别的会话文件名：${n}`);
        skipped++;
      } else if (files.has(id)) {
        warn(`跳过重复的会话文件（同一会话 id 有多个文件）：${n}`);
        skipped++;
      } else if (readHeader(file, id) === null) {
        warn(`跳过会话头无效的文件：${n}`);
        skipped++;
      } else files.set(id, file);
    }
    let added = 0;
    let removed = 0;
    this.db.transaction(() => {
      const known = new Set(this.list().map((r) => r.id));
      for (const [id, file] of files) {
        if (known.has(id)) continue;
        const header = readHeader(file, id);
        if (!header) continue;
        this.upsert({
          id,
          name: readName(file),
          createdAt: header.createdAt,
          updatedAt: statSync(file).mtime.toISOString(),
        });
        added++;
      }
      for (const id of known) {
        if (files.has(id)) continue;
        this.remove(id);
        warn(`索引中的会话 ${id} 没有对应文件，已删除索引行`);
        removed++;
      }
    })();
    return { added, removed, skipped };
  }
}
