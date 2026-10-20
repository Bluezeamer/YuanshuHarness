import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";
import { LOCAL_ENV_ID } from "./environments.js";

export const TIERS = ["rules", "auto", "full"] as const;
export type Tier = (typeof TIERS)[number];
export const isTier = (v: unknown): v is Tier =>
  typeof v === "string" && (TIERS as readonly string[]).includes(v);

export const NAME_MAX = 100;

export interface Workspace {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  tier: Tier;
  // 会话创建时是否把 workspace 里的 AGENTS.md 注入提示词（项目约定）。
  injectConventions: boolean;
  createdAt: string;
}

type Row = {
  id: string;
  name: string;
  path: string;
  environment_id: string;
  tier: string;
  inject_conventions: number;
  created_at: string;
};
const toWorkspace = (r: Row): Workspace => ({
  id: r.id,
  name: r.name,
  path: r.path,
  environmentId: r.environment_id,
  tier: r.tier as Tier,
  injectConventions: r.inject_conventions !== 0,
  createdAt: r.created_at,
});

// 登记路径：必须是存在的绝对目录；返回解析符号链接后的路径，否则返回原因。
export function resolveDirectory(
  raw: unknown,
): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || !path.isAbsolute(raw))
    return { ok: false, message: "path 必须是绝对路径" };
  try {
    const real = realpathSync(raw);
    if (!statSync(real).isDirectory())
      return { ok: false, message: "path 不是目录" };
    return { ok: true, path: real };
  } catch {
    return { ok: false, message: "path 不存在或无法访问" };
  }
}

// name 去空白后 1–100 字符；不合规返回 null。
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= NAME_MAX ? name : null;
}

export class WorkspaceStore {
  constructor(private readonly db: Db) {}

  list(): Workspace[] {
    return (
      this.db
        .prepare("SELECT * FROM workspaces ORDER BY created_at, id")
        .all() as Row[]
    ).map(toWorkspace);
  }

  get(id: string): Workspace | undefined {
    const r = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id) as Row | undefined;
    return r && toWorkspace(r);
  }

  // 最早登记的 workspace；会话 workspace_id 为空时读作它。
  getDefault(): Workspace | undefined {
    const r = this.db
      .prepare("SELECT * FROM workspaces ORDER BY created_at, id LIMIT 1")
      .get() as Row | undefined;
    return r && toWorkspace(r);
  }

  getByPath(p: string, environmentId = LOCAL_ENV_ID): Workspace | undefined {
    const r = this.db
      .prepare("SELECT * FROM workspaces WHERE path = ? AND environment_id = ?")
      .get(p, environmentId) as Row | undefined;
    return r && toWorkspace(r);
  }

  // path 须已解析；同一环境内重复路径返回 null。
  create(
    name: string,
    p: string,
    now = new Date(),
    environmentId = LOCAL_ENV_ID,
  ): Workspace | null {
    if (this.getByPath(p, environmentId)) return null;
    const ws: Workspace = {
      id: uuidv7(),
      name,
      path: p,
      environmentId,
      tier: "rules",
      injectConventions: true,
      createdAt: now.toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO workspaces (id, name, path, environment_id, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(ws.id, ws.name, ws.path, ws.environmentId, ws.tier, ws.createdAt);
    return ws;
  }

  // 首次启动登记启动目录为默认，并写持久化标记；之后（含删光所有 workspace）不再自动登记。
  ensureDefault(startDir: string): Workspace | null {
    const marked = this.db
      .prepare("SELECT 1 FROM meta WHERE key = 'default_workspace_registered'")
      .get();
    if (marked) return null;
    const mark = () =>
      this.db
        .prepare(
          "INSERT OR IGNORE INTO meta (key, value) VALUES ('default_workspace_registered', '1')",
        )
        .run();
    // 已有 workspace（迁移前的库）视为已登记过
    if (this.getDefault()) {
      mark();
      return null;
    }
    const dir = resolveDirectory(startDir);
    if (!dir.ok) return null;
    const ws = this.create(path.basename(dir.path) || dir.path, dir.path);
    if (ws) mark();
    return ws;
  }

  update(
    id: string,
    patch: { name?: string; tier?: Tier; injectConventions?: boolean },
  ): Workspace | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    this.db
      .prepare(
        "UPDATE workspaces SET name = ?, tier = ?, inject_conventions = ? WHERE id = ?",
      )
      .run(
        patch.name ?? cur.name,
        patch.tier ?? cur.tier,
        (patch.injectConventions ?? cur.injectConventions) ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  // 已落盘索引里引用该 workspace 的会话数；空 workspace_id 读作默认，所以计入默认 workspace。
  sessionCount(id: string): number {
    const isDefault = this.getDefault()?.id === id;
    const r = this.db
      .prepare(
        `SELECT count(*) AS n FROM sessions
         WHERE workspace_id = ? OR (? = 1 AND workspace_id IS NULL)`,
      )
      .get(id, isDefault ? 1 : 0) as { n: number };
    return r.n;
  }

  // 调用方先检查引用；这里只删。
  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id).changes > 0
    );
  }
}
