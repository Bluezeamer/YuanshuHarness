import { registerSubTab } from "../../features/chat/exec";
import { registerJobTab } from "../../features/chat/job";
import { registerChatTab } from "../../features/chat/tab";
import { registerTerminalTab } from "../../features/workspace";
import { registerCanvasTab } from "../../features/workspace/tabs/canvas";
import { registerFilesTab } from "../../features/workspace/tabs/files";
import { registerPreviewTab } from "../../features/workspace/tabs/preview";
import { registerWebTab } from "../../features/workspace/tabs/web";

// 启动时把各标签类型的真实渲染器注册进注册表（注册表默认是占位）。幂等：重复调用只是覆盖同一份。
export function registerAllTabs(): void {
  registerChatTab();
  registerSubTab();
  registerJobTab();
  registerTerminalTab();
  registerFilesTab();
  registerPreviewTab();
  registerWebTab();
  registerCanvasTab();
}
