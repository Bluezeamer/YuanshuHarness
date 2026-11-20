import type { SessionStore } from "../store/sessions.js";
import type { WorkspaceDirectoryStore } from "../store/workspace-directories.js";
import {
  WORKSPACE_NAME_MAX,
  type WorkspaceStore,
} from "../store/workspaces.js";

// 工作区与会话的绑定：主目录决定工作区身份，会话记录自己属于哪个工作区。
export class WorkspaceBinding {
  constructor(
    private readonly deps: {
      workspaces: WorkspaceStore;
      mounts: WorkspaceDirectoryStore;
      sessions: SessionStore;
    },
  ) {}

  /** 主目录已是某个工作区的主目录就返回那个工作区；否则新建（名称取主目录名，超过 WORKSPACE_NAME_MAX 就截断）并把 roster 作为它的目录清单。 */
  ensureFor(
    primary: { id: string; name: string },
    roster: readonly string[],
    // 新建时用它作 id；工作区已存在时忽略。
    id?: string,
  ): string {
    const owner = this.deps.mounts.primaryOwner(primary.id);
    if (owner !== null) return owner;
    const created = this.deps.workspaces.create({
      name: primary.name.slice(0, WORKSPACE_NAME_MAX),
      ...(id === undefined ? {} : { id }),
    });
    this.deps.mounts.set(created.id, roster);
    return created.id;
  }

  /** 主目录属于哪个工作区；没有时 null。 */
  ownerOf(directoryId: string): string | null {
    return this.deps.mounts.primaryOwner(directoryId);
  }

  /** 工作区的目录清单（第 0 个是主目录）。 */
  directoryIds(workspaceId: string): string[] {
    return this.deps.mounts.get(workspaceId);
  }

  /** 会话所属的工作区；索引里没有（旧行 / 对账补建的行）返回 null。 */
  workspaceIdOf(sessionId: string): string | null {
    return this.deps.sessions.get(sessionId)?.workspaceId ?? null;
  }

  /** 该工作区下所有会话的 id（含子代理会话）。 */
  sessionIds(workspaceId: string): string[] {
    return this.deps.sessions.listByWorkspace(workspaceId).map((r) => r.id);
  }
}
