import "./workspace.css";
import "./workspace.pane.css";

export { beginDrag, endDrag } from "./layout/drag";
export type { TabDef, TabRenderProps } from "./tabs/registry";
export { getTabDef, registerTab } from "./tabs/registry";
export { sweepStaleTabViews } from "./tabs/tabView";
export { registerTerminalTab } from "./tabs/terminal/wiring";
export { WorkspacePage } from "./WorkspacePage";
