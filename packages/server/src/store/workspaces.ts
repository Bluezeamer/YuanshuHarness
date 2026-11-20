import { uuidv7 } from "../id.js";
import {
  isReviewPolicyMode,
  POLICY_MAX,
  type WorkspaceReviewPolicy,
} from "../permission/review-policy.js";
import { isTier, type Tier } from "../permission/tier.js";
import type { Db } from "./db.js";

// 工作区：描述「在哪看」（名称、描述、分组、归档、目录清单、新会话默认配置、布局）。
export interface WorkspaceDefaults {
  // 稀疏：出现的键 = 覆盖了全局默认；没出现 = 跟随
  agentPresetId?: string;
  modePresetIds?: string[];
  model?: { provider: string; model: string; reasoning: string };
  permissionTier?: Tier;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  groupId: string | null;
  archived: boolean;
  /** 置顶：左轨里排在同一分组内其余工作区之前 */
  pinned: boolean;
  order: number;
  defaults: WorkspaceDefaults;
  /** 本工作区的审核判别准则；text 为空 = 跟随全局 */
  reviewPolicy: WorkspaceReviewPolicy;
  createdAt: string;
  updatedAt: string;
}

export const WORKSPACE_NAME_MAX = 60;
export const WORKSPACE_DESCRIPTION_MAX = 500;

const DEFAULTS_KEYS: readonly string[] = [
  "agentPresetId",
  "modePresetIds",
  "model",
  "permissionTier",
];

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v !== "";

const isModel = (v: unknown): v is WorkspaceDefaults["model"] => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.provider === "string" &&
    typeof m.model === "string" &&
    typeof m.reasoning === "string"
  );
};

// 完整校验一份稀疏默认配置（写入与读库都走它）：未知键一律不合法。
export function isWorkspaceDefaults(v: unknown): v is WorkspaceDefaults {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  if (Object.keys(d).some((k) => !DEFAULTS_KEYS.includes(k))) return false;
  if (d.agentPresetId !== undefined && !isNonEmptyString(d.agentPresetId))
    return false;
  if (d.permissionTier !== undefined && !isTier(d.permissionTier)) return false;
  if (
    d.modePresetIds !== undefined &&
    !(
      Array.isArray(d.modePresetIds) &&
      d.modePresetIds.length > 0 &&
      d.modePresetIds.every(isNonEmptyString)
    )
  )
    return false;
  return d.model === undefined || isModel(d.model);
}

type Row = {
  id: string;
  name: string;
  description: string;
  group_id: string | null;
  archived: number;
  pinned: number;
  sort_order: number;
  defaults: string;
  review_mode: string;
  review_text: string;
  created_at: string;
  updated_at: string;
};
const toWorkspace = (r: Row): Workspace => ({
  id: r.id,
  name: r.name,
  description: r.description,
  groupId: r.group_id,
  archived: r.archived === 1,
  pinned: r.pinned === 1,
  order: r.sort_order,
  defaults: JSON.parse(r.defaults) as WorkspaceDefaults,
  reviewPolicy: {
    mode: r.review_mode as WorkspaceReviewPolicy["mode"],
    text: r.review_text,
  },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= WORKSPACE_NAME_MAX ? name : null;
};

export const cleanDescription = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  return raw.length <= WORKSPACE_DESCRIPTION_MAX ? raw : null;
};

/** 工作区的审核设置：mode 合法、text 是字符串且 trim 后不超上限；返回 trim 后的值。 */
export const cleanReviewPolicy = (
  raw: unknown,
): WorkspaceReviewPolicy | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const p = raw as Record<string, unknown>;
  if (!isReviewPolicyMode(p.mode)) return null;
  if (typeof p.text !== "string") return null;
  const text = p.text.trim();
  if (text.length > POLICY_MAX) return null;
  return { mode: p.mode, text };
};

export class WorkspaceStore {
  constructor(private readonly db: Db) {}

  list(): Workspace[] {
    return (
      this.db
        .prepare("SELECT * FROM workspaces ORDER BY sort_order, id")
        .all() as Row[]
    ).map(toWorkspace);
  }

  get(id: string): Workspace | undefined {
    const r = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id) as Row | undefined;
    return r && toWorkspace(r);
  }

  // 新工作区排在最后。id 可由调用方预先指定（会话文件目录先于工作区落库时要用同一个 id）。
  create(input: {
    name: unknown;
    description?: unknown;
    defaults?: unknown;
    id?: string;
  }): Workspace {
    const name = cleanName(input.name);
    if (name === null) throw new Error("工作区名称不合法");
    const description =
      input.description === undefined
        ? ""
        : cleanDescription(input.description);
    if (description === null) throw new Error("工作区描述不合法");
    const defaults = input.defaults === undefined ? {} : input.defaults;
    if (!isWorkspaceDefaults(defaults)) throw new Error("默认配置不合法");
    const id = input.id ?? uuidv7();
    const now = new Date().toISOString();
    const next = (
      this.db
        .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS o FROM workspaces")
        .get() as { o: number }
    ).o;
    this.db
      .prepare(
        "INSERT INTO workspaces (id, name, description, group_id, archived, sort_order, defaults, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?)",
      )
      .run(id, name, description, next, JSON.stringify(defaults), now, now);
    return this.get(id) as Workspace;
  }

  update(
    id: string,
    patch: {
      name?: unknown;
      description?: unknown;
      defaults?: unknown;
      reviewPolicy?: unknown;
    },
  ): Workspace | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const name = patch.name === undefined ? cur.name : cleanName(patch.name);
    if (name === null) throw new Error("工作区名称不合法");
    const description =
      patch.description === undefined
        ? cur.description
        : cleanDescription(patch.description);
    if (description === null) throw new Error("工作区描述不合法");
    const defaults =
      patch.defaults === undefined ? cur.defaults : patch.defaults;
    if (!isWorkspaceDefaults(defaults)) throw new Error("默认配置不合法");
    const reviewPolicy =
      patch.reviewPolicy === undefined
        ? cur.reviewPolicy
        : cleanReviewPolicy(patch.reviewPolicy);
    if (reviewPolicy === null) throw new Error("审核设置不合法");
    this.db
      .prepare(
        "UPDATE workspaces SET name = ?, description = ?, defaults = ?, review_mode = ?, review_text = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        name,
        description,
        JSON.stringify(defaults),
        reviewPolicy.mode,
        reviewPolicy.text,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  setGroup(id: string, groupId: string | null): void {
    this.db
      .prepare("UPDATE workspaces SET group_id = ? WHERE id = ?")
      .run(groupId, id);
  }

  setArchived(id: string, archived: boolean): void {
    this.db
      .prepare("UPDATE workspaces SET archived = ? WHERE id = ?")
      .run(archived ? 1 : 0, id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE workspaces SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id);
  }

  setOrder(id: string, order: number): void {
    this.db
      .prepare("UPDATE workspaces SET sort_order = ? WHERE id = ?")
      .run(order, id);
  }

  // 按给定顺序重排：第 i 个工作区得到 order = i + 1。
  reorder(ids: string[]): void {
    const set = this.db.prepare(
      "UPDATE workspaces SET sort_order = ? WHERE id = ?",
    );
    this.db.transaction(() => {
      ids.forEach((id, i) => {
        set.run(i + 1, id);
      });
    })();
  }

  // 连带删除目录挂载、布局与变量启用关系；会话不删（处置见 C1-3）。
  remove(id: string): boolean {
    return this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM workspace_directories WHERE workspace_id = ?")
        .run(id);
      this.db
        .prepare("DELETE FROM workspace_layouts WHERE workspace_id = ?")
        .run(id);
      this.db
        .prepare("DELETE FROM workspace_variables WHERE workspace_id = ?")
        .run(id);
      return (
        this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id).changes >
        0
      );
    })();
  }
}
