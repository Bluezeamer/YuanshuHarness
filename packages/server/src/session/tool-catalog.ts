// 可勾选的内置工具目录：SDK 的 7 个工具加 Server 自带的 workspace 工具。
// ask_user 是会话与用户的交互通道，始终可用，不在目录里。
export interface ToolInfo {
  name: string;
  description: string;
  // 只读工具：plan 模式下放行。
  readOnly: boolean;
  // Server 自带（非 SDK）。
  server: boolean;
}

export const TOOLS: ToolInfo[] = [
  { name: "read", description: "读取文件", readOnly: true, server: false },
  { name: "grep", description: "按内容搜索", readOnly: true, server: false },
  {
    name: "find",
    description: "按名称查找文件",
    readOnly: true,
    server: false,
  },
  { name: "ls", description: "列目录", readOnly: true, server: false },
  { name: "write", description: "写入文件", readOnly: false, server: false },
  { name: "edit", description: "编辑文件", readOnly: false, server: false },
  { name: "bash", description: "执行命令", readOnly: false, server: false },
  {
    name: "list_workspaces",
    description: "列出已登记的 workspace",
    readOnly: true,
    server: true,
  },
  {
    name: "switch_workspace",
    description: "切换生效的 workspace",
    readOnly: true,
    server: true,
  },
  // subagent 三件套（ADR-0010、ADR-0060）。plan 模式下放行：子会话继承 plan，不会因此多出写权限。
  {
    name: "spawn_subagent",
    description: "派发子代理（异步，返回子会话 id）",
    readOnly: true,
    server: true,
  },
  {
    name: "wait_subagent",
    description: "等待子代理完成并取回结果",
    readOnly: true,
    server: true,
  },
  {
    name: "interrupt_subagent",
    description: "中断运行中的子代理",
    readOnly: true,
    server: true,
  },
  // 侧边浏览器（ADR-0081）。不放行 plan 模式：打开网页是对外访问，页面操作会改变远端状态。
  {
    name: "browser_open",
    description: "在侧边浏览器打开网页（需批准站点）",
    readOnly: false,
    server: true,
  },
  {
    name: "browser_snapshot",
    description: "读取侧边浏览器当前页面",
    readOnly: false,
    server: true,
  },
  {
    name: "browser_click",
    description: "点击页面元素",
    readOnly: false,
    server: true,
  },
  {
    name: "browser_type",
    description: "在页面输入文字",
    readOnly: false,
    server: true,
  },
  {
    name: "browser_screenshot",
    description: "截取页面画面",
    readOnly: false,
    server: true,
  },
];

export const SUBAGENT_TOOL_NAMES = [
  "spawn_subagent",
  "wait_subagent",
  "interrupt_subagent",
] as const;

// 只作用于已打开页面的浏览器工具：站点已在 browser_open 时审批过，这里不再单独审批。
export const BROWSER_FOLLOWUP_TOOL_NAMES = [
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_screenshot",
] as const;

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
export const toolNames = (pick: (t: ToolInfo) => boolean): string[] =>
  TOOLS.filter(pick).map((t) => t.name);
