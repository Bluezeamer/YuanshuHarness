import type { Db } from "./db.js";

export const CAPABILITY_KINDS = ["skill", "mcp"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

// workspace 级能力分配（ADR-0008：只有 skill 与 MCP 可以在 workspace 级分配）。
export class CapabilityStore {
  constructor(private readonly db: Db) {}

  list(workspaceId: string, kind: CapabilityKind): string[] {
    return (
      this.db
        .prepare(
          "SELECT name FROM workspace_capabilities WHERE workspace_id = ? AND kind = ? ORDER BY name",
        )
        .all(workspaceId, kind) as { name: string }[]
    ).map((r) => r.name);
  }

  // 整体替换该 workspace 该类能力的分配。
  set(workspaceId: string, kind: CapabilityKind, names: string[]): void {
    const del = this.db.prepare(
      "DELETE FROM workspace_capabilities WHERE workspace_id = ? AND kind = ?",
    );
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO workspace_capabilities (workspace_id, kind, name) VALUES (?, ?, ?)",
    );
    this.db.transaction(() => {
      del.run(workspaceId, kind);
      for (const n of names) ins.run(workspaceId, kind, n);
    })();
  }
}
