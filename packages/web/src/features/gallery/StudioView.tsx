import { useState } from "react";
import { Segmented } from "../../ui";
import { SettingsFrame } from "./SettingsView";
import { DefaultsView } from "./StudioDialogs";
import { AgentEditor } from "./StudioEditor";

const SUBS = [
  { value: "agent", label: "① Agent 编辑器（分组 · 能力）" },
  { value: "defaults", label: "② 新会话默认配置" },
] as const;
type Sub = (typeof SUBS)[number]["value"];

const initial = (): Sub => {
  const v = new URLSearchParams(location.search).get("view");
  return SUBS.find((x) => x.value === v)?.value ?? "agent";
};

// Studio 重建的样张（B3）：两个仍有参照价值的界面设计项，用 ui/ 组件搭，数据是假的。
// ③ 项目约定选择、④ AGENTS.md 预设已随 2026-11-05 的设计变更删除。
export function StudioView() {
  const [sub, setSub] = useState<Sub>(initial);
  const pick = (v: Sub) => {
    setSub(v);
    history.replaceState(null, "", `/?gallery=studio&view=${v}`);
  };
  return (
    <div className="gl-studio">
      <div className="gl-subbar">
        <Segmented
          size="sm"
          aria-label="样张"
          options={SUBS}
          value={sub}
          onChange={pick}
        />
      </div>
      <div className="gl-studio-main">
        <SettingsFrame current="presets">
          {sub === "agent" && <AgentEditor />}
          {sub === "defaults" && <DefaultsView />}
        </SettingsFrame>
      </div>
    </div>
  );
}
