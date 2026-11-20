import type { Db } from "./db.js";

// 工作区启用的隐私变量：默认全不开，会话只看得到所属工作区启用了的变量。
// 变量组只是变量上的组名，不在这里出现；「勾一个组 = 批量勾成员」由前端展开成 id 清单。
export class WorkspaceVariableStore {
  constructor(private readonly db: Db) {}

  enabledIds(workspaceId: string): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            "SELECT variable_id FROM workspace_variables WHERE workspace_id = ?",
          )
          .all(workspaceId) as { variable_id: string }[]
      ).map((r) => r.variable_id),
    );
  }

  workspacesOf(variableId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT workspace_id FROM workspace_variables WHERE variable_id = ? ORDER BY workspace_id",
        )
        .all(variableId) as { workspace_id: string }[]
    ).map((r) => r.workspace_id);
  }

  // 全部变量 → 工作区 id（升序）：列表接口一次取全，不用逐个查。
  byVariable(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const rows = this.db
      .prepare(
        "SELECT workspace_id, variable_id FROM workspace_variables ORDER BY workspace_id",
      )
      .all() as { workspace_id: string; variable_id: string }[];
    for (const r of rows) {
      const list = out.get(r.variable_id) ?? [];
      list.push(r.workspace_id);
      out.set(r.variable_id, list);
    }
    return out;
  }

  // 整份替换；调用方已校验过 id 存在。
  setForWorkspace(workspaceId: string, variableIds: readonly string[]): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM workspace_variables WHERE workspace_id = ?")
        .run(workspaceId);
      const ins = this.db.prepare(
        "INSERT INTO workspace_variables (workspace_id, variable_id) VALUES (?, ?)",
      );
      for (const id of new Set(variableIds)) ins.run(workspaceId, id);
    })();
  }

  setForVariable(variableId: string, workspaceIds: readonly string[]): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM workspace_variables WHERE variable_id = ?")
        .run(variableId);
      const ins = this.db.prepare(
        "INSERT INTO workspace_variables (workspace_id, variable_id) VALUES (?, ?)",
      );
      for (const id of new Set(workspaceIds)) ins.run(id, variableId);
    })();
  }
}
