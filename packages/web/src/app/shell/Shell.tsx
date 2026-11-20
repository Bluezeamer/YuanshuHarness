// 新壳：左轨（工作区 → 会话）+ 主区（当前工作区的窗口与窗格），设置页是盖在上面的全屏面板。
// 路由：/ = 工作区；/settings/<页> = 设置；其余回到 /。
// 壳只做拼装与「两套 id 的翻译」，业务都在 features/ 里。
import { useCallback, useEffect, useState } from "react";
import { ChatProvider } from "../../features/chat";
import { ChatTabContext } from "../../features/chat/tab";
import { SettingsLayout, settingsRoutes } from "../../features/settings";
import { WorkspacePage } from "../../features/workspace";
import {
  SessionDialog,
  WorkspaceDialog,
} from "../../features/workspace/dialogs";
import { LayoutBridge } from "../../features/workspace/LayoutBridge";
import {
  useLayoutState,
  useLayoutStore,
} from "../../features/workspace/layoutContext";
import {
  LibraryProvider,
  useCurrentWorkspace,
  useLibraryState,
} from "../../features/workspace/library/LibraryProvider";
import { useOpenSession } from "../../features/workspace/openSession";
import type { DialogSpec } from "../../features/workspace/sidebar/controller";
import { Sidebar } from "../../features/workspace/sidebar/Sidebar";
import { useSidebarController } from "../../features/workspace/sidebar/useSidebarController";
import { useViewingReport } from "../../features/workspace/viewingReport";
import { ToastHost } from "../../ui";
import { navigate, useRoute } from "../router";
import { buildCommands, type CommandSources } from "./commands";
import { hostIdOf } from "./hosts";
import { Palette } from "./Palette";
import { matchShortcut } from "./shortcuts";
import { useChatMeta } from "./useChatMeta";
import { useMedia } from "./useMedia";
import { useShellHosts } from "./useShellHosts";

export interface ShellProps {
  token: string | null;
  onUnauthorized: () => void;
}

export function Shell({ token, onUnauthorized }: ShellProps) {
  const hosts = useShellHosts();
  return (
    <ChatProvider token={token} onUnauthorized={onUnauthorized}>
      <LibraryProvider token={token}>
        <LayoutBridge token={token} hosts={hosts} toHostId={hostIdOf}>
          <ShellBody hosts={hosts} />
        </LayoutBridge>
      </LibraryProvider>
    </ChatProvider>
  );
}

function ShellBody({ hosts }: { hosts: ReturnType<typeof useShellHosts> }) {
  const route = useRoute();
  const layout = useLayoutStore();
  const openSession = useOpenSession();
  const sessions = useLibraryState((s) => s.sessions);
  const workspaces = useLibraryState((s) => s.workspaces);
  const layoutWindows = useLayoutState((s) => s.doc.windows);
  const current = useCurrentWorkspace();
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  // 命令面板的两个入口：Ctrl+K 是命令优先，总览是最近工作区优先
  const [palette, setPalette] = useState<"commands" | "overview" | null>(null);
  // 左轨：窗口窄（≤1120）时默认收起，更窄（≤900）时横过来做顶部条、不能展开；用户点过之后以用户的为准
  const compact = useMedia("(max-width: 1120px)");
  const strip = useMedia("(max-width: 900px)");
  const [railPref, setRailPref] = useState<boolean | null>(null);
  const railMin = strip || (railPref ?? compact);

  const inSettings = route.name === "settings";
  // 弹窗与设置页都是全屏层：打开时全局快捷键不抢
  const modal = dialog !== null || inSettings;

  useViewingReport();

  // 不是 / 也不是 /settings/* 的路径（旧的 /capabilities、/sessions/:id 等）回到工作区
  useEffect(() => {
    if (route.name !== "workspace" && route.name !== "settings") navigate("/");
  }, [route.name]);

  const { env: meta, hostLabel } = useChatMeta(hosts);
  const openSettings = useCallback(() => {
    const first = settingsRoutes[0];
    if (first) navigate(`/settings/${first.path}`);
  }, []);
  const openOverview = useCallback(() => setPalette("overview"), []);

  const sidebar = useSidebarController({
    openDialog: setDialog,
    openSettings,
    openOverview,
    hostLabel,
  });

  // ⌘N / 命令面板：按当前工作区的默认配置直接建一个；还没有工作区就先建工作区
  const newWorkspace = () => setDialog({ kind: "workspace", mode: "create" });
  const newSessionNow = () => {
    if (current.id) sidebar.newSession(current.id);
    else newWorkspace();
  };
  const newSessionWith = () => {
    if (current.id)
      setDialog({ kind: "session", mode: "create", workspaceId: current.id });
    else newWorkspace();
  };

  const sessionWorkspace =
    dialog?.kind === "session"
      ? workspaces.find((w) => w.id === dialog.workspaceId)
      : undefined;

  const sources: CommandSources = {
    hasFocusSession: layoutWindows.list.length > 0,
    sessions,
    workspaces,
    settings: settingsRoutes.map((r) => ({ path: r.path, label: r.label })),
    act: {
      newSession: newSessionNow,
      newSessionWith,
      newWorkspace,
      newWindow: () => void layout.addWindow(),
      nextWindow: () => {
        const n = layoutWindows.list.length;
        if (n > 0) layout.switchWindow((layoutWindows.active + 1) % n);
      },
      toggleRail: () => setRailPref(!railMin),
      openOverview,
      selectWorkspace: (id) => current.select(id),
      selectSession: (id) => openSession(id),
      openSettings: (path) => navigate(`/settings/${path}`),
    },
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = matchShortcut(e, navigator.platform, modal);
      if (!a) return;
      e.preventDefault();
      if (a.kind === "palette") setPalette((v) => (v ? null : "commands"));
      else if (a.kind === "overview") openOverview();
      else if (a.kind === "newWindow") sources.act.newWindow();
      else if (a.kind === "newSession") newSessionNow();
      else if (a.kind === "toggleRail") setRailPref(!railMin);
      else if (a.kind === "settings") openSettings();
      else layout.switchWindow(a.index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <ChatTabContext.Provider value={meta}>
      <div className="sh-app">
        <Sidebar
          c={sidebar}
          collapsed={railMin}
          onCollapsedChange={setRailPref}
        />
        <WorkspacePage />
        {inSettings && (
          <div className="sh-settings" role="presentation">
            <SettingsLayout
              routes={settingsRoutes}
              page={route.name === "settings" ? route.page : undefined}
            />
          </div>
        )}
        {dialog?.kind === "workspace" && (
          <WorkspaceDialog
            mode={dialog.mode}
            workspace={
              dialog.mode === "edit"
                ? workspaces.find((w) => w.id === dialog.workspaceId)
                : undefined
            }
            workspaces={workspaces}
            onClose={() => setDialog(null)}
            onDone={(ws, created) => {
              setDialog(null);
              if (dialog.mode === "edit") return;
              current.select(ws.id);
              if (created) sidebar.newSession(ws.id);
            }}
          />
        )}
        {dialog?.kind === "session" && sessionWorkspace && (
          <SessionDialog
            mode={dialog.mode}
            workspace={sessionWorkspace}
            sessionId={dialog.mode === "create" ? undefined : dialog.sessionId}
            onClose={() => setDialog(null)}
            onDone={(id) => {
              setDialog(null);
              if (dialog.mode === "edit") return;
              // 推送还没带上它：先登记，免得标签被当作失效会话关掉；useOpenSession 会等它出现再打开
              layout.adoptSession(id);
              openSession(id);
            }}
          />
        )}
        <Palette
          open={palette !== null}
          onClose={() => setPalette(null)}
          commands={buildCommands(sources)}
          lead={palette === "overview" ? "workspace" : undefined}
        />
        <ToastHost />
      </div>
    </ChatTabContext.Provider>
  );
}
