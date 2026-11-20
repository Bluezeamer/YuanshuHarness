import { type MouseEvent, useMemo, useState } from "react";
import {
  ARCHIVED_WORKSPACES,
  type Confirm,
  type MenuAt,
  type Selection,
  type SidebarController,
} from "../../workspace/sidebar/controller";
import { RUNNING_ERROR } from "../../workspace/sidebar/dialogs";
import {
  aggregate,
  filterWorkspaces,
  flatOrder,
  type Group,
  type Sess,
  sectionsOf,
  type Ws,
} from "../../workspace/sidebar/model";
import { GROUPS, previewOf, WORKSPACES } from "./data";

export type Demo =
  | "normal"
  | "sel-session"
  | "sel-ws"
  | "drag-session"
  | "drag-ws"
  | "mini"
  | "empty";

const flip = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
};
const add = (set: ReadonlySet<string>, ...ids: string[]): Set<string> =>
  new Set([...set, ...ids]);
const without = (set: ReadonlySet<string>, ids: readonly string[]) =>
  new Set([...set].filter((x) => !ids.includes(x)));

const modified = (ev: MouseEvent) => ev.metaKey || ev.ctrlKey;

// 样张用的控制器：静态数据 + 本页内存里的状态，删除与归档只改内存。
export function useDemoRail(
  demo: Demo,
  cur: {
    current: string;
    pinned: readonly string[];
    onCurrent(id: string): void;
    onPin(id: string): void;
  },
): SidebarController {
  const none = demo === "sel-ws" || demo === "drag-ws";
  const [open, setOpen] = useState(
    () => new Set(none ? [] : ["w-harness", "w-gpu"]),
  );
  const [wsCurrent, setWsCurrent] = useState("w-harness");
  const [selection, setSelection] = useState<Selection | null>(() =>
    demo === "sel-session"
      ? { kind: "session", ids: ["s-perm", "s-biome", "s-design"] }
      : demo === "sel-ws"
        ? { kind: "workspace", ids: ["w-docs", "w-27b"] }
        : null,
  );
  const [anchor, setAnchor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [read, setRead] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [archivedSessions, setArchivedSessions] = useState(
    () =>
      new Set(
        WORKSPACES.flatMap((w) =>
          w.sessions.filter((s) => s.archived).map((s) => s.id),
        ),
      ),
  );
  const [archivedWs, setArchivedWs] = useState<Set<string>>(new Set());
  const [groupOf, setGroupOf] = useState<Record<string, string | null>>({});
  const [groups, setGroups] = useState<Group[]>(GROUPS);
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(new Set());
  const [groupClosed, setGroupClosed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const workspaces: Ws[] = useMemo(
    () =>
      demo === "empty"
        ? []
        : WORKSPACES.filter((w) => !gone.has(w.id)).map((w) => ({
            ...w,
            group: w.id in groupOf ? (groupOf[w.id] ?? null) : w.group,
            sessions: w.sessions
              .filter((s) => !gone.has(s.id))
              .map(({ unread, ...s }) => ({
                ...s,
                ...(unread && !read.has(s.id) ? { unread } : {}),
                archived: archivedSessions.has(s.id),
              })),
          })),
    [demo, gone, read, archivedSessions, groupOf],
  );

  const live = workspaces.filter((w) => !archivedWs.has(w.id));
  const { list, shown } = filterWorkspaces(live, query);
  const sections = sectionsOf(list, groups);
  const order = sections.flatMap((s) => s.list.map((w) => w.id));

  const wsOfSession = (id: string) =>
    workspaces.find((w) => w.sessions.some((s) => s.id === id));
  const toggleIn = (kind: Selection["kind"], id: string) =>
    setSelection((p) =>
      p?.kind === kind
        ? {
            kind,
            ids: p.ids.includes(id)
              ? p.ids.filter((x) => x !== id)
              : [...p.ids, id],
          }
        : { kind, ids: [id] },
    );

  const pickSession = (id: string, ev: MouseEvent) => {
    const ws = wsOfSession(id);
    if (modified(ev)) {
      toggleIn("session", id);
      setAnchor(id);
      return;
    }
    if (ev.shiftKey && ws && anchor) {
      const flat = flatOrder(ws.sessions.filter((s) => !s.archived));
      const [a, b] = [anchor, id].map((x) => flat.findIndex((s) => s.id === x));
      if (a !== undefined && b !== undefined && a >= 0 && b >= 0) {
        setSelection({
          kind: "session",
          ids: flat.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id),
        });
        return;
      }
    }
    setSelection(null);
    setAnchor(id);
    setRead((c) => add(c, id));
    setWsCurrent(ws?.id ?? wsCurrent);
    cur.onCurrent(id);
  };

  const pickWorkspace = (id: string, ev: MouseEvent) => {
    if (modified(ev)) {
      toggleIn("workspace", id);
      setAnchor(id);
      return;
    }
    if (ev.shiftKey && anchor && order.includes(anchor)) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(id)];
      setSelection({
        kind: "workspace",
        ids: order.slice(Math.min(a, b), Math.max(a, b) + 1),
      });
      return;
    }
    setSelection(null);
    setAnchor(id);
    setWsCurrent(id);
    setOpen((o) => add(o, id));
  };

  const askRemoveWorkspace = (id: string) => {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;
    const preview = previewOf(ws);
    setConfirm({ kind: "workspace", ws, preview });
    setConfirmError(preview.running ? RUNNING_ERROR : null);
  };

  const askRemoveSessions = (ids: readonly string[]) => {
    const all = workspaces.flatMap((w) => w.sessions);
    const list: Sess[] = all.filter((s) => ids.includes(s.id));
    const derived = all.filter(
      (s) => s.parent && ids.includes(s.parent) && !ids.includes(s.id),
    ).length;
    setConfirm({ kind: "session", list, derived });
    setConfirmError(null);
  };

  const doConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === "workspace") {
      if (confirm.preview?.running) return setConfirmError(RUNNING_ERROR);
      setGone((g) => add(g, confirm.ws.id));
    } else if (confirm.kind === "session")
      setGone((g) => add(g, ...confirm.list.map((s) => s.id)));
    setSelection(null);
    setConfirm(null);
  };

  const noop = () => {};
  const flyOpen = demo === "mini" ? "w-27b" : null;

  return {
    workspaces,
    sections,
    archivedWorkspaces: workspaces.filter((w) => archivedWs.has(w.id)),
    shown: (w) => shown.get(w.id) ?? w.sessions,
    aggOf: (w) => aggregate(w.sessions),
    loading: false,
    query,
    setQuery,
    currentWorkspace: wsCurrent,
    currentSession: cur.current,
    viewing: new Set(cur.pinned),
    open,
    toggleOpen: (id) => setOpen((o) => flip(o, id)),
    archivedOpen,
    toggleArchived: (id) => setArchivedOpen((o) => flip(o, id)),
    groupClosed,
    toggleGroup: (id) => setGroupClosed((o) => flip(o, id)),
    selection,
    clearSelection: () => setSelection(null),
    menu,
    setMenu,
    nameDialog: null,
    groupDialog: null,
    closeGroupDialog: noop,
    closeNameDialog: noop,
    confirm,
    confirmError,
    confirmBusy: false,
    doConfirm,
    closeConfirm: () => setConfirm(null),
    drag:
      demo === "drag-session"
        ? { session: "s-biome" }
        : demo === "drag-ws"
          ? { workspace: "w-gpu", over: { group: "g-main" } }
          : undefined,
    pickSession,
    pinSession: (id) => {
      setRead((c) => add(c, id));
      cur.onPin(id);
    },
    dragSession: noop,
    dragEnd: noop,
    dragWorkspace: noop,
    dragOver: noop,
    dropWorkspace: noop,
    pickWorkspace,
    newWorkspace: noop,
    newSessionWith: noop,
    editWorkspace: noop,
    sessionSettings: noop,
    newSessionFrom: noop,
    editGroup: noop,
    askRemoveGroup: noop,
    openSettings: noop,
    openOverview: noop,
    newSession: noop,
    refreshContext: noop,
    setSessionPinned: noop,
    setWorkspacePinned: noop,
    archiveSessions: (ids) => {
      setArchivedSessions((a) => add(a, ...ids));
      setSelection(null);
    },
    restoreSessions: (ids) => {
      setArchivedSessions((a) => without(a, ids));
      setSelection(null);
    },
    archiveWorkspaces: (ids, archived) => {
      setArchivedWs((a) => (archived ? add(a, ...ids) : without(a, ids)));
      if (archived) setArchivedOpen((o) => add(o, ARCHIVED_WORKSPACES));
      setSelection(null);
    },
    askRemoveSessions,
    // 样张一次只弹一个确认框：多个工作区只问第一个
    askRemoveWorkspaces: (ids) => {
      if (ids[0]) askRemoveWorkspace(ids[0]);
    },
    renameSession: noop,
    renameWorkspace: noop,
    joinGroup: (ids, groupId) => {
      setGroupOf((m) => ({
        ...m,
        ...Object.fromEntries(ids.map((i) => [i, groupId])),
      }));
      setSelection(null);
    },
    newGroup: (ids) => {
      const id = `g-${groups.length + 1}`;
      setGroups((g) => [...g, { id, name: `分组 ${g.length + 1}`, tone: 2 }]);
      setGroupOf((m) => ({
        ...m,
        ...Object.fromEntries(ids.map((i) => [i, id])),
      }));
      setSelection(null);
    },
    groups,
    flyOpen,
  };
}
