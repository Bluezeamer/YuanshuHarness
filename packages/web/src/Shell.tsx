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
        <nav className="flex" aria-label="主导航">
          <button
            type="button"
            aria-current="page"
            className="border-b-[3px] border-ink px-3.5 py-3.5 font-semibold"
          >
            对话
          </button>
        </nav>
        <div className="ml-auto flex items-center gap-2 font-medium">
          <i className="size-2 rounded-full bg-ok" />
          Server 在线
        </div>
      </header>
      <Workbench hub={hub} sessions={sessions} onUnauthorized={onUnauthorized} />
    </div>
  );
}
