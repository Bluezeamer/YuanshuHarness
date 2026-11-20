import { HttpError } from "../lib/http-error.js";
import { isObject } from "../lib/validate.js";
import type { WorkspaceReviewPolicy } from "../permission/review-policy.js";
import type { Directory, DirectoryStore } from "../store/directories.js";
import type { PromptPresetStore } from "../store/prompt-presets.js";
import { THINKING_LEVELS } from "../store/providers.js";
import type { WorkspaceDirectoryStore } from "../store/workspace-directories.js";
import { WORKSPACE_DIRECTORIES_MAX } from "../store/workspace-directories.js";
import type { WorkspaceGroupStore } from "../store/workspace-groups.js";
import type { WorkspaceLayoutStore } from "../store/workspace-layouts.js";
import {
  cleanDescription,
  cleanName,
  cleanReviewPolicy,
  isWorkspaceDefaults,
  WORKSPACE_NAME_MAX,
  type Workspace,
  type WorkspaceDefaults,
  type WorkspaceStore,
} from "../store/workspaces.js";
import type {
  DirectoryResolver,
  ResolvedDirectory,
} from "./directory-resolver.js";
import type { SessionInfo, SessionPool } from "./pool.js";

type WorkspaceErrorCode =
  | "bad_request"
  | "not_found"
  | "session_running"
  | "too_many_directories"
  | "duplicate_directory"
  | "unknown_group"
  | "revision_conflict";

const STATUS: Record<WorkspaceErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  session_running: 409,
  too_many_directories: 400,
  duplicate_directory: 400,
  unknown_group: 400,
  revision_conflict: 409,
};

export class WorkspaceError extends HttpError {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string = code,
    // 布局冲突时带上服务端当前值，REST 层据此回 409 + 当前值。
    readonly current?: unknown,
  ) {
    super(code, message, STATUS[code]);
  }
}

export interface WorkspaceDirectoryView {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  role: "local" | "remote";
}

export interface WorkspaceView {
  id: string;
  name: string;
  description: string;
  groupId: string | null;
  archived: boolean;
  pinned: boolean;
  order: number;
  defaults: WorkspaceDefaults;
  // 审核的判别准则：text 为空 = 跟随全局。
  reviewPolicy: WorkspaceReviewPolicy;
  // 第 0 个是主目录（local），其余是附加目录（remote）。
  directories: WorkspaceDirectoryView[];
  // 只数顶层会话，不含子代理会话。
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceServiceDeps {
  workspaces: WorkspaceStore;
  mounts: WorkspaceDirectoryStore;
  groups: WorkspaceGroupStore;
  layouts: WorkspaceLayoutStore;
  directories: DirectoryStore;
  pool: SessionPool;
  resolver: DirectoryResolver;
  presets: PromptPresetStore;
  // {provider, model} 是否指向一个能跑起来的模型；缺省不校验。
  modelCheck?: (provider: string, model: string) => boolean;
}

const ORDER_MAX = 2 ** 31 - 1;

const isOrder = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= ORDER_MAX;

const isRevision = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// 工作区只描述「在哪看」：目录清单、分组、归档、布局与新会话默认配置。
export class WorkspaceService {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  list(): WorkspaceView[] {
    const byWorkspace = this.sessionsByWorkspace();
    return this.deps.workspaces
      .list()
      .map((w) => this.view(w, byWorkspace.get(w.id) ?? []));
  }

  get(id: string): WorkspaceView | null {
    const w = this.deps.workspaces.get(id);
    if (!w) return null;
    return this.view(w, this.sessionsByWorkspace().get(w.id) ?? []);
  }

  // 池里的清单 = 索引行 + 尚在内存的会话（新建还没落盘的那种），按工作区分组。
  private sessionsByWorkspace(): Map<string, SessionInfo[]> {
    const out = new Map<string, SessionInfo[]>();
    for (const s of this.deps.pool.list()) {
      const id = this.deps.pool.workspaceIdOf(s.id);
      if (id === null) continue;
      const list = out.get(id) ?? [];
      list.push(s);
      out.set(id, list);
    }
    return out;
  }

  private view(w: Workspace, sessions: SessionInfo[]): WorkspaceView {
    const mounted = this.deps.mounts.get(w.id);
    const primaryId = mounted[0];
    const directories = mounted.flatMap((id) => {
      const d = this.deps.directories.get(id);
      if (!d) return [];
      return [
        {
          id: d.id,
          name: d.name,
          path: d.path,
          environmentId: d.environmentId,
          role: id === primaryId ? ("local" as const) : ("remote" as const),
        },
      ];
    });
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      groupId: w.groupId,
      archived: w.archived,
      pinned: w.pinned,
      order: w.order,
      defaults: w.defaults,
      reviewPolicy: w.reviewPolicy,
      directories,
      // 只数顶层会话，不含子代理会话。
      sessionCount: sessions.filter((s) => !this.deps.pool.isChild(s.id))
        .length,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }

  // 附加入参逐个解析成真实路径；primary 是已经解析过的第 0 个（主目录）。
  async resolveDirectories(
    inputs: unknown[],
    primary: ResolvedDirectory,
  ): Promise<ResolvedDirectory[]> {
    const resolved: ResolvedDirectory[] = [primary];
    for (const input of inputs)
      resolved.push(
        await this.deps.resolver.resolve(isObject(input) ? input : {}),
      );
    const keys = resolved.map((r) => `${r.environmentId}\0${r.path}`);
    if (new Set(keys).size !== keys.length)
      throw new WorkspaceError("duplicate_directory", "目录清单里有重复项");
    return resolved;
  }

  // 同一路径已登记就复用，没登记的登记进来。
  ensureDirectory(r: ResolvedDirectory): Directory {
    const existing = this.deps.directories.getByPath(r.path, r.environmentId);
    if (existing) return existing;
    // 同一批里两个同名的新目录在解析时都还没登记，名字要在登记这一刻才去重。
    const created = this.deps.directories.create(
      this.deps.directories.uniqueName(r.environmentId, r.name),
      r.path,
      new Date(),
      r.environmentId,
    );
    if (!created) throw new WorkspaceError("bad_request", "目录登记失败");
    return created;
  }

  // 主目录已是某个工作区的主目录时返回它。只查不建，避免校验失败时留下登记过的目录。
  private ownerOf(primary: ResolvedDirectory): WorkspaceView | null {
    const dir = this.deps.directories.getByPath(
      primary.path,
      primary.environmentId,
    );
    if (!dir) return null;
    const owner = this.deps.mounts.primaryOwner(dir.id);
    if (owner === null) return null;
    const view = this.get(owner);
    if (!view) throw new WorkspaceError("not_found", "工作区不存在");
    return view;
  }

  async create(input: {
    directories?: unknown;
    name?: unknown;
    description?: unknown;
    defaults?: unknown;
  }): Promise<{ workspace: WorkspaceView; created: boolean }> {
    const inputs = Array.isArray(input.directories) ? input.directories : [];
    if (inputs.length === 0)
      throw new WorkspaceError("bad_request", "至少需要一个目录");
    if (inputs.length > WORKSPACE_DIRECTORIES_MAX)
      throw new WorkspaceError(
        "too_many_directories",
        `一个工作区至多 ${WORKSPACE_DIRECTORIES_MAX} 个目录`,
      );
    const primary = await this.deps.resolver.resolve(
      isObject(inputs[0]) ? inputs[0] : {},
    );
    const existing = this.ownerOf(primary);
    if (existing) return { workspace: existing, created: false };
    const resolved = await this.resolveDirectories(inputs.slice(1), primary);
    // 名称缺省取主目录的显示名（已登记目录可能被改过名）。
    const name =
      input.name === undefined
        ? (
            this.deps.directories.getByPath(primary.path, primary.environmentId)
              ?.name ?? primary.name
          ).slice(0, WORKSPACE_NAME_MAX)
        : cleanName(input.name);
    if (name === null) throw new WorkspaceError("bad_request", "名称不合法");
    const description =
      input.description === undefined
        ? ""
        : cleanDescription(input.description);
    if (description === null)
      throw new WorkspaceError("bad_request", "描述不合法");
    const defaults = input.defaults === undefined ? {} : input.defaults;
    this.checkDefaults(defaults);
    // 从这里到写完挂载没有 await：先登记目录（失败就什么都没建），再查一次主目录归属——
    // 前面解析附加目录时让出过事件循环，别的创建可能已经抢先建了同一个主目录的工作区。
    const dirIds = resolved.map((r) => this.ensureDirectory(r).id);
    const raced = this.deps.mounts.primaryOwner(dirIds[0] as string);
    if (raced !== null)
      return { workspace: this.get(raced) as WorkspaceView, created: false };
    const workspace = this.deps.workspaces.create({
      name,
      description,
      defaults,
    });
    this.deps.mounts.set(workspace.id, dirIds);
    return {
      workspace: this.get(workspace.id) as WorkspaceView,
      created: true,
    };
  }

  // 默认配置的引用校验：预设与模型都必须在库里，否则 400。
  private checkDefaults(defaults: unknown): void {
    if (!isWorkspaceDefaults(defaults))
      throw new WorkspaceError("bad_request", "默认配置不合法");
    if (
      defaults.agentPresetId !== undefined &&
      !this.presetOk("agent", defaults.agentPresetId)
    )
      throw new WorkspaceError("bad_request", "Agent 预设不存在");
    for (const id of defaults.modePresetIds ?? [])
      if (!this.presetOk("mode", id))
        throw new WorkspaceError("bad_request", "模式预设不存在");
    if (
      defaults.model !== undefined &&
      (!(THINKING_LEVELS as readonly string[]).includes(
        defaults.model.reasoning,
      ) ||
        !this.modelOk(defaults.model))
    )
      throw new WorkspaceError("bad_request", "模型或思考强度不存在");
  }

  private presetOk(kind: "agent" | "mode", id: string): boolean {
    return this.deps.presets.get(id)?.kind === kind;
  }

  private modelOk(model: { provider: string; model: string }): boolean {
    return this.deps.modelCheck?.(model.provider, model.model) ?? true;
  }

  /** 建会话时套用的稀疏默认配置：引用的预设 / 模型已被删就当没覆盖，回退全局默认。 */
  defaultsFor(id: string): WorkspaceDefaults | null {
    const d = this.deps.workspaces.get(id)?.defaults;
    if (d === undefined) return null;
    const out: WorkspaceDefaults = {};
    if (
      d.agentPresetId !== undefined &&
      this.presetOk("agent", d.agentPresetId)
    )
      out.agentPresetId = d.agentPresetId;
    const modes = d.modePresetIds?.filter((m) => this.presetOk("mode", m));
    if (modes !== undefined && modes.length > 0) out.modePresetIds = modes;
    if (d.model !== undefined && this.modelOk(d.model)) out.model = d.model;
    if (d.permissionTier !== undefined) out.permissionTier = d.permissionTier;
    return out;
  }

  async update(
    id: string,
    patch: {
      name?: unknown;
      description?: unknown;
      defaults?: unknown;
      reviewPolicy?: unknown;
      groupId?: unknown;
      archived?: unknown;
      pinned?: unknown;
      order?: unknown;
    },
  ): Promise<WorkspaceView> {
    const cur = this.deps.workspaces.get(id);
    if (!cur) throw new WorkspaceError("not_found", "工作区不存在");
    const {
      name,
      description,
      defaults,
      reviewPolicy,
      groupId,
      archived,
      pinned,
      order,
    } = patch;
    if (
      [
        name,
        description,
        defaults,
        reviewPolicy,
        groupId,
        archived,
        pinned,
        order,
      ].every((v) => v === undefined)
    )
      throw new WorkspaceError("bad_request", "没有可修改的字段");
    const nextName = name === undefined ? cur.name : cleanName(name);
    if (nextName === null)
      throw new WorkspaceError("bad_request", "名称不合法");
    const nextDescription =
      description === undefined
        ? cur.description
        : cleanDescription(description);
    if (nextDescription === null)
      throw new WorkspaceError("bad_request", "描述不合法");
    if (defaults !== undefined) this.checkDefaults(defaults);
    if (reviewPolicy !== undefined && cleanReviewPolicy(reviewPolicy) === null)
      throw new WorkspaceError("bad_request", "审核设置不合法");
    if (
      groupId !== undefined &&
      groupId !== null &&
      (typeof groupId !== "string" || !this.deps.groups.get(groupId))
    )
      throw new WorkspaceError("unknown_group", "分组不存在");
    if (archived !== undefined && typeof archived !== "boolean")
      throw new WorkspaceError("bad_request", "archived 必须是布尔");
    if (pinned !== undefined && typeof pinned !== "boolean")
      throw new WorkspaceError("bad_request", "pinned 必须是布尔");
    if (order !== undefined && !isOrder(order))
      throw new WorkspaceError("bad_request", "order 必须是非负整数");
    // 工作区归档是纯显示属性，但有会话在跑时不允许（不动它下面的会话与布局）。
    if (archived === true && !cur.archived && this.hasRunningSession(id))
      throw new WorkspaceError("session_running", "工作区有会话正在运行");

    // 校验全部通过后才动库：任一非法都不产生部分修改。
    if (
      name !== undefined ||
      description !== undefined ||
      defaults !== undefined ||
      reviewPolicy !== undefined
    )
      this.deps.workspaces.update(id, {
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(defaults === undefined ? {} : { defaults }),
        ...(reviewPolicy === undefined ? {} : { reviewPolicy }),
      });
    if (groupId !== undefined)
      this.deps.workspaces.setGroup(id, groupId as string | null);
    if (archived !== undefined) this.deps.workspaces.setArchived(id, archived);
    if (pinned !== undefined) this.deps.workspaces.setPinned(id, pinned);
    if (order !== undefined) this.deps.workspaces.setOrder(id, order);
    const out = this.get(id);
    if (!out) throw new WorkspaceError("not_found", "工作区不存在");
    return out;
  }

  // 工作区里任何会话（含子代理会话）在忙：含刚 send、还没进入运行态的那一瞬，与 pool.remove 同一口径。
  // 归档与删除工作区共用这一个判断。
  hasRunningSession(workspaceId: string): boolean {
    return (this.sessionsByWorkspace().get(workspaceId) ?? []).some(
      (s) => this.deps.pool.get(s.id)?.busy === true,
    );
  }

  /** 按给定顺序重排：第 i 个工作区得到 order = i + 1；不存在的 id 忽略不报错。 */
  reorder(ids: string[]): void {
    const known = new Set(this.deps.workspaces.list().map((w) => w.id));
    this.deps.workspaces.reorder(ids.filter((id) => known.has(id)));
  }

  layout(id: string): { revision: number; document: unknown } {
    this.require(id);
    return this.deps.layouts.get(id);
  }

  putLayout(
    id: string,
    baseRevision: unknown,
    document: unknown,
  ): { revision: number } {
    this.require(id);
    if (!isRevision(baseRevision))
      throw new WorkspaceError("bad_request", "baseRevision 必须是非负整数");
    if (!isObject(document))
      throw new WorkspaceError("bad_request", "document 必须是对象");
    const r = this.deps.layouts.put(id, baseRevision, document);
    if (!r.ok)
      throw new WorkspaceError("revision_conflict", "布局已被改动", r.current);
    return { revision: r.revision };
  }

  private require(id: string): void {
    if (!this.deps.workspaces.get(id))
      throw new WorkspaceError("not_found", "工作区不存在");
  }
}
