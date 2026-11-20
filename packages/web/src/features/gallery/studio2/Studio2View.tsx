import { useState } from "react";
import { ListColumn, Page } from "../../settings/frame/layout";
import { LeaveGuardProvider, useLeaveGuard } from "../../settings/frame/leave";
import { PageTabs } from "../../settings/frame/PageTabs";
import { SettingsShell } from "../frame/Shell";
import { LIB } from "../studioData";
import { CardsTab } from "./CardsTab";
import { useActivate } from "./Dialogs";
import { type Kind, type Store, useStore } from "./data";
import { Editor } from "./Editor";
import { PresetList } from "./PresetList";
import { ToolsTab } from "./ToolsTab";
import "./studio2.css";

type Tab = Kind | "tools" | "cards";

const initial = (): Tab => {
  const v = new URLSearchParams(location.search).get("tab");
  return (
    (["gmd", "pmd", "extra", "agent", "mode", "tools", "cards"] as const).find(
      (x) => x === v,
    ) ?? "agent"
  );
};

function Studio({ store }: { store: Store }) {
  const guard = useLeaveGuard();
  const activate = useActivate(store);
  const [tab, setTab] = useState<Tab>(initial);
  const [open, setOpen] = useState<string | null>(
    new URLSearchParams(location.search).get("open"),
  );
  const current = open ? store.get(open) : undefined;
  const n = (k: Kind) => store.list.filter((p) => p.kind === k).length;

  if (current)
    return (
      <>
        <Editor
          key={current.id}
          preset={current}
          store={store}
          activate={activate}
          onBack={() => setOpen(null)}
        />
        {activate.dialog}
      </>
    );

  const kind = tab === "tools" || tab === "cards" ? null : tab;
  return (
    <Page>
      <PageTabs
        idBase="sp"
        aria-label="提示词与能力视图"
        value={tab}
        onChange={(v) => guard(() => setTab(v as Tab))}
        tabs={[
          { id: "gmd", label: "全局 AGENTS.md", count: n("gmd") },
          { id: "pmd", label: "项目 AGENTS.md", count: n("pmd") },
          { id: "extra", label: "全局附加提示词", count: n("extra") },
          { id: "agent", label: "Agent", count: n("agent") },
          { id: "mode", label: "模式", count: n("mode") },
          { id: "tools", label: "工具" },
          { id: "cards", label: "卡片", count: LIB.length },
        ]}
      />
      {kind && (
        <ListColumn>
          <PresetList
            key={kind}
            kind={kind}
            store={store}
            onOpen={setOpen}
            activate={activate}
          />
        </ListColumn>
      )}
      {tab === "tools" && <ToolsTab />}
      {tab === "cards" && <CardsTab />}
      {activate.dialog}
    </Page>
  );
}

// 「提示词与能力」的完整可交互样张：七个页签、五种预设的列表与编辑页、激活与覆盖提示、卡片库、工具。
// 数据在内存里，刷新复位；链接参数 ?tab=gmd|pmd|extra|agent|mode|tools|cards、?open=<预设id>（a1 / g3 / x1…）可直达。
export function Studio2View() {
  const store = useStore();
  return (
    <LeaveGuardProvider>
      <SettingsShell current="studio">
        <Studio store={store} />
      </SettingsShell>
    </LeaveGuardProvider>
  );
}
