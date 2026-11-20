import type { MenuItem } from "../../../ui";
import type { SidebarController } from "./controller";
import type { Group, Sess, Ws } from "./model";

/**
 * 这一行在多选之中时，菜单是对整个选择的批量操作（归档 / 删除就是批量归档 / 批量删除，不是只动被点的这一行）；
 * 不在、或只选了一行，返回 null，走单行的菜单。
 */
const batchIds = (
  c: SidebarController,
  kind: "session" | "workspace",
  id: string,
): readonly string[] | null => {
  const sel = c.selection;
  return sel?.kind === kind && sel.ids.length > 1 && sel.ids.includes(id)
    ? sel.ids
    : null;
};

// 多个会话：能做的只有归档（没归档的）、恢复（已归档的）、删除；刷新、改名、设置这些只对一个会话有意义
function sessionBatchItems(
  ids: readonly string[],
  c: SidebarController,
): MenuItem[] {
  const picked = [...c.workspaces, ...c.archivedWorkspaces]
    .flatMap((w) => w.sessions)
    .filter((s) => ids.includes(s.id));
  const live = picked.filter((s) => !s.archived);
  const archived = picked.filter((s) => s.archived);
  const items: MenuItem[] = [];
  if (live.length > 0)
    items.push({
      id: "archive",
      label: `归档 ${live.length} 个会话`,
      onSelect: () => c.archiveSessions(live.map((s) => s.id)),
    });
  if (archived.length > 0)
    items.push({
      id: "restore",
      label: `恢复 ${archived.length} 个会话`,
      onSelect: () => c.restoreSessions(archived.map((s) => s.id)),
    });
  items.push({
    id: "remove",
    label: `删除 ${picked.length} 个会话…`,
    tone: "danger",
    separatorBefore: items.length > 0,
    onSelect: () => c.askRemoveSessions(picked.map((s) => s.id)),
  });
  return items;
}

// 多个工作区：分组、归档（没归档的）、恢复（已归档的）、删除
function workspaceBatchItems(
  ids: readonly string[],
  c: SidebarController,
): MenuItem[] {
  const archivedIds = new Set(c.archivedWorkspaces.map((w) => w.id));
  const picked = [...c.workspaces, ...c.archivedWorkspaces].filter((w) =>
    ids.includes(w.id),
  );
  const pickedIds = picked.map((w) => w.id);
  const live = picked.filter((w) => !archivedIds.has(w.id));
  const archived = picked.filter((w) => archivedIds.has(w.id));
  const groups: MenuItem[] = c.groups.map((g, i) => ({
    id: `join-${g.id}`,
    label: `移入分组「${g.name}」`,
    disabled: picked.every((w) => w.group === g.id),
    separatorBefore: i === 0,
    onSelect: () => c.joinGroup(pickedIds, g.id),
  }));
  const items: MenuItem[] = [
    ...groups,
    {
      id: "newgroup",
      label: "新建分组并移入…",
      onSelect: () => c.newGroup(pickedIds),
    },
  ];
  if (picked.some((w) => w.group !== null))
    items.push({
      id: "ungroup",
      label: "移出分组",
      onSelect: () => c.joinGroup(pickedIds, null),
    });
  if (live.length > 0)
    items.push({
      id: "archive",
      label: `归档 ${live.length} 个工作区`,
      hint: "只是不显示",
      separatorBefore: true,
      onSelect: () =>
        c.archiveWorkspaces(
          live.map((w) => w.id),
          true,
        ),
    });
  if (archived.length > 0)
    items.push({
      id: "restore",
      label: `恢复 ${archived.length} 个工作区`,
      separatorBefore: live.length === 0,
      onSelect: () =>
        c.archiveWorkspaces(
          archived.map((w) => w.id),
          false,
        ),
    });
  items.push({
    id: "remove",
    label: `删除 ${picked.length} 个工作区…`,
    tone: "danger",
    onSelect: () => c.askRemoveWorkspaces(pickedIds),
  });
  return items;
}

// 会话行的菜单（右键与行内「…」同一份）。
export function sessionItems(s: Sess, c: SidebarController): MenuItem[] {
  const batch = batchIds(c, "session", s.id);
  if (batch) return sessionBatchItems(batch, c);
  return [
    {
      id: "refresh",
      label: "刷新上下文",
      hint: "重读约定、技能与 MCP · 缓存失效",
      disabled: s.archived === true,
      onSelect: () => c.refreshContext(s.id),
    },
    {
      id: "from",
      label: "以此配置新建…",
      disabled: s.archived === true,
      onSelect: () => c.newSessionFrom(s.id),
    },
    {
      id: "settings",
      label: "会话设置…",
      disabled: s.archived === true,
      onSelect: () => c.sessionSettings(s.id),
    },
    {
      id: "pin",
      label: s.pinned ? "取消置顶" : "置顶",
      disabled: s.archived === true,
      onSelect: () => c.setSessionPinned(s.id, !s.pinned),
    },
    { id: "rename", label: "改名", onSelect: () => c.renameSession(s.id) },
    s.archived
      ? {
          id: "restore",
          label: "恢复",
          separatorBefore: true,
          onSelect: () => c.restoreSessions([s.id]),
        }
      : {
          id: "archive",
          label: "归档",
          separatorBefore: true,
          onSelect: () => c.archiveSessions([s.id]),
        },
    {
      id: "remove",
      label: "删除…",
      tone: "danger",
      onSelect: () => c.askRemoveSessions([s.id]),
    },
  ];
}

// 分组头的菜单：编辑（名称与颜色）、解散。
export function groupItems(g: Group, c: SidebarController): MenuItem[] {
  return [
    { id: "edit", label: "编辑分组…", onSelect: () => c.editGroup(g.id) },
    {
      id: "dissolve",
      label: "解散分组…",
      hint: "工作区不动",
      tone: "danger",
      separatorBefore: true,
      onSelect: () => c.askRemoveGroup(g.id),
    },
  ];
}

// 工作区的菜单：新对话、改名、分组（逐个分组列出）、归档、删除；多选时是批量版（见 batchIds）。
export function workspaceItems(
  ws: Ws,
  c: SidebarController,
  archived: boolean,
): MenuItem[] {
  const batch = batchIds(c, "workspace", ws.id);
  if (batch) return workspaceBatchItems(batch, c);
  const groups: MenuItem[] = c.groups.map((g, i) => ({
    id: `join-${g.id}`,
    label: `移入分组「${g.name}」`,
    disabled: ws.group === g.id,
    separatorBefore: i === 0,
    onSelect: () => c.joinGroup([ws.id], g.id),
  }));
  return [
    {
      id: "new",
      label: "新对话",
      disabled: archived,
      onSelect: () => c.newSession(ws.id),
    },
    {
      id: "newwith",
      label: "新对话（带配置）…",
      disabled: archived,
      onSelect: () => c.newSessionWith(ws.id),
    },
    {
      id: "edit",
      label: "编辑工作区…",
      onSelect: () => c.editWorkspace(ws.id),
    },
    { id: "rename", label: "重命名", onSelect: () => c.renameWorkspace(ws.id) },
    {
      id: "pin",
      label: ws.pinned ? "取消置顶" : "置顶",
      disabled: archived,
      onSelect: () => c.setWorkspacePinned(ws.id, !ws.pinned),
    },
    ...groups,
    {
      id: "newgroup",
      label: "新建分组并移入…",
      separatorBefore: groups.length === 0,
      onSelect: () => c.newGroup([ws.id]),
    },
    ...(ws.group === null
      ? []
      : [
          {
            id: "ungroup",
            label: "移出分组",
            onSelect: () => c.joinGroup([ws.id], null),
          },
        ]),
    archived
      ? {
          id: "restore",
          label: "恢复工作区",
          separatorBefore: true,
          onSelect: () => c.archiveWorkspaces([ws.id], false),
        }
      : {
          id: "archive",
          label: "归档工作区",
          hint: "只是不显示",
          separatorBefore: true,
          onSelect: () => c.archiveWorkspaces([ws.id], true),
        },
    {
      id: "remove",
      label: "删除工作区…",
      tone: "danger",
      onSelect: () => c.askRemoveWorkspaces([ws.id]),
    },
  ];
}
