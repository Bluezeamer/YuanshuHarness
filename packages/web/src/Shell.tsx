import { useCallback, useEffect, useState } from "react";
import { listSessions, loadToken, type SessionInfo } from "./api";
import { Workbench } from "./layout/Workbench";
import {
  CapabilitiesPage,
  NotFoundPage,
  PreviewPage,
  SessionPage,
} from "./pages";
import { Link, navigate, useRoute } from "./router";
import { SessionHub } from "./sessions/hub";
import { NewSession } from "./settings/NewSession";
import { Settings } from "./settings/Settings";

const NAV = [
  { to: "/", label: "工作区", name: "workspace" },
  { to: "/capabilities", label: "能力集", name: "capabilities" },
  { to: "/settings", label: "设置", name: "settings" },
  { to: "/preview", label: "内置预览", name: "preview" },
] as const;

export function Shell({
  sessions: initialSessions,
  onUnauthorized,
}: {
  sessions: SessionInfo[];
  onUnauthorized: () => void;
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const route = useRoute();
  const [panel, setPanel] = useState<"new" | null>(null);
  const [hub] = useState(() => new SessionHub());
  useEffect(() => {
    hub.onUnauthorized = onUnauthorized;
  }, [hub, onUnauthorized]);

  // 新建会话后重新拉列表；失败时保持原列表。
  const refresh = async () => {
    const r = await listSessions(loadToken());
    if (r.ok) setSessions(r.data);
  };
  // 创建成功后的去向：顶栏入口无回调；pane 内入口把新会话绑到发起的 pane。
  const [onDone, setOnDone] = useState<((id: string) => void) | null>(null);
  const newSession = useCallback((done: (id: string) => void) => {
    setOnDone(() => done);
    setPanel("new");
  }, []);
  const btn =
    "self-center border border-ink px-3 py-1 text-xs font-semibold hover:bg-ink hover:text-bg";

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="flex items-stretch gap-8 border-b border-ink bg-panel px-6">
        <div className="flex items-center gap-2.5 text-[17px] font-bold tracking-wider">
          <i className="size-3 bg-accent-deep" />
          元枢
        </div>
        <nav aria-label="主导航" className="flex items-stretch gap-1">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              aria-current={route.name === n.name ? "page" : undefined}
              className={`self-center rounded-md px-3 py-1.5 text-xs font-semibold ${route.name === n.name ? "bg-accent-soft text-accent-deep" : "text-mute hover:text-ink"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 font-medium">
          <button
            type="button"
            className={btn}
            onClick={() => {
              setOnDone(null);
              setPanel("new");
            }}
          >
            新建会话
          </button>
          <i className="size-2 rounded-full bg-ok" />
          Server 在线
        </div>
      </header>
      <div className="relative min-h-0">
        <Workbench
          hub={hub}
          sessions={sessions}
          onUnauthorized={onUnauthorized}
          newSession={newSession}
        />
        {route.name === "settings" && (
          <Settings
            onClose={() => navigate("/")}
            onUnauthorized={onUnauthorized}
          />
        )}
        {route.name === "capabilities" && <CapabilitiesPage />}
        {route.name === "preview" && <PreviewPage />}
        {route.name === "session" && (
          <SessionPage id={route.id} sessions={sessions} hub={hub} />
        )}
        {route.name === "notfound" && <NotFoundPage />}
        {panel === "new" && (
          <NewSession
            onUnauthorized={onUnauthorized}
            onCancel={() => setPanel(null)}
            onCreated={(id) => {
              setPanel(null);
              const done = onDone;
              setOnDone(null);
              void refresh().then(() => done?.(id));
            }}
          />
        )}
      </div>
    </div>
  );
}
