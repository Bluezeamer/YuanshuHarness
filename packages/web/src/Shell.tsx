import { useCallback, useEffect, useState } from "react";
import { listSessions, loadToken, type SessionInfo } from "./api";
import { Workbench } from "./layout/Workbench";
import { SessionHub } from "./sessions/hub";
import { NewSession } from "./settings/NewSession";
import { Settings } from "./settings/Settings";

export function Shell({
  sessions: initialSessions,
  onUnauthorized,
}: {
  sessions: SessionInfo[];
  onUnauthorized: () => void;
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [panel, setPanel] = useState<"settings" | "new" | null>(null);
  const [tabsHost, setTabsHost] = useState<HTMLDivElement | null>(null);
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
          <i className="size-3 bg-acc" />
          元枢
        </div>
        <div ref={setTabsHost} className="flex items-stretch" />
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
          <button
            type="button"
            className={btn}
            onClick={() => setPanel("settings")}
          >
            设置
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
          tabsHost={tabsHost}
          newSession={newSession}
        />
        {panel === "settings" && (
          <Settings
            onClose={() => setPanel(null)}
            onUnauthorized={onUnauthorized}
          />
        )}
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
