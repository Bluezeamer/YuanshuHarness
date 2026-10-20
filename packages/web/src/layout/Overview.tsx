import { useEffect, useRef } from "react";
import type { SessionInfo } from "../api";
import { Link } from "../router";

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// rail 底部的会话总览：全量会话，点行切换活动会话，右侧「详情」进入会话深挖页。
export function Overview({
  sessions,
  activeId,
  onSelect,
  onClose,
}: {
  sessions: SessionInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("li button")?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // 点在面板外就收起；点会话总览按钮本身交给它自己的 toggle。
      if (!ref.current?.contains(t) && !t.closest("[data-overview-trigger]"))
        onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  return (
    <section
      ref={ref}
      aria-label="会话总览"
      className="absolute top-2 left-full z-40 ml-2 flex max-h-[calc(100%-1rem)] w-[min(460px,92vw)] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-pop"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="m-0 text-[13.5px] font-semibold">会话总览</h2>
        <span className="font-mono text-xs text-mute">{sessions.length}</span>
        <button
          type="button"
          aria-label="关闭会话总览"
          onClick={onClose}
          className="ml-auto grid size-6 place-items-center rounded-md text-mute hover:bg-ink/5 hover:text-ink"
        >
          ×
        </button>
      </header>
      {sessions.length === 0 ? (
        <p className="m-0 p-4 text-mute">还没有会话</p>
      ) : (
        <ul className="m-0 list-none overflow-auto p-1.5">
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`flex items-center gap-1 rounded-md ${s.id === activeId ? "bg-accent-soft" : "hover:bg-ink/5"}`}
            >
              <button
                type="button"
                aria-current={s.id === activeId ? "true" : undefined}
                onClick={() => {
                  onSelect(s.id);
                  onClose();
                }}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
              >
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${s.running ? "dot-run bg-ok" : "bg-line"}`}
                />
                <span className="truncate text-[12.5px] font-semibold">
                  {s.name ?? "未命名会话"}
                </span>
                <span className="shrink-0 text-xs text-mute">
                  {s.running ? "运行中" : "空闲"}
                </span>
                <span className="ml-auto shrink-0 font-mono text-xs text-mute">
                  {fmt(s.updatedAt)}
                </span>
              </button>
              <Link
                to={`/sessions/${encodeURIComponent(s.id)}`}
                aria-label={`进入 ${s.name ?? "未命名会话"} 详情`}
                className="shrink-0 px-2.5 py-2 text-xs font-semibold text-accent-deep hover:underline"
              >
                详情
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
