import { matcherProblem, pointInfo } from "../hooks/points.js";
import { uuidv7 } from "../id.js";
import { isObject } from "../lib/validate.js";
import type { Db } from "./db.js";

export const HOOK_NAME_MAX = 100;
export const HOOK_COMMAND_MAX = 4000;
export const HOOK_MATCHER_MAX = 200;
export const HOOK_TIMEOUT_DEFAULT = 30;
export const HOOK_TIMEOUT_MAX = 600;

export interface Hook {
  id: string;
  name: string;
  point: string;
  matcher: string;
  command: string;
  timeoutSec: number;
  enabled: boolean;
  /** null = 全局。 */
  directoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HookInput {
  name: string;
  point: string;
  matcher: string;
  command: string;
  timeoutSec: number;
  enabled: boolean;
  directoryId: string | null;
}

type Row = {
  id: string;
  name: string;
  point: string;
  matcher: string;
  command: string;
  timeout_sec: number;
  enabled: number;
  directory_id: string | null;
  created_at: string;
  updated_at: string;
};

const toHook = (r: Row): Hook => ({
  id: r.id,
  name: r.name,
  point: r.point,
  matcher: r.matcher,
  command: r.command,
  timeoutSec: r.timeout_sec,
  enabled: r.enabled === 1,
  directoryId: r.directory_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * 把请求体（已与旧值合并的完整字段）校验成 HookInput；返回字符串表示问题。
 * directory 是否存在由调用方查（这里不依赖其他 store）。
 */
export function parseHookInput(raw: unknown): HookInput | string {
  if (!isObject(raw)) return "请求体须为对象";
  const { name, point, command } = raw;
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.length > HOOK_NAME_MAX
  )
    return `name 须为 1–${HOOK_NAME_MAX} 个字符`;
  const info = typeof point === "string" ? pointInfo(point) : undefined;
  if (!info) return "point 不是已知点位";
  if (
    typeof command !== "string" ||
    command.trim() === "" ||
    command.length > HOOK_COMMAND_MAX
  )
    return `command 须为 1–${HOOK_COMMAND_MAX} 个字符`;
  const matcher = raw.matcher ?? "";
  if (typeof matcher !== "string" || matcher.length > HOOK_MATCHER_MAX)
    return `matcher 须为不超过 ${HOOK_MATCHER_MAX} 个字符的字符串`;
  if (matcher !== "" && info.matchField === null)
    return `${info.id} 没有可匹配的对象，matcher 须留空`;
  const bad = matcherProblem(matcher);
  if (bad) return bad;
  const timeoutSec = raw.timeoutSec ?? HOOK_TIMEOUT_DEFAULT;
  if (
    typeof timeoutSec !== "number" ||
    !Number.isInteger(timeoutSec) ||
    timeoutSec < 1 ||
    timeoutSec > HOOK_TIMEOUT_MAX
  )
    return `timeoutSec 须为 1–${HOOK_TIMEOUT_MAX} 的整数`;
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== "boolean") return "enabled 须为布尔值";
  const directoryId = raw.directoryId ?? null;
  if (
    directoryId !== null &&
    (typeof directoryId !== "string" || directoryId === "")
  )
    return "directoryId 须为 directory id 或 null";
  return {
    name: name.trim(),
    point: info.id,
    matcher,
    command,
    timeoutSec,
    enabled,
    directoryId,
  };
}

export class HookStore {
  constructor(private readonly db: Db) {}

  list(): Hook[] {
    return (
      this.db
        .prepare("SELECT * FROM hooks ORDER BY created_at, id")
        .all() as Row[]
    ).map(toHook);
  }

  get(id: string): Hook | undefined {
    const r = this.db.prepare("SELECT * FROM hooks WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r && toHook(r);
  }

  /** 某点位上已启用、且作用域覆盖该 directory 的 hook（全局 + 该 directory），按创建顺序。 */
  forPoint(point: string, directoryId: string): Hook[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM hooks
           WHERE point = ? AND enabled = 1 AND (directory_id IS NULL OR directory_id = ?)
           ORDER BY created_at, id`,
        )
        .all(point, directoryId) as Row[]
    ).map(toHook);
  }

  create(input: HookInput, now = new Date()): Hook {
    const at = now.toISOString();
    const h: Hook = { id: uuidv7(), ...input, createdAt: at, updatedAt: at };
    this.db
      .prepare(
        `INSERT INTO hooks (id, name, point, matcher, command, timeout_sec, enabled, directory_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        h.id,
        h.name,
        h.point,
        h.matcher,
        h.command,
        h.timeoutSec,
        h.enabled ? 1 : 0,
        h.directoryId,
        h.createdAt,
        h.updatedAt,
      );
    return h;
  }

  update(id: string, input: HookInput, now = new Date()): Hook | undefined {
    const r = this.db
      .prepare(
        `UPDATE hooks SET name = ?, point = ?, matcher = ?, command = ?, timeout_sec = ?,
           enabled = ?, directory_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.name,
        input.point,
        input.matcher,
        input.command,
        input.timeoutSec,
        input.enabled ? 1 : 0,
        input.directoryId,
        now.toISOString(),
        id,
      );
    return r.changes === 0 ? undefined : this.get(id);
  }

  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM hooks WHERE id = ?").run(id).changes > 0
    );
  }
}
