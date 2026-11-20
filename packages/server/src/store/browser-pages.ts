import type { Db } from "./db.js";

// 浏览器页面的持久记录：一条页面 + 「用过它的会话」引用集合。
// 真页面只在内存里活着；这里只负责 Server 重启后的恢复与列表。
export interface PageRow {
  id: string;
  /** 页面归工作区；没有工作区的会话由上层给一个只属于它的键。 */
  workspaceKey: string;
  url: string;
  title: string;
  userOpened: boolean;
  controller: "agent" | "user";
  state: "active" | "sleeping";
  /** 交还给 agent 时加一，上层据此让旧元素编号作废。 */
  epoch: number;
  createdAt: string;
  lastUsedAt: string;
}

type Row = {
  id: string;
  workspace_key: string;
  url: string;
  title: string;
  user_opened: number;
  controller: string;
  state: string;
  epoch: number;
  created_at: string;
  last_used_at: string;
};

const toRow = (r: Row): PageRow => ({
  id: r.id,
  workspaceKey: r.workspace_key,
  url: r.url,
  title: r.title,
  userOpened: r.user_opened === 1,
  controller: r.controller as PageRow["controller"],
  state: r.state as PageRow["state"],
  epoch: r.epoch,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export class BrowserPageStore {
  constructor(private readonly db: Db) {}

  insert(row: PageRow, usedBy: string[]): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO browser_pages (id, workspace_key, url, title, user_opened, controller, state, epoch, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.workspaceKey,
          row.url,
          row.title,
          row.userOpened ? 1 : 0,
          row.controller,
          row.state,
          row.epoch,
          row.createdAt,
          row.lastUsedAt,
        );
      const addRef = this.db.prepare(
        "INSERT OR IGNORE INTO browser_page_refs (page_id, session_id) VALUES (?, ?)",
      );
      for (const s of usedBy) addRef.run(row.id, s);
    })();
  }

  get(id: string): { row: PageRow; usedBy: string[] } | undefined {
    const r = this.db
      .prepare("SELECT * FROM browser_pages WHERE id = ?")
      .get(id) as Row | undefined;
    if (!r) return undefined;
    return { row: toRow(r), usedBy: this.refs(id) };
  }

  /** 按最后使用时间降序；workspaceKey 缺省列全部。 */
  list(workspaceKey?: string): { row: PageRow; usedBy: string[] }[] {
    const rows = (
      workspaceKey === undefined
        ? this.db
            .prepare(
              "SELECT * FROM browser_pages ORDER BY last_used_at DESC, id",
            )
            .all()
        : this.db
            .prepare(
              "SELECT * FROM browser_pages WHERE workspace_key = ? ORDER BY last_used_at DESC, id",
            )
            .all(workspaceKey)
    ) as Row[];
    return rows.map((r) => ({ row: toRow(r), usedBy: this.refs(r.id) }));
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        PageRow,
        | "url"
        | "title"
        | "userOpened"
        | "controller"
        | "state"
        | "epoch"
        | "lastUsedAt"
      >
    >,
  ): void {
    const sets: string[] = [];
    const args: (string | number)[] = [];
    const put = (col: string, v: string | number | undefined) => {
      if (v === undefined) return;
      sets.push(`${col} = ?`);
      args.push(v);
    };
    put("url", patch.url);
    put("title", patch.title);
    put(
      "user_opened",
      patch.userOpened === undefined ? undefined : patch.userOpened ? 1 : 0,
    );
    put("controller", patch.controller);
    put("state", patch.state);
    put("epoch", patch.epoch);
    put("last_used_at", patch.lastUsedAt);
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE browser_pages SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args, id);
  }

  addRef(pageId: string, sessionId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO browser_page_refs (page_id, session_id) VALUES (?, ?)",
      )
      .run(pageId, sessionId);
  }

  /** 会话归档 / 删除：去掉它在所有页面上的引用，返回受影响的页面 id。 */
  removeSessionRefs(sessionId: string): string[] {
    const ids = (
      this.db
        .prepare(
          "SELECT page_id FROM browser_page_refs WHERE session_id = ? ORDER BY page_id",
        )
        .all(sessionId) as { page_id: string }[]
    ).map((r) => r.page_id);
    this.db
      .prepare("DELETE FROM browser_page_refs WHERE session_id = ?")
      .run(sessionId);
    return ids;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM browser_pages WHERE id = ?").run(id);
  }

  /** 删工作区：连同它的页面与引用，返回被删的页面 id。 */
  deleteWorkspace(workspaceKey: string): string[] {
    return this.db.transaction((): string[] => {
      const ids = (
        this.db
          .prepare(
            "SELECT id FROM browser_pages WHERE workspace_key = ? ORDER BY id",
          )
          .all(workspaceKey) as { id: string }[]
      ).map((r) => r.id);
      this.db
        .prepare("DELETE FROM browser_pages WHERE workspace_key = ?")
        .run(workspaceKey);
      return ids;
    })();
  }

  private refs(pageId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT session_id FROM browser_page_refs WHERE page_id = ? ORDER BY session_id",
        )
        .all(pageId) as { session_id: string }[]
    ).map((r) => r.session_id);
  }
}
