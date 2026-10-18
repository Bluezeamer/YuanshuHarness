import { useEffect, useState } from "react";
import type { SessionInfo } from "./api";
import { Workbench } from "./layout/Workbench";
import { SessionHub } from "./sessions/hub";

export function Shell({
  sessions,
  onUnauthorized,
}: {
  sessions: SessionInfo[];
  onUnauthorized: () => void;
}) {
  const [tabsHost, setTabsHost] = useState<HTMLDivElement | null>(null);
  const [hub] = useState(() => new SessionHub());
  useEffect(() => {
    hub.onUnauthorized = onUnauthorized;
  }, [hub, onUnauthorized]);

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="flex items-stretch gap-8 border-b border-ink bg-panel px-6">
        <div className="flex items-center gap-2.5 text-[17px] font-bold tracking-wider">
          <i className="size-3 bg-acc" />
          元枢
        </div>
        <div ref={setTabsHost} className="flex items-stretch" />
        <div className="ml-auto flex items-center gap-2 font-medium">
          <i className="size-2 rounded-full bg-ok" />
          Server 在线
        </div>
      </header>
      <Workbench
        hub={hub}
        sessions={sessions}
        onUnauthorized={onUnauthorized}
        tabsHost={tabsHost}
      />
    </div>
  );
}
