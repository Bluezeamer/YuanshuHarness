// 可勾选的内置工具目录：SDK 的 7 个工具加 Server 自带的 directory 工具。
// ask_user 是会话与用户的交互通道，始终可用，不在目录里。
export interface ToolInfo {
  name: string;
  description: string;
  // 只读工具：plan 模式下放行。
  readOnly: boolean;
  // Server 自带（非 SDK）。
  server: boolean;
  // 设置页与能力勾选共用的分组。
  group: ToolGroupKey;
  // 始终可用、不进能力勾选的框架工具。
  framework?: boolean;
  // 固定规则的说明（只在不可调的框架工具上有）。
  note?: string;
}

// 键序即展示顺序。
export type ToolGroupKey =
  | "files"
  | "dirs"
  | "orchestrate"
  | "browser"
  | "devtools"
  | "framework";

export const TOOL_GROUPS: Record<ToolGroupKey, string> = {
  files: "文件与命令",
  dirs: "目录与传输",
  orchestrate: "编排与委派",
  browser: "浏览器",
  devtools: "开发调试",
  framework: "框架工具",
};

export const TOOLS: ToolInfo[] = [
  {
    name: "read",
    description: "读取文件",
    readOnly: true,
    server: false,
    group: "files",
  },
  {
    name: "grep",
    description: "按内容搜索",
    readOnly: true,
    server: false,
    group: "files",
  },
  {
    name: "find",
    description: "按名称查找文件",
    readOnly: true,
    server: false,
    group: "files",
  },
  {
    name: "ls",
    description: "列目录",
    readOnly: true,
    server: false,
    group: "files",
  },
  {
    name: "write",
    description: "写入文件",
    readOnly: false,
    server: false,
    group: "files",
  },
  {
    name: "edit",
    description: "编辑文件",
    readOnly: false,
    server: false,
    group: "files",
  },
  {
    name: "bash",
    description: "执行命令",
    readOnly: false,
    server: false,
    group: "files",
  },
  // 灵感画布（canvas.md §4 CV4）：写画布文件夹的唯一入口；读照旧用 read / grep / find / ls。
  {
    name: "canvas_edit",
    description: "编辑灵感画布：灵感卡与项目文件引用（只写 .canvas/）",
    readOnly: false,
    server: true,
    group: "files",
  },
  {
    name: "list_directories",
    description: "列出已登记的 directory",
    readOnly: true,
    server: true,
    group: "dirs",
  },
  {
    name: "switch_directory",
    description: "切换生效的 directory",
    readOnly: true,
    server: true,
    group: "dirs",
  },
  // 跨 directory 传文件（可跨主机）。会写目标端，plan 模式不放行。没有独立的规则矩阵行：
  // 源端按 read、目标端按 write 各自用所在 directory 的档位、规则与出厂规则判定（permission/extension.ts）。
  {
    name: "transfer_files",
    description: "在两个 directory 之间传输文件或目录（可跨主机）",
    readOnly: false,
    server: true,
    group: "dirs",
    note: "源端按 read、目标端按 write，各取所在目录的规则",
  },
  // 任务清单只写会话自己的状态，不碰环境；plan 模式下放行，也不走审批。
  {
    name: "todo_write",
    description: "更新任务清单（进度条据此显示）",
    readOnly: true,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  // 目标只写会话自己的状态（goal.md）：同样放行。
  {
    name: "get_goal",
    description: "读取当前目标与其状态",
    readOnly: true,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "create_goal",
    description: "给自己设一个需要多轮才能完成的目标",
    readOnly: true,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "update_goal",
    description: "改自己设的目标文本，或宣布完成 / 受阻",
    readOnly: true,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  // 子代理（subagent.md）：派发与联系。plan 模式下放行：子会话继承模式，不会因此多出写权限。
  // 后台任务 job_* 与交付 deliver 是框架工具，不在这里。
  {
    name: "spawn_subagent",
    description: "派发子代理（默认阻塞到它交付；也可放后台）",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  {
    name: "message_subagent",
    description: "对子代理追加一句话，或唤醒已交付的子代理",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  // 动态工作流（workflow.md）：脚本里的 agent() 是子代理，继承模式，同样不会因此多出写权限。
  {
    name: "workflow_run",
    description: "运行一段 JS 工作流，用脚本调度大量子代理",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  {
    name: "workflow_list",
    description: "列出可用的命名流程",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  // 团队（team.md）：成员是子代理，继承模式，同样不会因此多出写权限。post 是框架工具，不在这里。
  {
    name: "team_create",
    description: "建团队：一组有名字的成员并行工作，互发消息、共用公告板",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  {
    name: "team_update",
    description: "给团队加成员，或减掉没在运行的成员",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  {
    name: "team_stop",
    description: "停止整个团队或某个成员",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  {
    name: "team_status",
    description: "查看每个成员的状态、最新交付与公告板摘要",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  {
    name: "team_diff",
    description: "查看团队建队以来的整体改动，提交前验收用",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  {
    name: "team_disband",
    description: "解散团队",
    readOnly: true,
    server: true,
    group: "orchestrate",
  },
  // 浏览器（重做版）。不放行 plan 模式：打开网页是对外访问，页面操作会改变远端状态。
  {
    name: "browser_open",
    description: "在浏览器打开网页、本地文件或服务（外部站点需批准）",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_pages",
    description: "列出工作区里的浏览器页面",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_close",
    description: "关闭自己打开的页面",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_snapshot",
    description: "读取页面内容（清洗后的文字快照）",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_click",
    description: "点击页面元素或坐标",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_type",
    description: "在页面输入文字",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_press",
    description: "在页面上按键",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_dialog",
    description: "回答页面弹出的 alert / confirm / prompt 对话框",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_move",
    description: "移动鼠标到页面元素或坐标（hover）",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_scroll",
    description: "滚动页面",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_drag",
    description: "拖拽",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_nav",
    description: "页面后退、前进、刷新",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_screenshot",
    description: "截取页面画面",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_upload",
    description: "把本地文件上传到页面里的上传入口（每次需批准）",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_console",
    description: "读取页面的控制台与失败请求",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_assets",
    description: "列出并保存页面里的资源（图片、音视频等）",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_dom",
    description: "读取页面原始 DOM（快照读不到的属性与 HTML 原貌）",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_network",
    description: "查看页面的网络请求：列表、请求头与响应头、请求体与响应体",
    readOnly: false,
    server: true,
    group: "devtools",
  },
  {
    name: "browser_exec",
    description: "在页面里执行 JavaScript 并取回结果",
    readOnly: false,
    server: true,
    group: "devtools",
  },
  {
    name: "browser_storage",
    description: "读写 Cookie 与 localStorage / sessionStorage",
    readOnly: false,
    server: true,
    group: "devtools",
  },
  {
    name: "browser_request",
    description: "以页面的身份发 HTTP 请求并查看响应",
    readOnly: false,
    server: true,
    group: "devtools",
  },
  {
    name: "browser_route",
    description: "拦截并改写页面的网络请求（屏蔽、造假响应、改请求与响应）",
    readOnly: false,
    server: true,
    group: "devtools",
  },
  {
    name: "browser_emulate",
    description:
      "模拟页面的运行环境（弱网、离线、深色模式、UA、语言时区、关缓存）",
    readOnly: false,
    server: true,
    group: "devtools",
  },
  {
    name: "browser_cdp",
    description: "直接发 Chrome DevTools Protocol 命令",
    readOnly: false,
    server: true,
    group: "devtools",
  },
  {
    name: "browser_handoff",
    description: "请用户接管页面（登录、验证码等）",
    readOnly: false,
    server: true,
    group: "browser",
  },
  {
    name: "browser_show",
    description: "向用户展示一个页面（不阻塞，用户点「查看」才切过去）",
    readOnly: false,
    server: true,
    group: "browser",
  },
];

// 不在能力目录里的框架工具：始终可用、不进能力勾选，也不并进 TOOLS / TOOL_NAMES。
export const FRAMEWORK_TOOLS: ToolInfo[] = [
  {
    name: "ask_user",
    description: "向用户提问",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "call_tool",
    description: "包一层调用，内层照常审批",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "job_start",
    description: "把一个调用转到后台",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "job_list",
    description: "列出后台任务",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "job_stop",
    description: "停止后台任务",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "job_remind",
    description: "设置后台任务的提醒",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "deliver",
    description: "子代理交付结果（只在子代理会话里）",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "post",
    description: "团队消息（只在团队里）",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
    note: "自身放行",
  },
  {
    name: "switch_mode",
    description: "切换工作模式（会话有可用模式时才声明）",
    readOnly: false,
    server: true,
    group: "framework",
    framework: true,
  },
];

export const SUBAGENT_TOOL_NAMES = [
  "spawn_subagent",
  "message_subagent",
] as const;

export const TEAM_TOOL_NAMES = [
  "team_create",
  "team_update",
  "team_stop",
  "team_status",
  "team_diff",
  "team_disband",
] as const;

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
export const toolNames = (pick: (t: ToolInfo) => boolean): string[] =>
  TOOLS.filter(pick).map((t) => t.name);
