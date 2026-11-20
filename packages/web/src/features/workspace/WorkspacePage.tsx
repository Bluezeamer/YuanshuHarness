// 工作区页：当前工作区的窗口条 + 窗格树。
// 不含左轨；需要在 <LayoutProvider> 里渲染（Shell 负责提供）。

import { Empty } from "../../ui";
import { L2View } from "./layout/L2View";
import { useLibraryState } from "./library/LibraryProvider";
import { TerminalGuardProvider } from "./tabs/terminal/wiring";
import { useBrowserAutoTab } from "./useBrowserAutoTab";
import { useBrowserShow } from "./useBrowserShow";

export function WorkspacePage() {
  useBrowserAutoTab();
  useBrowserShow();
  // 一个工作区都没有时布局永远载入不了，别让「正在准备窗口」转个不停
  const empty = useLibraryState((s) => s.ready && s.workspaces.length === 0);
  return (
    <TerminalGuardProvider>
      <div className="ws-main">
        {empty ? (
          <div className="ws-wnwrap">
            <Empty
              compact
              title="还没有工作区"
              description="先在左侧新建一个工作区，对话、文件和终端都放在里面。"
            />
          </div>
        ) : (
          <L2View />
        )}
      </div>
    </TerminalGuardProvider>
  );
}
