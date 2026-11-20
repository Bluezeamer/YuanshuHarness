// 内置工具的出厂规则矩阵：cwd 内 / cwd 外 × 放行 / 审批（没有「禁止」：不想让模型用就去掉这项能力）。
// 矩阵只管「按路径落点分档」这一条轴；敏感路径、解释器前缀不可记住、root shell、sudo、
// 隐私变量范围这类不对等的约束是不变式，不进矩阵，也不会被「放行」绕过（见 decide.ts）。
export const POLICIES = ["allow", "ask"] as const;
export type Policy = (typeof POLICIES)[number];
export const isPolicy = (v: unknown): v is Policy =>
  typeof v === "string" && (POLICIES as readonly string[]).includes(v);

export interface ToolPolicy {
  inside: Policy;
  outside: Policy;
}

export interface MatrixTool {
  name: string;
  /** path 按 cwd 内外各一档；flat 只有一个开关（两格恒相等）。 */
  kind: "path" | "flat";
  factory: ToolPolicy;
}

const FILE_TOOL: ToolPolicy = { inside: "allow", outside: "ask" };
const ASK_BOTH: ToolPolicy = { inside: "ask", outside: "ask" };
// 单开关工具：存储仍用两列，但两格恒相等。
const flat = (policy: Policy): ToolPolicy => ({
  inside: policy,
  outside: policy,
});

export const MATRIX_TOOLS: readonly MatrixTool[] = [
  // 按路径落点分档的文件与命令工具。
  { name: "read", kind: "path", factory: FILE_TOOL },
  { name: "grep", kind: "path", factory: FILE_TOOL },
  { name: "find", kind: "path", factory: FILE_TOOL },
  { name: "ls", kind: "path", factory: FILE_TOOL },
  { name: "write", kind: "path", factory: FILE_TOOL },
  { name: "edit", kind: "path", factory: FILE_TOOL },
  { name: "bash", kind: "path", factory: ASK_BOTH },
  // 灵感画布（canvas.md §4）：只写 `.canvas/`，等价于 cwd 内的文件写入，所以单开关放行。
  { name: "canvas_edit", kind: "flat", factory: flat("allow") },
  // 目录与传输：落点由 directory 决定，不按 cwd 分档。
  { name: "list_directories", kind: "flat", factory: flat("allow") },
  { name: "switch_directory", kind: "flat", factory: flat("ask") },
  // 编排与委派：子代理、团队、工作流继承父会话的模式，派发本身不看路径。
  { name: "spawn_subagent", kind: "flat", factory: flat("allow") },
  { name: "message_subagent", kind: "flat", factory: flat("allow") },
  { name: "workflow_list", kind: "flat", factory: flat("allow") },
  { name: "workflow_run", kind: "flat", factory: flat("ask") },
  { name: "team_create", kind: "flat", factory: flat("allow") },
  { name: "team_update", kind: "flat", factory: flat("allow") },
  { name: "team_stop", kind: "flat", factory: flat("allow") },
  { name: "team_status", kind: "flat", factory: flat("allow") },
  { name: "team_diff", kind: "flat", factory: flat("allow") },
  { name: "team_disband", kind: "flat", factory: flat("allow") },
  // 浏览器：外部站点由 browser_open 自己审批（按工作区记住），高敏感站点的逐动作确认在工具里；其余只作用于已打开的页面。
  { name: "browser_open", kind: "flat", factory: flat("ask") },
  { name: "browser_pages", kind: "flat", factory: flat("allow") },
  { name: "browser_close", kind: "flat", factory: flat("allow") },
  { name: "browser_snapshot", kind: "flat", factory: flat("allow") },
  { name: "browser_click", kind: "flat", factory: flat("allow") },
  { name: "browser_type", kind: "flat", factory: flat("allow") },
  { name: "browser_press", kind: "flat", factory: flat("allow") },
  { name: "browser_dialog", kind: "flat", factory: flat("allow") },
  { name: "browser_move", kind: "flat", factory: flat("allow") },
  { name: "browser_scroll", kind: "flat", factory: flat("allow") },
  { name: "browser_drag", kind: "flat", factory: flat("allow") },
  { name: "browser_nav", kind: "flat", factory: flat("allow") },
  { name: "browser_screenshot", kind: "flat", factory: flat("allow") },
  // 上传是把本地文件交给外部站点：默认每次问，卡片由工具自己出（目标站点取自页面真实地址）。
  { name: "browser_upload", kind: "flat", factory: flat("ask") },
  { name: "browser_console", kind: "flat", factory: flat("allow") },
  { name: "browser_assets", kind: "flat", factory: flat("allow") },
  { name: "browser_dom", kind: "flat", factory: flat("allow") },
  { name: "browser_network", kind: "flat", factory: flat("allow") },
  // 开发调试组：开启这组的人已经表了态，所以出厂放行（高敏感站点的逐动作确认在工具里）。
  { name: "browser_exec", kind: "flat", factory: flat("allow") },
  { name: "browser_storage", kind: "flat", factory: flat("allow") },
  { name: "browser_request", kind: "flat", factory: flat("allow") },
  { name: "browser_route", kind: "flat", factory: flat("allow") },
  { name: "browser_emulate", kind: "flat", factory: flat("allow") },
  { name: "browser_cdp", kind: "flat", factory: flat("allow") },
  { name: "browser_handoff", kind: "flat", factory: flat("allow") },
  { name: "browser_show", kind: "flat", factory: flat("allow") },
  // 模式能增加基线外的工具：真切换默认要人批。
  { name: "switch_mode", kind: "flat", factory: flat("ask") },
];

export const matrixTool = (name: string): MatrixTool | undefined =>
  MATRIX_TOOLS.find((t) => t.name === name);

/** 单开关工具（不按 cwd 分档）。 */
export const isFlatTool = (name: string): boolean =>
  matrixTool(name)?.kind === "flat";

/** decide 在没有传入矩阵时的缺省：文件类工具内放行外审批，命令类内外都审批。 */
export const DEFAULT_PATH_POLICY: ToolPolicy = FILE_TOOL;
export const DEFAULT_COMMAND_POLICY: ToolPolicy = ASK_BOTH;
