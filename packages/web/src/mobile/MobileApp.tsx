// 手机端的壳：令牌门（含配对）→ 数据层（对话、会话库、布局）→ 当前页。
// 与桌面共用对话视图、会话库、对话 store 与 ui；只有导航栈与页面是手机自己的。
import { useEffect, useMemo } from "react";
import { loadToken } from "../api/http";
import { Gate } from "../app/Gate";
import { hostIdOf } from "../app/shell/hosts";
import { useChatMeta } from "../app/shell/useChatMeta";
import { useShellHosts } from "../app/shell/useShellHosts";
import { ChatProvider } from "../features/chat";
import { ChatTabContext } from "../features/chat/tab";
import { LayoutBridge } from "../features/workspace/LayoutBridge";
import {
  LibraryProvider,
  useCurrentWorkspace,
  useLibraryState,
} from "../features/workspace/library/LibraryProvider";
import { useBrowserShow } from "../features/workspace/useBrowserShow";
import { useViewingReport } from "../features/workspace/viewingReport";
import { ToastHost } from "../ui";
import { createMobileLayout } from "./layout/mobileLayout";
import { MobileGate } from "./MobileGate";
import { NavProvider, useRoute } from "./nav/NavProvider";
import type { Nav } from "./nav/nav";
import { ChatPage } from "./pages/ChatPage";
import { ListPage } from "./pages/ListPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TabPage } from "./pages/TabPage";
import { useKeyboardInset } from "./useKeyboardInset";

export function MobileApp({ nav }: { nav: Nav }) {
  return (
    <NavProvider nav={nav}>
      <MobileGate>
        <Gate>
          {(_sessions, onUnauthorized) => (
            <MobileShell
              nav={nav}
              token={loadToken()}
              onUnauthorized={onUnauthorized}
            />
          )}
        </Gate>
      </MobileGate>
    </NavProvider>
  );
}

function MobileShell({
  nav,
  token,
  onUnauthorized,
}: {
  nav: Nav;
  token: string | null;
  onUnauthorized: () => void;
}) {
  const hosts = useShellHosts();
  const layout = useMemo(() => createMobileLayout(nav), [nav]);
  return (
    <ChatProvider token={token} onUnauthorized={onUnauthorized}>
      <LibraryProvider token={token}>
        <LayoutBridge
          token={token}
          hosts={hosts}
          toHostId={hostIdOf}
          store={layout}
        >
          <Pages hosts={hosts} onSignedOut={onUnauthorized} />
        </LayoutBridge>
      </LibraryProvider>
    </ChatProvider>
  );
}

function Pages({
  hosts,
  onSignedOut,
}: {
  hosts: ReturnType<typeof useShellHosts>;
  onSignedOut: () => void;
}) {
  const route = useRoute();
  const current = useCurrentWorkspace();
  const sessions = useLibraryState((s) => s.sessions);
  const { env } = useChatMeta(hosts);
  // 手机上回车是换行，发送靠按钮
  const chatEnv = useMemo(() => ({ ...env, enterSends: false }), [env]);
  useViewingReport();
  useBrowserShow();
  useKeyboardInset();

  // 对话页（或它打开的标签页）所属的工作区就是当前工作区：工作区级标签与布局的存取键都认它
  const sid =
    route.name === "chat"
      ? route.sid
      : route.name === "tab"
        ? route.tab.sid
        : undefined;
  const workspaceId = sessions.find((s) => s.id === sid)?.workspaceId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: current 每次渲染都是新对象，只在工作区 id 变化时同步
  useEffect(() => {
    if (workspaceId) current.select(workspaceId);
  }, [workspaceId]);

  return (
    <ChatTabContext.Provider value={chatEnv}>
      <div className="m-app">
        {/* 列表一直挂着：从对话返回时滚动位置还在 */}
        <div className="m-layer" hidden={route.name !== "list"}>
          <ListPage />
        </div>
        {route.name === "chat" && (
          <div className="m-layer" key={route.sid}>
            <ChatPage sid={route.sid} audit={route.audit === true} />
          </div>
        )}
        {route.name === "tab" && (
          <div className="m-layer">
            <TabPage tab={route.tab} />
          </div>
        )}
        {route.name === "settings" && (
          <div className="m-layer">
            <SettingsPage onSignedOut={onSignedOut} />
          </div>
        )}
        <ToastHost />
      </div>
    </ChatTabContext.Provider>
  );
}
