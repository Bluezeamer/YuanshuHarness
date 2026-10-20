import type { Db } from "./db.js";

export type AuditActor = "user" | "agent" | "system";
export type AuditKind =
  | "tool"
  | "permission"
  | "terminal"
  | "file"
  | "transfer"
  | "env";

export interface AuditInput {
  sessionId?: string | null;
  actor: AuditActor;
  kind: AuditKind;
  environmentId?: string | null;
  summary: string;
  /** 只放短的结构化事实；不要放文件内容、命令输出、密码值。 */
  detail?: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  ts: string;
  sessionId: string | null;
  actor: AuditActor;
  kind: AuditKind;
  environmentId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface AuditQuery {
  session?: string;
  kind?: string;
  environment?: string;
  limit?: number;
  /** 只取 id 小于它的记录（上一页的 nextBefore）。 */
  before?: number;
}

export const AUDIT_SUMMARY_MAX = 300;
export const AUDIT_DETAIL_MAX = 2048;
const DETAIL_STRING_MAX = 200;
export const AUDIT_PAGE_DEFAULT = 100;
export const AUDIT_PAGE_MAX = 500;

type Row = {
  id: number;
  ts: string;
  session_id: string | null;
  actor: string;
  kind: string;
  environment_id: string | null;
  summary: string;
  detail: string | null;
};

const toEntry = (r: Row): AuditEntry => ({
  id: r.id,
  ts: r.ts,
  sessionId: r.session_id,
  actor: r.actor as AuditActor,
  kind: r.kind as AuditKind,
  environmentId: r.environment_id,
  summary: r.summary,
  detail: r.detail === null ? null : JSON.parse(r.detail),
});

const clip = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/** 用户操作归属的会话：调用方可选地带上，缺省或不合法就不归属任何会话。 */
export const auditSession = (v: unknown): string | null =>
  typeof v === "string" && v !== "" && v.length <= 100 ? v : null;

// 字符串逐个截短；整体仍超限就只留标记，保证单条审计有界。
function packDetail(detail: Record<string, unknown> | undefined) {
  if (!detail) return null;
  const text = JSON.stringify(detail, (_k, v: unknown) =>
    typeof v === "string" ? clip(v, DETAIL_STRING_MAX) : v,
  );
  return text.length <= AUDIT_DETAIL_MAX ? text : '{"truncated":true}';
}

export class AuditLog {
  constructor(private readonly db: Db) {}

  // 审计是旁路：写入失败（如关闭中的数据库）不得影响被审计的操作。
  record(e: AuditInput): void {
    try {
      this.db
        .prepare(
          "INSERT INTO audit_log (ts, session_id, actor, kind, environment_id, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          new Date().toISOString(),
          e.sessionId ?? null,
          e.actor,
          e.kind,
          e.environmentId ?? null,
          clip(e.summary, AUDIT_SUMMARY_MAX),
          packDetail(e.detail),
        );
    } catch {
      // 见上
    }
  }

  /** 按 id 倒序；还有更早的记录时 nextBefore 是下一页游标。 */
  list(q: AuditQuery = {}): {
    entries: AuditEntry[];
    nextBefore: number | null;
  } {
    const limit = Math.min(q.limit ?? AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX);
    const where: string[] = [];
    const args: Array<string | number> = [];
    const eq = (col: string, v: string | undefined) => {
      if (v === undefined) return;
      where.push(`${col} = ?`);
      args.push(v);
    };
    eq("session_id", q.session);
    eq("kind", q.kind);
    eq("environment_id", q.environment);
    if (q.before !== undefined) {
      where.push("id < ?");
      args.push(q.before);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as Row[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map(toEntry);
    return {
      entries: page,
      nextBefore: more ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
