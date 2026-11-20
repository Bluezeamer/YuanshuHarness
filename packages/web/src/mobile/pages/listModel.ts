// 手机会话列表的展示模型：「需要你」区加上与桌面左轨同样的「分组 → 工作区 → 会话」。
// 分区、排序、映射的纯函数直接复用左轨的（features/workspace/sidebar/model），这里只加「需要你」的筛选。

import type { LibrarySession } from "../../api/sessionLibrary";
import type { WorkspaceGroup } from "../../api/workspaceGroups";
import type { Workspace } from "../../api/workspaces";
import {
  flatOrder,
  type Section,
  type Sess,
  sectionsOf,
  toWorkspace,
  type Ws,
} from "../../features/workspace/sidebar/model";

export interface Need {
  session: Sess;
  workspaceName: string;
  /** blocked = 有审批或提问在等；error = 出错了还没看 */
  reason: "blocked" | "error";
}

export interface ListModel {
  needs: Need[];
  /** 分组 → 工作区；每个工作区的会话已按左轨的顺序排平（置顶在前，fork 跟在父会话后） */
  sections: Section[];
}

/** 与服务端列表同一顺序：更新时间倒序，再按 id */
const byServerOrder = (a: LibrarySession, b: LibrarySession) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

/** 跨工作区的「需要你」：待处理排前，其次出错；「新结果」不进来。传进来的会话已去掉归档的 */
export function needsOf(workspaces: readonly Ws[]): Need[] {
  const rows = workspaces.flatMap((w) =>
    w.sessions.flatMap((s): Need[] => {
      if (s.status === "blocked")
        return [{ session: s, workspaceName: w.name, reason: "blocked" }];
      if (s.unread === "error")
        return [{ session: s, workspaceName: w.name, reason: "error" }];
      return [];
    }),
  );
  const rank = (n: Need) => (n.reason === "blocked" ? 0 : 1);
  const when = (n: Need) => n.session.updatedAt ?? "";
  return rows.sort(
    (a, b) => rank(a) - rank(b) || when(b).localeCompare(when(a)),
  );
}

export function buildListModel(
  workspaces: readonly Workspace[],
  groups: readonly WorkspaceGroup[],
  sessions: readonly LibrarySession[],
  now: number,
  hostLabel: (environmentId: string) => string,
): ListModel {
  const byWorkspace = new Map<string, LibrarySession[]>();
  for (const s of [...sessions].sort(byServerOrder)) {
    if (!s.workspaceId) continue;
    const list = byWorkspace.get(s.workspaceId) ?? [];
    list.push(s);
    byWorkspace.set(s.workspaceId, list);
  }
  const live = workspaces
    .filter((w) => !w.archived)
    .map((w) => {
      const ws = toWorkspace(w, byWorkspace.get(w.id) ?? [], now, hostLabel);
      return {
        ...ws,
        sessions: flatOrder(ws.sessions.filter((s) => !s.archived)),
      };
    });
  return {
    needs: needsOf(live),
    sections: sectionsOf(
      live,
      groups.map((g) => ({ id: g.id, name: g.name, tone: g.tone })),
    ),
  };
}
