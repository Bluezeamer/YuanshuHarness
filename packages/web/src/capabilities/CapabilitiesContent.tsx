import { useState } from "react";
import { AgentsPanel } from "./AgentsPanel";
import { McpPanel } from "./McpPanel";
import { PromptBlocksPanel } from "./PromptBlocksPanel";
import { SkillsPanel } from "./SkillsPanel";

const TABS = [
  { id: "agents", label: "Agent" },
  { id: "blocks", label: "提示词块" },
  { id: "skills", label: "Skill" },
  { id: "mcp", label: "MCP" },
] as const;

type TabId = (typeof TABS)[number]["id"];

// 整页容器由 pages.tsx 的 Page 提供；这里只负责 tab 与四个面板的挂载。
export function CapabilitiesContent({
  onUnauthorized,
}: {
  onUnauthorized(): void;
}) {
  const [tab, setTab] = useState<TabId>("agents");
  return (
    <>
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
      {tab === "agents" ? (
        <AgentsPanel onUnauthorized={onUnauthorized} />
      ) : tab === "blocks" ? (
        <PromptBlocksPanel onUnauthorized={onUnauthorized} />
      ) : tab === "skills" ? (
        <SkillsPanel onUnauthorized={onUnauthorized} />
      ) : (
        <McpPanel onUnauthorized={onUnauthorized} />
      )}
    </>
  );
}
