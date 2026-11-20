import {
  type DragEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import { loadToken } from "../../../api/http";
import { createSessionWithConfig } from "../../../api/sessionConfig";
import type { LibrarySession } from "../../../api/sessionLibrary";
import {
  deleteSession,
  patchLibrarySession,
  refreshContext,
  sessionAction,
} from "../../../api/sessionLibrary";
import { workspaceRemovalPreview } from "../../../api/workspaces";
import { toast } from "../../../ui";
import { useChatHub } from "../../chat";
import { beginDrag, endDrag, useDrag } from "../layout/drag";
import { useLayoutState } from "../layoutContext";
import {
  useCurrentWorkspace,
  useLibraryState,
  useLibraryStore,
} from "../library/LibraryProvider";
import { errorText } from "../library/libraryStore";
import { focusedSid, viewingSids } from "../model/layoutOps";
import { useOpenSession } from "../openSession";
import type {
  Confirm,
  DialogSpec,
  GroupDialogSpec,
  MenuAt,
  NameDialogSpec,
  Selection,
  SidebarController,
  WsDropTarget,
} from "./controller";
import { RUNNING_ERROR } from "./dialogs";
import {
  aggregate,
  filterWorkspaces,
  flatOrder,
  type Sess,
  sectionsOf,
  toWorkspace,
  type Ws,
} from "./model";

/** 壳提供的几件外部事：创建面板、设置页、总览、环境 id 的展示名 */
export interface SidebarActions {
  openDialog(spec: DialogSpec): void;
  openSettings(): void;
  openOverview(): void;
  hostLabel(environmentId: string): string;
}

const flip = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
};

const modified = (ev: MouseEvent) => ev.metaKey || ev.ctrlKey;

/** 与服务端列表同一顺序：更新时间倒序，再按 id（推送增量按到达顺序追加，要自己排） */
const byServerOrder = (a: LibrarySession, b: LibrarySession) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** 真左轨的控制器：库数据 + 布局 store + 一组会话 / 工作区动作 */
export function useSidebarController(a: SidebarActions): SidebarController {
  const token = loadToken();
  const library = useLibraryStore();
  const hub = useChatHub();
  const current = useCurrentWorkspace();
  const openSession = useOpenSession();
  const dragging = useDrag();
  const workspaces = useLibraryState((s) => s.workspaces);
  const groups = useLibraryState((s) => s.groups);
  const sessions = useLibraryState((s) => s.sessions);
  const ready = useLibraryState((s) => s.ready);
  const doc = useLayoutState((s) => s.doc);
  const now = useNow(30_000);

  const [open, setOpen] = useState<Set<string>>(
    () => new Set(current.id ? [current.id] : []),
  );
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogSpec | null>(null);
  const [groupDialog, setGroupDialog] = useState<GroupDialogSpec | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // 多选删除工作区：逐个确认，这里排着还没问的
  const [removalQueue, setRemovalQueue] = useState<string[]>([]);
  // 工作区拖拽只在左轨内部，不进全局拖拽单例（那是给窗格落点用的）
  const [wsDrag, setWsDrag] = useState<{
    id: string;
    over: WsDropTarget | null;
  } | null>(null);

  // 当前工作区总是展开的（切过去、被别的入口选中时）
  useEffect(() => {
    if (current.id)
      setOpen((o) =>
        o.has(current.id as string) ? o : new Set(o).add(current.id as string),
      );
  }, [current.id]);

  const byWorkspace = useMemo(() => {
    const m = new Map<string, LibrarySession[]>();
    for (const s of [...sessions].sort(byServerOrder)) {
      if (!s.workspaceId) continue;
      const list = m.get(s.workspaceId) ?? [];
      list.push(s);
      m.set(s.workspaceId, list);
    }
    return m;
  }, [sessions]);

  const wsModels: Ws[] = useMemo(
    () =>
      workspaces.map((w) =>
        toWorkspace(w, byWorkspace.get(w.id) ?? [], now, a.hostLabel),
      ),
    [workspaces, byWorkspace, now, a.hostLabel],
  );
  const archivedIds = useMemo(
    () => new Set(workspaces.filter((w) => w.archived).map((w) => w.id)),
    [workspaces],
  );
  const liveModels = wsModels.filter((w) => !archivedIds.has(w.id));
  const groupModels = useMemo(
    () => groups.map((g) => ({ id: g.id, name: g.name, tone: g.tone })),
    [groups],
  );
  const groupClosed = useMemo(
    () => new Set(groups.filter((g) => g.collapsed).map((g) => g.id)),
    [groups],
  );
  const { list, shown } = filterWorkspaces(liveModels, query);
  const sections = sectionsOf(list, groupModels);
  const order = sections.flatMap((s) => s.list.map((w) => w.id));

  const viewing = useMemo(() => new Set(viewingSids(doc.windows)), [doc]);
  const currentSession = useMemo(() => focusedSid(doc.windows), [doc]);

  const sessionById = (id: string): Sess | undefined =>
    wsModels.flatMap((w) => w.sessions).find((s) => s.id === id);

  const fail = (e: unknown) => toast(errorText(e), { tone: "danger" });

  // ── 选择与打开 ──

  // ctrl / ⌘ 点：加进（或移出）选择。还没有选择时，当前打开的那个（普通点击打开的）也算选中，
  // 不然第一次 ctrl 点之后选择里没有「刚才点的那个」，不符合直觉。seed 是它的 id
  const toggleIn = (kind: Selection["kind"], id: string, seed: string | null) =>
    setSelection((p) =>
      p?.kind === kind
        ? {
            kind,
            ids: p.ids.includes(id)
              ? p.ids.filter((x) => x !== id)
              : [...p.ids, id],
          }
        : { kind, ids: seed !== null && seed !== id ? [seed, id] : [id] },
    );

  const pickSession = (id: string, ev: MouseEvent) => {
    if (modified(ev)) {
      toggleIn(
        "session",
        id,
        currentSession && sessionById(currentSession) ? currentSession : null,
      );
      setAnchor(id);
      return;
    }
    // 区间的起点：上次点的；没点过就是当前打开的
    const from = anchor ?? currentSession;
    if (ev.shiftKey && from) {
      const ws = wsModels.find((w) => w.sessions.some((s) => s.id === id));
      const flat = ws ? flatOrder(ws.sessions.filter((s) => !s.archived)) : [];
      const [i, j] = [from, id].map((x) => flat.findIndex((s) => s.id === x));
      if (i !== undefined && j !== undefined && i >= 0 && j >= 0) {
        setSelection({
          kind: "session",
          ids: flat.slice(Math.min(i, j), Math.max(i, j) + 1).map((s) => s.id),
        });
        return;
      }
    }
    setSelection(null);
    setAnchor(id);
    openSession(id);
  };

  const pickWorkspace = (id: string, ev: MouseEvent) => {
    if (modified(ev)) {
      toggleIn(
        "workspace",
        id,
        current.id && order.includes(current.id) ? current.id : null,
      );
      setAnchor(id);
      return;
    }
    const from = anchor ?? current.id;
    if (ev.shiftKey && from && order.includes(from)) {
      const [i, j] = [order.indexOf(from), order.indexOf(id)];
      setSelection({
        kind: "workspace",
        ids: order.slice(Math.min(i, j), Math.max(i, j) + 1),
      });
      return;
    }
    setSelection(null);
    setAnchor(id);
    setOpen((o) => new Set(o).add(id));
    current.select(id);
  };

  // ── 会话动作 ──

  const newSession = (workspaceId: string) => {
    void createSessionWithConfig(token, { workspaceId }).then(
      ({ id }) => openSession(id),
      fail,
    );
  };

  const sessionDialog = (mode: "from" | "edit", sessionId: string) => {
    const owner = wsModels.find((w) =>
      w.sessions.some((s) => s.id === sessionId),
    );
    if (owner)
      a.openDialog({ kind: "session", mode, workspaceId: owner.id, sessionId });
  };

  // 原地：同一个会话，重读约定文件、技能与 MCP 并重建前缀；不新建、不跳转。
  const refresh = (sid: string) => {
    void refreshContext(token, sid).then(
      () => toast("已刷新上下文：约定文件、技能与 MCP 已重新加载"),
      fail,
    );
  };

  const archiveSessions = (ids: readonly string[]) => {
    setSelection(null);
    void Promise.allSettled(
      ids.map((id) => sessionAction(token, id, "archive")),
    ).then((rs) => {
      const bad = rs.find((r) => r.status === "rejected");
      if (bad?.status === "rejected") fail(bad.reason);
    });
  };

  const restoreSessions = (ids: readonly string[]) => {
    setSelection(null);
    void Promise.allSettled(
      ids.map((id) => sessionAction(token, id, "unarchive")),
    ).then((rs) => {
      const bad = rs.find((r) => r.status === "rejected");
      if (bad?.status === "rejected") fail(bad.reason);
    });
  };

  const setSessionPinned = (id: string, pinned: boolean) => {
    void patchLibrarySession(token, id, { pinned }).catch(fail);
  };

  const setWorkspacePinned = (id: string, pinned: boolean) => {
    void library.patchWorkspace(id, { pinned });
  };

  const askRemoveSessions = (ids: readonly string[]) => {
    const all = wsModels.flatMap((w) => w.sessions);
    const list = all.filter((s) => ids.includes(s.id));
    const derived = all.filter(
      (s) => s.parent && ids.includes(s.parent) && !ids.includes(s.id),
    ).length;
    setConfirm({ kind: "session", list, derived });
    setConfirmError(null);
  };

  const askRemoveWorkspace = (id: string) => {
    const ws = wsModels.find((w) => w.id === id);
    if (!ws) return;
    setConfirm({ kind: "workspace", ws, preview: null });
    setConfirmError(null);
    void workspaceRemovalPreview(token, id).then(
      (preview) => {
        setConfirm((c) =>
          c?.kind === "workspace" && c.ws.id === id ? { ...c, preview } : c,
        );
        if (preview.running) setConfirmError(RUNNING_ERROR);
      },
      (e) => {
        setConfirm(null);
        fail(e);
      },
    );
  };

  const closeConfirm = () => {
    setConfirm(null);
    setRemovalQueue([]);
  };

  const doConfirm = () => {
    if (!confirm) return;
    setConfirmBusy(true);
    const done = () => setConfirmBusy(false);
    if (confirm.kind === "session") {
      const ids = confirm.list.map((s) => s.id);
      void Promise.allSettled(ids.map((id) => deleteSession(token, id))).then(
        (rs) => {
          done();
          for (const [i, r] of rs.entries())
            if (r.status === "fulfilled") hub.discardDraft(ids[i] as string);
          const bad = rs.find((r) => r.status === "rejected");
          if (bad?.status !== "rejected") {
            setSelection(null);
            setConfirm(null);
            return;
          }
          // 已经删掉的不再留在框里，重试只处理失败的那几条
          const failed = confirm.list.filter(
            (_, i) => rs[i]?.status === "rejected",
          );
          setConfirm({ ...confirm, list: failed });
          setConfirmError(errorText(bad.reason));
        },
      );
      return;
    }
    if (confirm.kind === "group") {
      void library.deleteGroup(confirm.group.id).then((ok) => {
        done();
        if (ok) setConfirm(null);
      });
      return;
    }
    const target = confirm.ws;
    void library.deleteWorkspace(target.id).then((ok) => {
      done();
      // 失败原因库 store 已经用提示说过了；框留着，用户可以重试或取消
      if (!ok) return;
      for (const s of target.sessions) hub.discardDraft(s.id);
      setSelection(null);
      const [next, ...rest] = removalQueue;
      setRemovalQueue(rest);
      if (next) askRemoveWorkspace(next);
      else setConfirm(null);
    });
  };

  // ── 命名 ──

  const renameSession = (id: string) => {
    const s = sessionById(id);
    if (!s) return;
    setNameDialog({
      title: "改名",
      label: "会话名称",
      initial: s.title,
      confirmLabel: "保存",
      maxLength: 48,
      onSubmit: (title) => {
        setNameDialog(null);
        void patchLibrarySession(token, id, { title }).catch(fail);
      },
    });
  };

  const renameWorkspace = (id: string) => {
    const w = wsModels.find((x) => x.id === id);
    if (!w) return;
    setNameDialog({
      title: "重命名工作区",
      label: "工作区名称",
      initial: w.name,
      confirmLabel: "保存",
      maxLength: 60,
      onSubmit: (name) => {
        setNameDialog(null);
        void library.patchWorkspace(id, { name });
      },
    });
  };

  const joinGroup = (ids: readonly string[], groupId: string | null) => {
    setSelection(null);
    void Promise.all(ids.map((id) => library.patchWorkspace(id, { groupId })));
  };

  const newGroup = (ids: readonly string[]) => {
    setNameDialog({
      title: "新建分组",
      label: "分组名称",
      initial: "",
      confirmLabel: "创建并加入",
      maxLength: 24,
      onSubmit: (name) => {
        setNameDialog(null);
        void library.createGroup({ name }).then((g) => {
          if (g) joinGroup(ids, g.id);
        });
      },
    });
  };

  const editGroup = (id: string) => {
    const g = groupModels.find((x) => x.id === id);
    if (!g) return;
    setGroupDialog({
      name: g.name,
      tone: g.tone,
      onSubmit: (name, tone) => {
        setGroupDialog(null);
        void library.patchGroup(id, { name, tone });
      },
    });
  };

  const askRemoveGroup = (id: string) => {
    const g = groupModels.find((x) => x.id === id);
    if (!g) return;
    const count = wsModels.filter((w) => w.group === id).length;
    setConfirm({ kind: "group", group: g, count });
    setConfirmError(null);
  };

  const archiveWorkspaces = (ids: readonly string[], archived: boolean) => {
    setSelection(null);
    void Promise.all(ids.map((id) => library.patchWorkspace(id, { archived })));
  };

  const dragWorkspace = (e: DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "workspace");
    setWsDrag({ id, over: null });
  };

  const dragOver = (over: WsDropTarget | null) =>
    setWsDrag((d) => {
      if (!d || JSON.stringify(d.over) === JSON.stringify(over)) return d;
      return { ...d, over };
    });

  // 落在分组上（含组尾的落点）= 放进该组并排到最后；落在另一个工作区上 = 插到它前面（跨组时顺带改成它的分组）。
  // 服务端的顺序是全局一份，所以重排时给出整份显示顺序
  const dropWorkspace = (t: WsDropTarget) => {
    const id = wsDrag?.id;
    setWsDrag(null);
    const me = liveModels.find((w) => w.id === id);
    if (!id || !me) return;
    const shown = sectionsOf(liveModels, groupModels).flatMap((s) =>
      s.list.map((w) => w.id),
    );
    const ids = shown.filter((x) => x !== id);
    if ("group" in t) {
      if (me.group !== t.group) joinGroup([id], t.group);
      const tail = ids.findLast(
        (x) => liveModels.find((w) => w.id === x)?.group === t.group,
      );
      // 组里没有别人，或它本来就在最后：顺序不用动
      if (
        tail === undefined ||
        (me.group === t.group && shown.indexOf(id) > shown.indexOf(tail))
      )
        return;
      ids.splice(ids.indexOf(tail) + 1, 0, id);
      void library.reorderWorkspaces(ids);
      return;
    }
    const target = liveModels.find((w) => w.id === t.before);
    if (!target || target.id === id) return;
    if (me.group !== target.group) joinGroup([id], target.group);
    ids.splice(ids.indexOf(target.id), 0, id);
    void library.reorderWorkspaces(ids);
  };

  return {
    workspaces: liveModels,
    sections,
    archivedWorkspaces: wsModels.filter((w) => archivedIds.has(w.id)),
    shown: (w) => shown.get(w.id) ?? w.sessions,
    aggOf: (w) => aggregate(w.sessions),
    loading: !ready,
    query,
    setQuery,
    currentWorkspace: current.id,
    currentSession,
    viewing,
    open,
    toggleOpen: (id) => setOpen((o) => flip(o, id)),
    archivedOpen,
    toggleArchived: (id) => setArchivedOpen((o) => flip(o, id)),
    groupClosed,
    toggleGroup: (id) => {
      void library.patchGroup(id, { collapsed: !groupClosed.has(id) });
    },
    selection,
    clearSelection: () => setSelection(null),
    menu,
    setMenu: (m) => {
      // 在选择之外的行上右键：原来的选择作废，菜单只管这一行
      if (m && !(selection?.kind === m.kind && selection.ids.includes(m.id)))
        setSelection(null);
      setMenu(m);
    },
    nameDialog,
    closeNameDialog: () => setNameDialog(null),
    groupDialog,
    closeGroupDialog: () => setGroupDialog(null),
    confirm,
    confirmError,
    confirmBusy,
    doConfirm,
    closeConfirm,
    drag: wsDrag
      ? { workspace: wsDrag.id, ...(wsDrag.over ? { over: wsDrag.over } : {}) }
      : dragging?.kind === "session"
        ? { session: dragging.sid }
        : undefined,
    pickSession,
    pinSession: (id) => openSession(id, true),
    dragSession: (e, id) => beginDrag(e, { kind: "session", sid: id }),
    dragEnd: () => {
      endDrag();
      setWsDrag(null);
    },
    dragWorkspace,
    dragOver,
    dropWorkspace,
    pickWorkspace,
    newWorkspace: () => a.openDialog({ kind: "workspace", mode: "create" }),
    openSettings: a.openSettings,
    openOverview: a.openOverview,
    newSession,
    newSessionWith: (workspaceId) =>
      a.openDialog({ kind: "session", mode: "create", workspaceId }),
    editWorkspace: (workspaceId) =>
      a.openDialog({ kind: "workspace", mode: "edit", workspaceId }),
    sessionSettings: (id) => sessionDialog("edit", id),
    newSessionFrom: (id) => sessionDialog("from", id),
    refreshContext: refresh,
    archiveSessions,
    restoreSessions,
    setSessionPinned,
    setWorkspacePinned,
    archiveWorkspaces,
    askRemoveSessions,
    askRemoveWorkspaces: (list) => {
      const [first, ...rest] = list;
      if (first === undefined) return;
      setRemovalQueue(rest);
      askRemoveWorkspace(first);
    },
    renameSession,
    renameWorkspace,
    joinGroup,
    newGroup,
    editGroup,
    askRemoveGroup,
    groups: groupModels,
  };
}
