import { Masker, type MaskVar } from "../permission/masking.js";
import { findPlaceholders } from "../permission/placeholders.js";
import type { Db } from "./db.js";
import { VAR_VALUE_MIN } from "./secrets.js";

export const REF_RESULTS = [
  "ok",
  "denied",
  "expired",
  "unknown",
  "dropped",
] as const;
export type RefResult = (typeof REF_RESULTS)[number];
export const isRefResult = (v: unknown): v is RefResult =>
  typeof v === "string" && (REF_RESULTS as readonly string[]).includes(v);

export interface ReferenceRecord {
  id: number;
  name: string;
  directoryId: string;
  hostId: string;
  runId: string | null;
  toolCallId: string;
  at: string;
  result: RefResult;
  /** 含占位符的那段命令原文（已遮罩、已截断）；旧记录与非命令调用为 null。 */
  command: string | null;
}

export interface ReferenceInput {
  name: string;
  directoryId: string;
  hostId: string;
  runId: string | null;
  toolCallId: string;
  result: RefResult;
  /** 模型 / 用户写的整条命令原文；落库前由 store 遮罩并截取。 */
  command?: string | undefined;
}

export interface ReferenceQuery {
  directory?: string;
  name?: string;
  result?: string;
  limit?: number;
  before?: number;
}

type Row = {
  id: number;
  name: string;
  directory_id: string;
  host_id: string;
  run_id: string | null;
  tool_call_id: string;
  at: string;
  result: string;
  command: string | null;
};

const toRecord = (r: Row): ReferenceRecord => ({
  id: r.id,
  name: r.name,
  directoryId: r.directory_id,
  hostId: r.host_id,
  runId: r.run_id,
  toolCallId: r.tool_call_id,
  at: r.at,
  result: r.result as RefResult,
  command: r.command,
});

export const REF_PAGE_DEFAULT = 100;
export const REF_PAGE_MAX = 500;
/** 命令列的字符上限。 */
export const REF_COMMAND_MAX = 500;

/**
 * 命令列的内容：先把已登记的真值遮成占位符，再截出含该变量占位符的一段。
 * 顺序不能反：先截断再遮罩，一个值被切在窗口边界上就只剩前半截，匹配不到。
 * 遮罩下限用登记下限（比输出回显的 MASK_MIN 更严）：这段文本会落库，宁可多遮。
 */
export function refCommand(
  line: string,
  name: string,
  vars: readonly MaskVar[],
  max = REF_COMMAND_MAX,
): string {
  const text = new Masker(vars, VAR_VALUE_MIN).mask(line);
  if (text.length <= max) return text;
  const hit = findPlaceholders(text, new Set([name]))[0];
  // 窗口尽量把占位符放在中间；两端被切掉时各用一个 … 标出（含在 max 内）
  const mid = hit ? Math.floor((hit.start + hit.end) / 2) : 0;
  let from = Math.max(
    0,
    Math.min(mid - Math.floor(max / 2), text.length - max),
  );
  let to = from + max;
  const head = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  from += head.length;
  to -= tail.length;
  return `${head}${text.slice(from, to)}${tail}`;
}

export class ReferenceStore {
  /**
   * maskVars：当前全部真值（变量与凭据）。没给就不存命令——没有遮罩源时宁可留空，也不冒落库明文的险。
   */
  constructor(
    private readonly db: Db,
    private readonly maskVars?: () => readonly MaskVar[],
  ) {}

  /** 写引用记录。旁路操作:失败不影响命令执行。 */
  record(rec: ReferenceInput): void {
    let command: string | null = null;
    try {
      if (rec.command && this.maskVars)
        command = refCommand(rec.command, rec.name, this.maskVars());
    } catch {
      // 遮罩出错就不存命令，记录本身照写
    }
    try {
      this.db
        .prepare(
          `INSERT INTO variable_refs (name, directory_id, host_id, run_id, tool_call_id, at, result, command)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rec.name,
          rec.directoryId,
          rec.hostId,
          rec.runId,
          rec.toolCallId,
          new Date().toISOString(),
          rec.result,
          command,
        );
    } catch {
      // 写入失败(如关闭中的数据库)不影响主路径
    }
  }

  list(q: ReferenceQuery = {}): {
    entries: ReferenceRecord[];
    nextBefore: number | null;
  } {
    const limit = Math.min(q.limit ?? REF_PAGE_DEFAULT, REF_PAGE_MAX);
    const where: string[] = [];
    const args: Array<string | number> = [];
    const eq = (col: string, v: string | undefined) => {
      if (v === undefined) return;
      where.push(`${col} = ?`);
      args.push(v);
    };
    eq("directory_id", q.directory);
    eq("name", q.name);
    eq("result", q.result);
    if (q.before !== undefined) {
      where.push("id < ?");
      args.push(q.before);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM variable_refs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as Row[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map(toRecord);
    return {
      entries: page,
      nextBefore: more ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
