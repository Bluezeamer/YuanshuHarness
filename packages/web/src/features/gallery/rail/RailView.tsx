import { useState } from "react";
import { Segmented } from "../../../ui";
import { Sidebar } from "../../workspace/sidebar/Sidebar";
import { Stage } from "./Stage";
import { type Demo, useDemoRail } from "./useDemoRail";

const DEMOS = [
  { value: "normal", label: "常规" },
  { value: "sel-session", label: "多选 · 会话" },
  { value: "sel-ws", label: "多选 · 工作区" },
  { value: "drag-session", label: "拖拽 · 会话" },
  { value: "drag-ws", label: "拖拽 · 工作区" },
  { value: "mini", label: "收起 62px" },
  { value: "empty", label: "空" },
] as const satisfies ReadonlyArray<{ value: Demo; label: string }>;

// 左轨样张（/?gallery=rail）：真实交互，数据是静态的。
// 单击 / 双击 / ctrl·⌘ 点选 / shift 区间 / 右键 / 悬停操作都能试；顶部切换状态对照。
function Demonstration({ demo }: { demo: Demo }) {
  const [current, setCurrent] = useState("s-prompt");
  const [pinned, setPinned] = useState<string[]>(["s-prompt", "s-design"]);
  const pin = (id: string) =>
    setPinned((p) => (p.includes(id) ? p : [...p, id]));
  const c = useDemoRail(demo, {
    current,
    pinned,
    onCurrent: setCurrent,
    onPin: (id) => {
      pin(id);
      setCurrent(id);
    },
  });
  const [collapsed, setCollapsed] = useState(demo === "mini");
  return (
    <>
      <Sidebar c={c} collapsed={collapsed} onCollapsedChange={setCollapsed} />
      <Stage
        demo={demo}
        current={current}
        pinned={pinned}
        onCurrent={setCurrent}
        onPin={pin}
        onUnpin={(id) => setPinned((p) => p.filter((x) => x !== id))}
      />
    </>
  );
}

export function RailView() {
  const [demo, setDemo] = useState<Demo>("normal");
  return (
    <div className="rl-view">
      <div className="rl-demo">
        <span className="t-aux">状态对照</span>
        <Segmented
          size="sm"
          aria-label="状态对照"
          options={DEMOS}
          value={demo}
          onChange={setDemo}
        />
      </div>
      <div className="rl-frame">
        {/* key={demo}：切换状态时整块重置，各自从初始状态开始 */}
        <Demonstration key={demo} demo={demo} />
      </div>
    </div>
  );
}
