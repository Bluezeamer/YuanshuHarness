import { useCallback, useRef, useState } from "react";
import type { SessionInfo } from "../api";
import { Overview } from "./Overview";

// 左侧会话 rail：切会话（follow 的面板跟着走，钉住的不动），进总览。
// ≥900px 纵列、<900px 横条；总览只在纵列时可见（试行）。
export function SessionRail({
  sessions,
  activeId,
  onSelect,
}: {
  sessions: SessionInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const [overview, setOverview] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOverview(false);
    trigger.current?.focus();
  }, []);

  return (
    <div className="relative flex shrink-0">
      <aside
        aria-label="会话列表"
        className="flex min-w-0 flex-1 flex-row overflow-x-auto border-b border-line bg-panel min-[900px]:min-h-0 min-[900px]:w-[200px] min-[900px]:flex-none min-[900px]:flex-col min-[900px]:overflow-x-visible min-[900px]:border-r min-[900px]:border-b-0"
      >
        <h2 className="m-0 hidden border-b border-line px-3.5 py-3.5 text-xs font-semibold text-mute min-[900px]:block">
          会话 <span className="font-mono">{sessions.length}</span>
        </h2>
        <ul className="m-0 flex list-none flex-row gap-0.5 p-2 min-[900px]:min-h-0 min-[900px]:flex-1 min-[900px]:flex-col min-[900px]:overflow-y-auto">
          {sessions.length === 0 && (
            <li className="px-2 py-1 text-xs text-mute">还没有会话</li>
          )}
          {sessions.map((s, i) => {
            const active = s.id === activeId;
            return (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelect(s.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium ${
                    active
                      ? "bg-accent-deep font-semibold text-panel"
                      : "hover:bg-ink/5"
                  }`}
                >
                  <span
                    className={`w-4 shrink-0 font-mono text-[10.5px] ${active ? "text-panel/70" : "text-mute"}`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    role="img"
                    aria-label={s.running ? "运行中" : "空闲"}
                    className={`size-2 shrink-0 rounded-full ${
                      s.running
                        ? `dot-run ${active ? "bg-panel/90" : "bg-ok"}`
                        : "bg-line"
                    }`}
                  />
                  <span className="max-w-40 truncate">
                    {s.name ?? "未命名会话"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="m-0 hidden px-3.5 py-2 text-[10.5px] text-mute min-[900px]:block">
          跟随的面板随会话切换，钉住的不动
        </p>
        <button
          ref={trigger}
          type="button"
          data-overview-trigger
          aria-expanded={overview}
          onClick={() => setOverview((o) => !o)}
          className="m-2 mt-0 hidden items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-semibold hover:border-accent hover:bg-accent-soft hover:text-accent-deep min-[900px]:flex"
        >
          会话总览
          <span className="ml-auto font-mono text-mute">{sessions.length}</span>
        </button>
      </aside>
      {overview && (
        <Overview
          sessions={sessions}
          activeId={activeId}
          onSelect={onSelect}
          onClose={close}
        />
      )}
    </div>
  );
}
