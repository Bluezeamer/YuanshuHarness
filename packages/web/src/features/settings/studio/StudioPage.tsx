// 「提示词与能力」：卡片库是来源，预设是装配。数据全部来自服务端。
//
// 八个页签：全局 AGENTS.md、项目 AGENTS.md、全局附加提示词、Agent、模式（都是预设，同一套列表与编辑页）、
// 审核提示词（审批模型的判别准则）、工具（描述微调）、卡片（卡片库）。点开一份预设，编辑页换掉整页（含页签），左上角返回。
import { useState } from "react";
import { Button, Empty, Loading } from "../../../ui";
import { ListColumn, Page } from "../frame/layout";
import { useLeaveGuard } from "../frame/leave";
import { PageTabs } from "../frame/PageTabs";
import { useActivate, useGlobalFile } from "./activate";
import { CardLibrary } from "./CardLibrary";
import { PresetEditor } from "./PresetEditor";
import { PresetList } from "./PresetList";
import { ReviewPromptTab } from "./ReviewPromptTab";
import { ToolsPanel } from "./ToolsPanel";
import { StudioProvider, useStudio } from "./useStudio";

const PRESET_TABS = [
  "global-agentsmd",
  "project-agentsmd",
  "global-extra",
  "agent",
  "mode",
] as const;
type PresetTab = (typeof PRESET_TABS)[number];
type Tab = PresetTab | "review" | "tools" | "cards";

function Tabbed() {
  const { presets, groups } = useStudio();
  const guard = useLeaveGuard();
  const file = useGlobalFile();
  const activate = useActivate(file);
  const [tab, setTab] = useState<Tab>("agent");
  const [open, setOpen] = useState<string | null>(null);
  const n = (kind: PresetTab) => presets.filter((p) => p.kind === kind).length;
  const current = open ? presets.find((p) => p.id === open) : undefined;

  if (current)
    return (
      <>
        <PresetEditor
          key={current.id}
          preset={current}
          activate={activate}
          path={file.state?.path ?? "~/.ys/AGENTS.md"}
          onBack={() => setOpen(null)}
        />
        {activate.dialog}
      </>
    );

  const kind = (PRESET_TABS as readonly string[]).includes(tab)
    ? (tab as PresetTab)
    : null;
  return (
    <Page>
      <PageTabs
        idBase="sd"
        aria-label="提示词与能力视图"
        value={tab}
        onChange={(v) => guard(() => setTab(v as Tab))}
        tabs={[
          {
            id: "global-agentsmd",
            label: "全局 AGENTS.md",
            count: n("global-agentsmd"),
          },
          {
            id: "project-agentsmd",
            label: "项目 AGENTS.md",
            count: n("project-agentsmd"),
          },
          {
            id: "global-extra",
            label: "全局附加提示词",
            count: n("global-extra"),
          },
          { id: "agent", label: "Agent", count: n("agent") },
          { id: "mode", label: "模式", count: n("mode") },
          { id: "review", label: "审核提示词" },
          { id: "tools", label: "工具" },
          {
            id: "cards",
            label: "卡片",
            count: groups.reduce((a, g) => a + g.cards.length, 0),
          },
        ]}
      />
      {kind && (
        <ListColumn>
          <PresetList
            key={kind}
            kind={kind}
            onOpen={setOpen}
            activate={activate}
            file={file}
          />
        </ListColumn>
      )}
      {tab === "review" && <ReviewPromptTab />}
      {tab === "tools" && <ToolsPanel />}
      {tab === "cards" && <CardLibrary />}
      {activate.dialog}
    </Page>
  );
}

export function StudioPage() {
  return (
    <StudioProvider
      fallback={(phase, retry) =>
        phase === "loading" ? (
          <Loading>正在读取提示词与能力…</Loading>
        ) : (
          <Empty
            tone="danger"
            title="读取提示词与能力失败"
            action={<Button onClick={retry}>重试</Button>}
          />
        )
      }
    >
      <Tabbed />
    </StudioProvider>
  );
}
