import { useState } from "react";
import type { SessionInfo } from "./api";

function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      role="img"
      aria-label={running ? "运行中" : "空闲"}
      className={`size-2 rounded-full ${running ? "dot-run bg-live" : "bg-ok"}`}
    />
  );
}

export function Shell({ sessions }: { sessions: SessionInfo[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const current = sessions.find((s) => s.id === selected);

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
      <div className="enter grid min-h-0 grid-cols-[268px_1fr]">
        <aside className="min-h-0 overflow-auto border-r border-line bg-panel">
          {sessions.length === 0 ? (
            <p className="p-5 text-mute">还没有会话</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={s.id === selected ? "true" : undefined}
                    onClick={() => setSelected(s.id)}
                    className={`grid w-full grid-cols-[8px_1fr] items-center gap-3 border-b border-line2 px-5 py-3 text-left hover:bg-ink/5 ${
                      s.id === selected
                        ? "bg-ink/5 shadow-[inset_3px_0_0_var(--ink)]"
                        : ""
                    }`}
                  >
                    <StatusDot running={s.running} />
                    <span className="truncate font-semibold">
                      {s.name ?? "未命名会话"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <main className="p-7">
          {current ? (
            <h1 className="text-[22px] font-bold leading-tight">
              {current.name ?? "未命名会话"}
            </h1>
          ) : (
            <p className="text-mute">选择会话</p>
          )}
        </main>
      </div>
    </div>
  );
}
