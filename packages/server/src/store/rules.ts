import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";

export interface PermissionRule {
  id: string;
  kind: "path" | "command";
  access: "read" | "write" | null;
  value: string;
  createdAt: string;
}

type Row = {
  id: string;
  kind: string;
  access: string | null;
  value: string;
  created_at: string;
};
const toRule = (r: Row): PermissionRule => ({
  id: r.id,
  kind: r.kind as PermissionRule["kind"],
  access: r.access as PermissionRule["access"],
  value: r.value,
  createdAt: r.created_at,
});

export class RuleStore {
  constructor(private readonly db: Db) {}

  list(directoryId: string): PermissionRule[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM permission_rules WHERE directory_id = ? ORDER BY created_at, id",
        )
        .all(directoryId) as Row[]
    ).map(toRule);
  }

  // 已存在（唯一约束）时忽略，保持幂等。access 为 NULL 时唯一约束不生效，命令规则这里手动去重。
  add(
    directoryId: string,
    r: Pick<PermissionRule, "kind" | "access" | "value">,
    now = new Date(),
  ): void {
    const dup = this.db
      .prepare(
        "SELECT 1 FROM permission_rules WHERE directory_id = ? AND kind = ? AND access IS ? AND value = ?",
      )
      .get(directoryId, r.kind, r.access, r.value);
    if (dup) return;
    this.db
      .prepare(
        "INSERT INTO permission_rules (id, directory_id, kind, access, value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(uuidv7(), directoryId, r.kind, r.access, r.value, now.toISOString());
  }

  remove(directoryId: string, ruleId: string): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM permission_rules WHERE directory_id = ? AND id = ?",
        )
        .run(directoryId, ruleId).changes > 0
    );
  }
}
