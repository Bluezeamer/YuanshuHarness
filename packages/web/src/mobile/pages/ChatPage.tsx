import { useMemo, useState } from "react";
import { SERVER_HOST } from "../../app/shell/hosts";
import { useChatSession } from "../../features/chat";
import { useOpenExecution } from "../../features/chat/exec/useOpenExecution";
import { useOpenJob } from "../../features/chat/job/useOpenJob";
import { StatusPanel } from "../../features/chat/status";
import { ChatView, useSessionMeta } from "../../features/chat/tab";
import { useBrowser } from "../../features/workspace/browser";
import { useLayoutStore } from "../../features/workspace/layoutContext";
import { useCurrentWorkspace } from "../../features/workspace/library/LibraryProvider";
import type { TabAfx } from "../../features/workspace/model/types";
import { Dot, IconButton, Sheet } from "../../ui";
import { GlobeIcon, SidebarIcon, ToolsIcon } from "../../ui/icons";
import { mobileTab } from "../layout/mobileLayout";
import { useNav, useRoute } from "../nav/NavProvider";
import { TopBar } from "../ui/TopBar";
import { ToolsSheet } from "./ToolsSheet";

/** 状态抽屉里的右栏按「宽」形态铺开（各块依次排开） */
const WIDE = 1000;
const PANE = "m";

// 对话页：顶栏（返回 / 标题 / 状态）+ 对话视图。对话视图与桌面是同一个组件，只是不带左缘导航线与右栏；
// 右栏的内容（目标、计划、团队、子代理…）放进「状态」抽屉。
export function ChatPage({ sid, audit }: { sid: string; audit: boolean }) {
  const nav = useNav();
  const route = useRoute();
  const session = useChatSession(sid);
  const meta = useSessionMeta(sid);
  const store = useLayoutStore();
  const openExec = useOpenExecution(sid, PANE);
  const openJob = useOpenJob(sid, PANE);
  // 手机上没有窗格，标签里的界面状态（右栏的展开折叠）只活在这一页
  const [afx, setAfx] = useState<TabAfx>({});
  const tab = useMemo(
    () => ({
      ...mobileTab("chat", { sid }),
      ctab: audit ? ("audit" as const) : ("chat" as const),
      afx,
    }),
    [sid, audit, afx],
  );
  // 这个工作区有浏览器页面时顶栏出一个入口；agent 正在用页面时带小点
  const { state: browser } = useBrowser(useCurrentWorkspace().id);
  const agentPage = browser.pages.find((p) => p.inUseBy === sid);
  const openBrowser = () => {
    const page = agentPage ?? browser.pages[0];
    nav.push({
      name: "tab",
      tab: mobileTab("web", { sid, ...(page ? { page: page.id } : {}) }),
    });
  };
  const patchAfx = (patch: Partial<TabAfx>) =>
    setAfx((a) => ({ ...a, ...patch }));
  const statusOpen = route.name === "chat" && route.layer === "status";

  return (
    <div className="m-page m-chat">
      <TopBar
        title={`${audit ? "审计 · " : ""}${meta?.title ?? sid}`}
        onBack={nav.back}
        end={
          <>
            {browser.pages.length > 0 && (
              <span className="m-badged">
                <IconButton
                  label="浏览器"
                  icon={<GlobeIcon />}
                  onClick={openBrowser}
                />
                {agentPage && (
                  <Dot
                    className="m-badge"
                    tone="live"
                    motion="pulse"
                    label="agent 在用"
                  />
                )}
              </span>
            )}
            <span className="m-badged">
              <IconButton
                label="状态"
                icon={<SidebarIcon />}
                onClick={() => nav.push({ name: "chat", sid, layer: "status" })}
              />
              {session.state.running && (
                <Dot
                  className="m-badge"
                  tone="live"
                  motion="pulse"
                  label="执行中"
                />
              )}
            </span>
            <IconButton
              label="工具"
              icon={<ToolsIcon />}
              onClick={() => nav.push({ name: "chat", sid, layer: "tools" })}
            />
          </>
        }
      />
      <ChatView
        sessionId={sid}
        tab={tab}
        patchAfx={patchAfx}
        session={session}
        meta={meta}
        onOpenJob={openJob}
        nav={false}
      />
      {route.name === "chat" && route.layer === "tools" && (
        <ToolsSheet sid={sid} withAudit />
      )}
      {statusOpen && (
        <Sheet title="状态" className="m-status-sheet" onClose={nav.back}>
          <StatusPanel
            sessionId={sid}
            session={session}
            afx={afx}
            patchAfx={patchAfx}
            width={WIDE}
            onOpenExecution={openExec}
            onOpenJob={openJob}
            onOpenFile={(path) =>
              store.openFilePreview(PANE, tab.id, SERVER_HOST, path)
            }
            onOpenTeamDiff={(path) =>
              store.openTeamDiff(PANE, tab.id, path, sid)
            }
          />
        </Sheet>
      )}
    </div>
  );
}
