import { useState } from "react";
import { Segmented } from "../../ui";
import { CreateView } from "./CreateView";
import { ListPageView } from "./frame/ListPageView";
import { RailView } from "./rail/RailView";
import { SettingsView } from "./SettingsView";
import { StudioView } from "./StudioView";
import { Studio2View } from "./studio2/Studio2View";
import { WorkbenchView } from "./WorkbenchView";
import "./gallery.css";

const VIEWS = [
  { value: "create", label: "创建弹窗" },
  { value: "settings", label: "设置页" },
  { value: "workbench", label: "工作台" },
  { value: "rail", label: "左轨（C2）" },
  { value: "studio", label: "提示词与能力（B3）" },
  { value: "studio2", label: "提示词与能力（完整）" },
  { value: "frame-list", label: "页框架·列表页" },
] as const;
type View = (typeof VIEWS)[number]["value"];

const initial = (): View => {
  const v = new URLSearchParams(location.search).get("gallery");
  return VIEWS.find((x) => x.value === v)?.value ?? "create";
};

// 组件对照页（/?gallery=create|settings|workbench）：同一套 ui/ 组件重搭三张样张的视图，用来核对基础组件够不够用、长得对不对。
export default function GalleryPage() {
  const [view, setView] = useState<View>(initial);
  const pick = (v: View) => {
    setView(v);
    history.replaceState(null, "", `/?gallery=${v}`);
  };
  return (
    <div className="gl">
      <div className="gl-bar">
        <span className="t-entry">组件对照</span>
        <Segmented
          size="sm"
          aria-label="视图"
          options={VIEWS}
          value={view}
          onChange={pick}
        />
      </div>
      <div className="gl-main">
        {view === "create" && <CreateView />}
        {view === "settings" && <SettingsView />}
        {view === "workbench" && <WorkbenchView />}
        {view === "rail" && <RailView />}
        {view === "studio" && <StudioView />}
        {view === "studio2" && <Studio2View />}
        {view === "frame-list" && <ListPageView />}
      </div>
    </div>
  );
}
