import {
  matrixTool,
  type Policy,
  type ToolPolicy,
} from "../permission/tool-matrix.js";
import type { Db } from "./db.js";

type Row = { tool: string; inside: string; outside: string };

// 内置工具出厂规则的覆盖表：只存与出厂值不同的行，恢复出厂 = 删行。
export class ToolRuleStore {
  constructor(private readonly db: Db) {}

  /** 当前生效的规则（覆盖 > 出厂）；不在矩阵里的工具返回 null。 */
  effective(tool: string): ToolPolicy | null {
    const t = matrixTool(tool);
    if (!t) return null;
    const r = this.db
      .prepare("SELECT tool, inside, outside FROM tool_rules WHERE tool = ?")
      .get(tool) as Row | undefined;
    return r
      ? { inside: r.inside as Policy, outside: r.outside as Policy }
      : t.factory;
  }

  /** 与出厂值相同等于恢复出厂，不留行。 */
  set(tool: string, rule: ToolPolicy): void {
    const t = matrixTool(tool);
    if (!t) return;
    if (
      rule.inside === t.factory.inside &&
      rule.outside === t.factory.outside
    ) {
      this.reset(tool);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO tool_rules (tool, inside, outside, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tool) DO UPDATE SET inside = excluded.inside, outside = excluded.outside, updated_at = excluded.updated_at`,
      )
      .run(tool, rule.inside, rule.outside, new Date().toISOString());
  }

  /** 批量写：一个事务里逐项 set，任一项抛错则一行不写。 */
  setMany(entries: ReadonlyArray<[string, ToolPolicy]>): void {
    this.db.transaction(() => {
      for (const [tool, rule] of entries) this.set(tool, rule);
    })();
  }

  reset(tool: string): void {
    this.db.prepare("DELETE FROM tool_rules WHERE tool = ?").run(tool);
  }
}
