// 内置工具描述覆盖：给「工具」页调优用。
import type { Db } from "./db.js";

export interface ToolDescription {
  name: string;
  description: string;
  updatedAt: string;
}

const KEY_ORIGINALS = "tool_original_descriptions";

export class ToolDescriptionStore {
  constructor(private readonly db: Db) {}

  all(): ToolDescription[] {
    const rows = this.db
      .prepare("SELECT name, description, updated_at FROM tool_descriptions")
      .all() as { name: string; description: string; updated_at: string }[];
    return rows.map((r) => ({
      name: r.name,
      description: r.description,
      updatedAt: r.updated_at,
    }));
  }

  set(name: string, description: string): ToolDescription {
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tool_descriptions (name, description, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at`,
      )
      .run(name, description, at);
    return { name, description, updatedAt: at };
  }

  remove(name: string): void {
    this.db.prepare("DELETE FROM tool_descriptions WHERE name = ?").run(name);
  }

  /** 各工具的原始描述（pi 与 Server 注册时写的，不含覆盖）：调优页显示模型实际收到的原文用。 */
  originals(): Record<string, string> {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(KEY_ORIGINALS) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Record<string, string>) : {};
  }

  /** 会话创建时记一次：以最近一次为准（pi 升级、Server 改了描述后自动跟上）。内容没变就不写。 */
  recordOriginals(
    tools: readonly { name: string; description: string }[],
  ): void {
    const next = { ...this.originals() };
    let changed = false;
    for (const t of tools)
      if (next[t.name] !== t.description) {
        next[t.name] = t.description;
        changed = true;
      }
    if (!changed) return;
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY_ORIGINALS, JSON.stringify(next));
  }
}
