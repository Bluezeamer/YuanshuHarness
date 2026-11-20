import { TabStrip } from "../../../ui";
import { ChatIcon, FileIcon, TerminalIcon } from "../../../ui/icons";
import { WORKSPACES } from "./data";
import type { Demo } from "./useDemoRail";

const TITLES = new Map(
  WORKSPACES.flatMap((w) => w.sessions).map((s) => [s.id, s.title]),
);

// 右侧的工作区主体：只为让左轨有个上下文。标签条就是「我在看」的来源：
// 固定的会话各占一个标签，单击替换的临时会话是最后一个斜体标签。
export function Stage({
  demo,
  current,
  pinned,
  onCurrent,
  onPin,
  onUnpin,
}: {
  demo: Demo;
  current: string;
  pinned: readonly string[];
  onCurrent(id: string): void;
  onPin(id: string): void;
  onUnpin(id: string): void;
}) {
  const temp = pinned.includes(current) ? [] : [current];
  const tabs = [...pinned, ...temp].map((id) => ({
    id,
    title: TITLES.get(id) ?? id,
    icon: <ChatIcon />,
    temp: temp.includes(id),
    closable: true,
  }));
  return (
    <div className="rl-stage">
      <div className="rl-panes">
        <div className="rl-pane">
          <TabStrip
            aria-label="对话标签"
            tabs={tabs}
            value={current}
            onChange={onCurrent}
            onPin={onPin}
            onClose={onUnpin}
            onAdd={() => {}}
            addLabel="新建标签"
          />
          <div className="rl-pane-body">
            <div className="t-block">{TITLES.get(current)}</div>
            <div className="t-aux">
              对话区（样张里留空）。单击左轨的会话，替换这里的临时标签；双击，固定成常驻标签。
            </div>
          </div>
        </div>
        <div
          className="rl-pane"
          data-drop={demo === "drag-session" || undefined}
        >
          <TabStrip
            aria-label="工具标签"
            tabs={[
              { id: "term", title: "终端", icon: <TerminalIcon /> },
              { id: "files", title: "文件", icon: <FileIcon /> },
            ]}
            value="term"
            onChange={() => {}}
          />
          <div className="rl-pane-body">
            <div className="t-aux">终端 / 文件窗格（样张里留空）。</div>
          </div>
          {demo === "drag-session" && (
            <div className="rl-dz" aria-hidden="true">
              <span className="t-entry">松开 · 并入这个窗格</span>
            </div>
          )}
        </div>
      </div>
      {demo === "drag-session" && (
        <div className="rl-ghost t-entry" aria-hidden="true">
          修复 biome 报错
        </div>
      )}
      {demo === "drag-ws" && (
        <div className="rl-ghost t-entry" data-ws aria-hidden="true">
          gpu-box
        </div>
      )}
    </div>
  );
}
