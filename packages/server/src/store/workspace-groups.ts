import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";

export const GROUP_NAME_MAX = 24;
export const GROUP_TONES = 7;

export interface WorkspaceGroup {
  id: string;
  name: string;
  // 色号 0..6，前端循环取色。
  tone: number;
  collapsed: boolean;
  order: number;
}

type Row = {
  id: string;
  name: string;
  tone: number;
  collapsed: number;
  sort_order: number;
};
const toGroup = (r: Row): WorkspaceGroup => ({
  id: r.id,
  name: r.name,
  tone: r.tone,
  collapsed: r.collapsed === 1,
  order: r.sort_order,
});

export class WorkspaceGroupStore {
  constructor(private readonly db: Db) {}

  list(): WorkspaceGroup[] {
    return (
      this.db
        .prepare("SELECT * FROM workspace_groups ORDER BY sort_order, id")
        .all() as Row[]
    ).map(toGroup);
  }

  get(id: string): WorkspaceGroup | undefined {
    const r = this.db
      .prepare("SELECT * FROM workspace_groups WHERE id = ?")
      .get(id) as Row | undefined;
    return r && toGroup(r);
  }

  // 新分组排在最后；未指定色号时按已有数量循环取色。
  create(input: { name: string; tone?: number }): WorkspaceGroup {
    const id = uuidv7();
    const n = (
      this.db.prepare("SELECT count(*) AS n FROM workspace_groups").get() as {
        n: number;
      }
    ).n;
    const next = (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(sort_order), 0) + 1 AS o FROM workspace_groups",
        )
        .get() as { o: number }
    ).o;
    this.db
      .prepare(
        "INSERT INTO workspace_groups (id, name, tone, collapsed, sort_order) VALUES (?, ?, ?, 0, ?)",
      )
      .run(id, input.name, input.tone ?? n % GROUP_TONES, next);
    return this.get(id) as WorkspaceGroup;
  }

  update(
    id: string,
    patch: Partial<Omit<WorkspaceGroup, "id">>,
  ): WorkspaceGroup | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        "UPDATE workspace_groups SET name = ?, tone = ?, collapsed = ?, sort_order = ? WHERE id = ?",
      )
      .run(next.name, next.tone, next.collapsed ? 1 : 0, next.order, id);
    return this.get(id);
  }

  // 只解散：组内工作区保留，group_id 置空。
  remove(id: string): boolean {
    return this.db.transaction(() => {
      this.db
        .prepare("UPDATE workspaces SET group_id = NULL WHERE group_id = ?")
        .run(id);
      return (
        this.db.prepare("DELETE FROM workspace_groups WHERE id = ?").run(id)
          .changes > 0
      );
    })();
  }
}
