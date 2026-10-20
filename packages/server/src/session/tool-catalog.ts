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
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
export const toolNames = (pick: (t: ToolInfo) => boolean): string[] =>
  TOOLS.filter(pick).map((t) => t.name);
