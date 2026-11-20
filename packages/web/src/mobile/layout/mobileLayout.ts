// 手机版布局 store：实现 LayoutStore 里「打开某个东西」的那一批意图（openDiff / openFilePreview / openTab …），
// 语义是往导航栈推一页；窗口、窗格、拖放那一批在手机上没有对应物，一律返回 false。
// 状态只有「当前页」：一个窗口、一个窗格、一个标签，让对话里按「承载这条对话的窗格」找落点的代码照常工作。

import { panesOf, type TabInit } from "../../features/workspace/model/l2";
import { emptyLayout } from "../../features/workspace/model/layoutDoc";
import type { Tab, TabType } from "../../features/workspace/model/types";
import type {
  LayoutState,
  LayoutStore,
} from "../../features/workspace/store/layoutStore";
import type { Nav } from "../nav/nav";
import type { Route } from "../nav/route";

/** 手机上这一页对应的标签：对话页是 chat 标签，标签页就是它自己 */
const PAGE = "m";

function tabOfRoute(route: Route): Tab | null {
  if (route.name === "chat")
    return { id: "m-chat", type: "chat", ctab: "chat", sid: route.sid };
  if (route.name === "tab") return route.tab;
  return null;
}

function stateOf(route: Route, workspaceId: string | null): LayoutState {
  const tab = tabOfRoute(route);
  const doc = emptyLayout();
  if (tab)
    doc.windows = {
      active: 0,
      list: [
        {
          id: PAGE,
          focus: PAGE,
          root: {
            pid: PAGE,
            host: tab.host ?? null,
            tabs: [tab],
            active: tab.id,
          },
        },
      ],
    };
  return {
    workspaceId,
    doc,
    status: "ready",
    error: null,
    dirty: false,
    revision: 0,
  };
}

export const mobileTab = (type: TabType, init: TabInit = {}): Tab => {
  const tab: Tab = { id: `m-${type}`, type, ...init };
  if (type === "chat") tab.ctab = "chat";
  return tab;
};

const no = () => false;

export function createMobileLayout(nav: Nav): LayoutStore {
  let workspaceId: string | null = null;
  let cached: { route: Route; ws: string | null; state: LayoutState } | null =
    null;
  const getState = (): LayoutState => {
    const route = nav.route();
    if (cached?.route !== route || cached.ws !== workspaceId)
      cached = { route, ws: workspaceId, state: stateOf(route, workspaceId) };
    return cached.state;
  };
  const listeners = new Set<() => void>();
  const offNav = nav.subscribe(() => {
    for (const cb of [...listeners]) cb();
  });

  // 当前页的会话（对话页或带会话的标签页）：打开的标签带上它，既是「借一条会话流」的锚点，也让深链接能找回所属工作区
  const anchor = (): string | undefined => {
    const route = nav.route();
    return route.name === "chat"
      ? route.sid
      : route.name === "tab"
        ? route.tab.sid
        : undefined;
  };
  const push = (tab: Tab) => {
    const sid = tab.sid ?? anchor();
    nav.push({ name: "tab", tab: sid === undefined ? tab : { ...tab, sid } });
    return true;
  };
  // 对话里点出来的 diff / 预览：主机取发起它的那个标签的主机（对话标签没有，就是 Server 本机）
  const hostOf = (tabId: string | null): string => {
    const win = getState().doc.windows.list[0];
    const tabs = win ? panesOf(win).flatMap((p) => p.tabs) : [];
    return tabs.find((t) => t.id === tabId)?.host ?? "server";
  };
  const openSession = (sid: string) => {
    nav.push({ name: "chat", sid });
    return true;
  };

  return {
    getState,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) offNav();
      };
    },
    async setWorkspace(id) {
      if (id === workspaceId) return;
      workspaceId = id;
      for (const cb of [...listeners]) cb();
    },
    setDirectories: () => {},
    setSessions: () => {},
    flush: async () => {},
    dispose: () => {},

    // ── 窗口与窗格：手机上没有 ──
    switchWindow: no,
    addWindow: no,
    closeWindow: no,
    focusPane: no,
    activateTab: no,
    closeTab: no,
    closePane: no,
    setPaneSizes: no,
    patchTab: no,
    patchAfx: no,
    splitWithTab: no,
    moveTab: no,
    movePane: no,
    movePaneToWindow: no,
    detachPane: no,
    placeSession: no,
    revealBrowser: no,

    // ── 「打开某个东西」：推一页 ──
    addTab: (_pid, type, init) => push(mobileTab(type, init)),
    openTab: (_pid, type, init) => push(mobileTab(type, init)),
    openPreview: (_pid, fromTabId, path) =>
      push(mobileTab("preview", { host: hostOf(fromTabId), path })),
    openFilePreview: (_pid, _fromTabId, host, path) =>
      push(mobileTab("preview", { host, path })),
    openInBrowser: (_pid, page) => push(mobileTab("web", { page })),
    openBrowserPage: (page) => push(mobileTab("web", { page })),
    openDiff: (_pid, fromTabId, turn, path, sid) =>
      push(
        mobileTab("preview", {
          host: hostOf(fromTabId),
          ...(sid === undefined ? {} : { sid }),
          diff: { turn, path },
        }),
      ),
    openTeamDiff: (_pid, fromTabId, path, sid) =>
      push(
        mobileTab("preview", {
          host: hostOf(fromTabId),
          sid,
          diff: { turn: null, path, team: true },
        }),
      ),

    // ── 会话 ──
    showSession: openSession,
    pinSession: openSession,
    viewing: () => {
      const route = nav.route();
      return route.name === "chat" ? [route.sid] : [];
    },
    adoptSession: () => {},
    hasSession: () => true,
    anchorSession: () => anchor() ?? null,
  };
}
