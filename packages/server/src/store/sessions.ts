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
import { readPreview } from "./session-preview.js";

// 只持久化这两种；running / blocked 由运行时派生，不落库。
export const LIFECYCLES = ["active", "archived"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export interface IndexRow {
  id: string;
  name: string | null;
  // 首条用户消息的标题种子：显示名在 name 为空时取它。
  preview?: string | null;
  createdAt: string;
  updatedAt: string;
  // 空表示迁移前或对账补建的会话，读作默认 directory。
  directoryId?: string | null;
  // 会话创建（或最近一次同步）时拼好的提示词基线。
  promptText?: string | null;
  /** 创建时选择的 agent 预设；空 = 走默认预设 */
  promptPresetId?: string | null;
  /** 创建时多选的应用模式预设（按选择顺序） */
  modePresetIds?: string[] | null;
  /** 当前激活的模式预设 id；null = 没有模式 */
  activeModeId?: string | null;
  // 编号只在新行插入时生效（缺省则现分配）；生命周期只在读取时填充，写入走专门的 setter。
  seqNo?: number | null;
  lifecycle?: Lifecycle;
  /** 所属工作区；空 = 尚未绑定（旧行 / 对账补建的行） */
  workspaceId?: string | null;
  /** 派生关系：父会话与分叉点所在的那一条 entry */
  parentSessionId?: string | null;
  forkEntryId?: string | null;
  /** 叠加标记，看过即清 */
  unreadResult?: boolean;
  unreadError?: boolean;
  /** 置顶：左轨里排在同级会话之前；与生命周期一样只在读取时填充，写入走 setPinned */
  pinned?: boolean;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID_RE = new RegExp(`^${UUID}$`);
const FILE_RE = new RegExp(`^.+_(${UUID})\\.jsonl$`);
const HEADER_MAX = 64 * 1024;

// 会话文件按工作区分目录：数据根下每个工作区一个子目录。
export function sessionDirFor(root: string, workspaceId: string): string {
  if (!UUID_RE.test(workspaceId)) throw new Error("工作区 id 不合法");
  return path.join(root, workspaceId);
}

// 只按文件名后缀精确匹配；id 先过格式校验，绝不拼进路径。
// 先找顶层（平铺的旧文件），再找每个直接子目录（工作区目录）；不再往深里找。
export function findSessionFile(dir: string, id: string): string | null {
  if (!UUID_RE.test(id)) return null;
  const hit = (d: string): string[] => {
    try {
      return readdirSync(d).filter((n) => FILE_RE.exec(n)?.[1] === id);
    } catch {
      return [];
    }
  };
  const top = hit(dir).sort();
  if (top[0] !== undefined) return path.join(dir, top[0]);
  let subs: string[];
  try {
    subs = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  for (const sub of subs) {
    const names = hit(path.join(dir, sub)).sort();
    if (names[0] !== undefined) return path.join(dir, sub, names[0]);
  }
  return null;
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
  preview: string | null;
  created_at: string;
  updated_at: string;
  directory_id: string | null;
  prompt_text: string | null;
  prompt_preset_id: string | null;
  mode_preset_ids: string | null;
  active_mode_id: string | null;
  seq_no: number | null;
  lifecycle: string;
  workspace_id: string | null;
  parent_session_id: string | null;
  fork_entry_id: string | null;
  unread_result: number;
  unread_error: number;
  pinned: number;
};
const toRow = (r: Row): IndexRow => ({
  id: r.id,
  name: r.name,
  preview: r.preview,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  directoryId: r.directory_id,
  promptText: r.prompt_text,
  promptPresetId: r.prompt_preset_id,
  modePresetIds: r.mode_preset_ids
    ? (JSON.parse(r.mode_preset_ids) as string[])
    : null,
  activeModeId: r.active_mode_id,
  seqNo: r.seq_no,
  lifecycle: r.lifecycle as Lifecycle,
  workspaceId: r.workspace_id,
  parentSessionId: r.parent_session_id,
  forkEntryId: r.fork_entry_id,
  unreadResult: r.unread_result === 1,
  unreadError: r.unread_error === 1,
  pinned: r.pinned === 1,
});

// 文件在 <数据根>/<X>/ 下、X 是合法工作区 id 且在 workspaces 表里时才归该工作区；顶层平铺的文件不带。
function workspaceOfFile(db: Db, root: string, file: string): string | null {
  const sub = path.dirname(file);
  if (sub === root) return null;
  const id = path.basename(sub);
  if (!UUID_RE.test(id) || path.dirname(sub) !== root) return null;
  const row = db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(id);
  return row ? id : null;
}

export class SessionStore {
  constructor(private readonly db: Db) {}

  // 全局单调递增的展示编号：计数存在 meta 里，删除会话不回退，所以编号不复用。
  allocSeq(): number {
    const r = this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('session_seq', '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
         RETURNING CAST(value AS INTEGER) AS n`,
      )
      .get() as { n: number };
    return r.n;
  }

  // 新行才分配编号；已有行的冲突更新不动编号、生命周期与工作区/派生关系。
  upsert(row: IndexRow): void {
    const exists = this.db
      .prepare("SELECT 1 FROM sessions WHERE id = ?")
      .get(row.id);
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, preview, created_at, updated_at, directory_id, prompt_text, prompt_preset_id, mode_preset_ids, active_mode_id, seq_no, workspace_id, parent_session_id, fork_entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, preview = excluded.preview, updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.name,
        row.preview ?? null,
        row.createdAt,
        row.updatedAt,
        row.directoryId ?? null,
        row.promptText ?? null,
        row.promptPresetId ?? null,
        row.modePresetIds && row.modePresetIds.length > 0
          ? JSON.stringify(row.modePresetIds)
          : null,
        row.activeModeId ?? null,
        exists ? null : (row.seqNo ?? this.allocSeq()),
        row.workspaceId ?? null,
        row.parentSessionId ?? null,
        row.forkEntryId ?? null,
      );
  }

  setWorkspace(id: string, workspaceId: string | null): void {
    this.db
      .prepare("UPDATE sessions SET workspace_id = ? WHERE id = ?")
      .run(workspaceId, id);
  }

  setParent(
    id: string,
    parentSessionId: string | null,
    forkEntryId: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE sessions SET parent_session_id = ?, fork_entry_id = ? WHERE id = ?",
      )
      .run(parentSessionId, forkEntryId, id);
  }

  // 标记叠加，各自独立置 1。
  markUnread(id: string, kind: "result" | "error"): void {
    this.db
      .prepare(
        kind === "result"
          ? "UPDATE sessions SET unread_result = 1 WHERE id = ?"
          : "UPDATE sessions SET unread_error = 1 WHERE id = ?",
      )
      .run(id);
  }

  clearMarks(id: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET unread_result = 0, unread_error = 0 WHERE id = ?",
      )
      .run(id);
  }

  setLifecycle(id: string, lifecycle: Lifecycle): void {
    this.db
      .prepare("UPDATE sessions SET lifecycle = ? WHERE id = ?")
      .run(lifecycle, id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE sessions SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id);
  }

  setActiveMode(id: string, modeId: string | null): void {
    this.db
      .prepare("UPDATE sessions SET active_mode_id = ? WHERE id = ?")
      .run(modeId, id);
  }

  setModePresetIds(id: string, ids: string[]): void {
    this.db
      .prepare("UPDATE sessions SET mode_preset_ids = ? WHERE id = ?")
      .run(ids.length > 0 ? JSON.stringify(ids) : null, id);
  }

  setPromptText(id: string, text: string): void {
    this.db
      .prepare("UPDATE sessions SET prompt_text = ? WHERE id = ?")
      .run(text, id);
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

  updateDirectoryId(id: string, directoryId: string): void {
    this.db
      .prepare("UPDATE sessions SET directory_id = ? WHERE id = ?")
      .run(directoryId, id);
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

  // 每个 Agent 定义被多少个会话引用（含已归档）；会话被删，引用随之消失。
  agentRefCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT prompt_preset_id AS id, count(*) AS n FROM sessions WHERE prompt_preset_id IS NOT NULL GROUP BY prompt_preset_id",
      )
      .all() as { id: string; n: number }[];
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  list(): IndexRow[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id")
        .all() as Row[]
    ).map(toRow);
  }

  // 与 list() 同序，只取该工作区的会话。
  listByWorkspace(workspaceId: string): IndexRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC, id",
        )
        .all(workspaceId) as Row[]
    ).map(toRow);
  }

  // 已有派生数：fork 初始名「父名 · 分支N」的 N = 它 + 1。
  forkCount(parentSessionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM sessions WHERE parent_session_id = ?",
        )
        .get(parentSessionId) as { n: number }
    ).n;
  }

  // JSONL 为准：补建缺失的索引行，删除没有文件的索引行；不修改、不删除任何 JSONL。
  reconcile(
    sessionDir: string,
    warn: (msg: string) => void,
  ): { added: number; removed: number; skipped: number } {
    // 顶层 + 每个直接子目录（工作区目录）；顶层与各子目录内部按名字排序，顺序稳定。
    let dirs: string[] = [];
    try {
      dirs = [
        sessionDir,
        ...readdirSync(sessionDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(sessionDir, e.name))
          .sort(),
      ];
    } catch {}
    const files = new Map<string, string>();
    let skipped = 0;
    for (const d of dirs) {
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {}
      for (const n of names.sort()) {
        if (!n.endsWith(".jsonl")) continue;
        const id = FILE_RE.exec(n)?.[1];
        const file = path.join(d, n);
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
          preview: readPreview(file),
          createdAt: header.createdAt,
          updatedAt: statSync(file).mtime.toISOString(),
          workspaceId: workspaceOfFile(this.db, sessionDir, file),
        });
        added++;
      }
      for (const id of known) {
        if (files.has(id)) continue;
        this.remove(id);
        warn(`索引中的会话 ${id} 没有对应文件，已删除索引行`);
        removed++;
      }
      // 没有索引行的配置属于从未运行、随上个进程消失的会话（启动时对账，不会误删新会话）。
      this.db
        .prepare(
          "DELETE FROM session_configs WHERE session_id NOT IN (SELECT id FROM sessions)",
        )
        .run();
      this.db
        .prepare(
          "DELETE FROM session_state WHERE session_id NOT IN (SELECT id FROM sessions)",
        )
        .run();
      this.db
        .prepare(
          "DELETE FROM session_files WHERE session_id NOT IN (SELECT id FROM sessions)",
        )
        .run();
    })();
    return { added, removed, skipped };
  }
}
