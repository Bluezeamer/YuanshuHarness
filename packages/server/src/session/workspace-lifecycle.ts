import { rmdirSync } from "node:fs";
import { HttpError } from "../lib/http-error.js";
import { isObject } from "../lib/validate.js";
import type { Directory, DirectoryStore } from "../store/directories.js";
import type { HookStore } from "../store/hooks.js";
import type { RuleStore } from "../store/rules.js";
import { type SessionStore, sessionDirFor } from "../store/sessions.js";
import {
  WORKSPACE_DIRECTORIES_MAX,
  type WorkspaceDirectoryStore,
} from "../store/workspace-directories.js";
import type { WorkspaceStore } from "../store/workspaces.js";
import type { TerminalManager } from "../terminal/manager.js";
import type {
  DirectoryResolver,
  ResolvedDirectory,
} from "./directory-resolver.js";
import type { SessionPool } from "./pool.js";
import {
  WorkspaceError,
  type WorkspaceService,
  type WorkspaceView,
} from "./workspaces.js";

type WorkspaceLifecycleErrorCode =
  | "not_found"
  | "session_running"
  | "local_immutable"
  | "too_many_directories"
  | "duplicate_directory"
  | "bad_request";

const STATUS: Record<WorkspaceLifecycleErrorCode, number> = {
  not_found: 404,
  session_running: 409,
  local_immutable: 400,
  too_many_directories: 400,
  duplicate_directory: 400,
  bad_request: 400,
};

export class WorkspaceLifecycleError extends HttpError {
  constructor(
    readonly code: WorkspaceLifecycleErrorCode,
    message: string = code,
  ) {
    super(code, message, STATUS[code]);
  }
}

/** 工作区挂载的一个目录，连同删除时受影响的条数（被保留的目录也给，供界面展示）。 */
export interface DirectoryImpact {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  /** 没有别的工作区引用，会随之删除。 */
  removed: boolean;
  rules: number;
  hooks: number;
}

export interface RemovalPreview {
  /** 有会话在运行，此时删除会被拒。 */
  running: boolean;
  /** 会随之删除的顶层会话数（含已归档，不含子代理会话）。 */
  sessions: number;
  terminals: number;
  directories: DirectoryImpact[];
}

export interface DirectoryPreview {
  added: { environmentId: string; path: string; name: string }[];
  removed: DirectoryImpact[];
}

export interface WorkspaceLifecycleDeps {
  service: WorkspaceService;
  workspaces: WorkspaceStore;
  mounts: WorkspaceDirectoryStore;
  directories: DirectoryStore;
  rules: RuleStore;
  hooks: HookStore;
  sessions: SessionStore;
  pool: SessionPool;
  terminals: TerminalManager;
  /** 删工作区时清掉它的浏览器页面与上下文；缺省则没有浏览器。 */
  browser?: { forgetWorkspace(workspaceKey: string): Promise<void> };
  /** 删工作区时清掉它那块附件区（按工作区存放）；缺省则不清。 */
  attachments?: { removeOwner(ownerId: string): Promise<void> };
  resolver: DirectoryResolver;
  /** 数据根；会话文件在它下面按工作区一个子目录。 */
  sessionRoot: string;
}

// 工作区的收尾动作：删除、改目录挂载、删除前的影响预览。
export class WorkspaceLifecycle {
  constructor(private readonly deps: WorkspaceLifecycleDeps) {}

  removalPreview(id: string): RemovalPreview {
    this.require(id);
    return {
      running: this.deps.service.hasRunningSession(id),
      sessions: this.deps.pool
        .list()
        .filter(
          (s) =>
            this.deps.pool.workspaceIdOf(s.id) === id &&
            !this.deps.pool.isChild(s.id),
        ).length,
      terminals: this.deps.terminals
        .list()
        .filter((t) => t.info.workspaceId === id).length,
      directories: this.mountsOf(id).map((d) => this.impact(d, id)),
    };
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    if (this.deps.service.hasRunningSession(id))
      throw new WorkspaceLifecycleError(
        "session_running",
        "工作区有会话正在运行",
      );
    const mounted = this.mountsOf(id);
    this.deps.terminals.destroyWorkspace(id);
    // 中途失败不回滚：已删的留着，工作区行还在，用户重试即可。
    for (const sessionId of this.sessionIds(id))
      if ((await this.deps.pool.remove(sessionId)) === "running")
        throw new WorkspaceLifecycleError(
          "session_running",
          "工作区有会话正在运行",
        );
    await this.deps.browser?.forgetWorkspace(id);
    await this.deps.attachments?.removeOwner(id).catch(() => {});
    this.deps.workspaces.remove(id);
    this.prune(mounted);
    this.rmdirIfEmpty(id);
  }

  async setDirectories(
    id: string,
    input: { directories?: unknown; dryRun?: unknown },
  ): Promise<WorkspaceView | DirectoryPreview> {
    this.require(id);
    const before = this.mountsOf(id);
    const inputs = Array.isArray(input.directories) ? input.directories : [];
    if (inputs.length === 0)
      throw new WorkspaceLifecycleError("bad_request", "至少需要一个目录");
    if (inputs.length > WORKSPACE_DIRECTORIES_MAX)
      throw new WorkspaceLifecycleError(
        "too_many_directories",
        `一个工作区至多 ${WORKSPACE_DIRECTORIES_MAX} 个目录`,
      );
    const primary = await this.deps.resolver.resolve(
      isObject(inputs[0]) ? inputs[0] : {},
    );
    // 主目录不可改：要换主目录就新建工作区。
    const id0 = before[0]?.id;
    const current = this.deps.directories.getByPath(
      primary.path,
      primary.environmentId,
    );
    if (id0 === undefined || current === undefined || current.id !== id0)
      throw new WorkspaceLifecycleError(
        "local_immutable",
        "不能改工作区的主目录",
      );
    const resolved = await this.resolveRoster(inputs.slice(1), primary);

    if (input.dryRun === true) {
      // 只算不写：resolved 里没挂上的就是新增，原来挂着又不在里的就是移除。
      const registered = resolved.map((r) =>
        this.deps.directories.getByPath(r.path, r.environmentId),
      );
      const kept = registered.flatMap((d) =>
        d && before.some((b) => b.id === d.id) ? [d.id] : [],
      );
      return {
        added: resolved.flatMap((r, i) => {
          const d = registered[i];
          return before.some((b) => b.id === d?.id)
            ? []
            : [
                {
                  environmentId: r.environmentId,
                  path: r.path,
                  name: d?.name ?? r.name,
                },
              ];
        }),
        removed: before
          .filter((d) => d.id !== id0 && !kept.includes(d.id))
          .map((d) => this.impact(d, id)),
      };
    }

    // 校验都过了才动库：先登记目录（已登记的就复用），再整份替换挂载。
    const ids = resolved.map((r) => this.deps.service.ensureDirectory(r).id);
    const roster = [id0 as string, ...ids];
    await this.deps.pool.setWorkspaceDirectories(id, roster);
    // 会话都挪回主目录之后再判目录存亡。
    this.prune(before.filter((d) => !roster.includes(d.id)));
    const view = this.deps.service.get(id);
    if (!view) throw new WorkspaceLifecycleError("not_found", "工作区不存在");
    return view;
  }

  private require(id: string): void {
    if (!this.deps.workspaces.get(id))
      throw new WorkspaceLifecycleError("not_found", "工作区不存在");
  }

  private mountsOf(workspaceId: string): Directory[] {
    return this.deps.mounts.get(workspaceId).flatMap((id) => {
      const d = this.deps.directories.get(id);
      return d ? [d] : [];
    });
  }

  // 附加入参的解析（含与主目录的重复判断）；错误类型换成这个模块的。
  private async resolveRoster(
    inputs: unknown[],
    primary: ResolvedDirectory,
  ): Promise<ResolvedDirectory[]> {
    try {
      return (
        await this.deps.service.resolveDirectories(inputs, primary)
      ).slice(1);
    } catch (err) {
      if (err instanceof WorkspaceError)
        throw new WorkspaceLifecycleError(
          err.code as WorkspaceLifecycleErrorCode,
          err.message,
        );
      throw err;
    }
  }

  /**
   * 该工作区的全部会话（含子代理会话与 fork）。子会话排在前面：删父会话会带走协作区与团队，
   * 父行还在时删子会话，各自的清理才都能照常做完。
   */
  private sessionIds(workspaceId: string): string[] {
    const ids = new Set(
      this.deps.sessions.listByWorkspace(workspaceId).map((r) => r.id),
    );
    for (const s of this.deps.pool.list())
      if (this.deps.pool.workspaceIdOf(s.id) === workspaceId) ids.add(s.id);
    return [...ids].sort(
      (a, b) =>
        Number(this.deps.pool.isSubagent(b)) -
        Number(this.deps.pool.isSubagent(a)),
    );
  }

  // 目录随引用存亡：没人挂（directoryInUse 已含工作区挂载计数）、也没有会话还在用它才删；
  // 磁盘上的文件（含项目 AGENTS.md）不动。调用时本工作区的挂载已经清掉。
  private prune(dropped: readonly Directory[]): void {
    for (const d of dropped)
      if (!this.deps.pool.directoryInUse(d.id))
        this.deps.directories.remove(d.id);
  }

  private rmdirIfEmpty(workspaceId: string): void {
    try {
      rmdirSync(sessionDirFor(this.deps.sessionRoot, workspaceId));
    } catch {
      // 目录不存在，或里面还有别的东西：留着。
    }
  }

  private impact(d: Directory, workspaceId: string): DirectoryImpact {
    return {
      id: d.id,
      name: d.name,
      path: d.path,
      environmentId: d.environmentId,
      removed: this.removable(d, workspaceId),
      rules: this.deps.rules.list(d.id).length,
      hooks: this.deps.hooks.list().filter((h) => h.directoryId === d.id)
        .length,
    };
  }

  // 预览用：与 prune 同一个结论，但此时本工作区还挂着它，所以排除本工作区再判（没有别的工作区挂它，也没有别的工作区的会话待在里面）。
  private removable(d: Directory, workspaceId: string): boolean {
    if (this.deps.mounts.workspacesOf(d.id).some((w) => w !== workspaceId))
      return false;
    return !this.deps.pool
      .list()
      .some(
        (s) =>
          s.directoryId === d.id &&
          this.deps.pool.workspaceIdOf(s.id) !== workspaceId,
      );
  }
}
