import { useState } from "react";
import { ReviewPanel } from "./ReviewPanel";
import { WorkspacesPanel } from "./WorkspacesPanel";

const TABS = [
  { id: "ws", label: "工作区" },
  { id: "review", label: "审核策略" },
] as const;

// 盖在工作台上的管理页（工作台保持挂载，pane 状态不丢）。Esc 或「关闭」退出。
export function Settings({
  onClose,
  onUnauthorized,
}: {
  onClose(): void;
  onUnauthorized(): void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("ws");
  return (
    <section
      aria-label="设置"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="enter absolute inset-0 z-40 overflow-auto bg-bg"
    >
      <div className="mx-auto flex max-w-[1000px] flex-col gap-5 px-6 py-6">
        <div className="flex items-baseline justify-between">
          <h1 className="m-0 text-[26px] font-bold tracking-tight">设置</h1>
          <button
            type="button"
            onClick={onClose}
            className="border border-ink px-3 py-1 text-xs font-semibold hover:bg-ink hover:text-bg"
          >
            关闭
          </button>
        </div>
        <div role="tablist" className="flex gap-6 border-b border-ink">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-[3px] py-2 font-semibold ${tab === t.id ? "border-ink" : "border-transparent text-mute hover:text-ink"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "ws" ? (
          <WorkspacesPanel onUnauthorized={onUnauthorized} />
        ) : (
          <ReviewPanel onUnauthorized={onUnauthorized} />
        )}
      </div>
    </section>
  );
}
