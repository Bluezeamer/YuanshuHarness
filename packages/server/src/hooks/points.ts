// hook 点位表（ADR-0085）：校验、matcher 取值、UI 表单与试跑样例载荷都从这里出。

export const POINT_IDS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "ApprovalRequested",
  "ApprovalResolved",
  "SubagentStart",
] as const;
export type PointId = (typeof POINT_IDS)[number];

export interface PointInfo {
  id: PointId;
  label: string;
  description: string;
  /** 阻断类：退出码 2 / decision:block 会拦住操作。 */
  blocking: boolean;
  /** matcher 匹配载荷里的哪个字段；null = 该点位没有 matcher。 */
  matchField: "tool_name" | "source" | null;
  /** 试跑用的样例载荷（不含公共字段，由调用方补）。 */
  sample: Record<string, unknown>;
}

export const POINTS: readonly PointInfo[] = [
  {
    id: "PreToolUse",
    label: "工具调用前",
    description: "模型发起工具调用、权限判定之前。可阻断，可改写工具输入。",
    blocking: true,
    matchField: "tool_name",
    sample: {
      tool_name: "bash",
      tool_input: { command: "echo hello" },
      tool_use_id: "call_sample",
    },
  },
  {
    id: "PostToolUse",
    label: "工具调用后",
    description: "工具执行完成后。可追加上下文或反馈给模型。",
    blocking: false,
    matchField: "tool_name",
    sample: {
      tool_name: "bash",
      tool_input: { command: "echo hello" },
      tool_response: { text: "hello", is_error: false },
      tool_use_id: "call_sample",
    },
  },
  {
    id: "UserPromptSubmit",
    label: "提交 prompt 前",
    description: "用户消息交给模型之前。可阻断，可追加上下文。",
    blocking: true,
    matchField: null,
    sample: { prompt: "帮我看一下这个目录" },
  },
  {
    id: "Stop",
    label: "运行结束",
    description: "一次运行完全结束后（含重试与续接）。只观察。",
    blocking: false,
    matchField: null,
    sample: { aborted: false },
  },
  {
    id: "SessionStart",
    label: "会话开始",
    description: "会话创建或从磁盘恢复后。只观察。",
    blocking: false,
    matchField: "source",
    sample: { source: "new" },
  },
  {
    id: "ApprovalRequested",
    label: "审批出现",
    description: "权限审批弹窗出现时。只观察，不能裁决。",
    blocking: false,
    matchField: "tool_name",
    sample: { tool_name: "bash", summary: "rm -rf ./build" },
  },
  {
    id: "ApprovalResolved",
    label: "审批有结论",
    description: "审批被用户、自动审核或超时裁决后。只观察。",
    blocking: false,
    matchField: "tool_name",
    sample: {
      tool_name: "bash",
      decision: "allow",
      by: "user",
      summary: "rm -rf ./build",
    },
  },
  {
    id: "SubagentStart",
    label: "子代理派发",
    description: "子会话创建后。只观察。",
    blocking: false,
    matchField: null,
    sample: {
      child_id: "00000000-0000-7000-8000-000000000000",
      task: "示例任务",
      depth: 1,
    },
  },
];

const BY_ID = new Map(POINTS.map((p) => [p.id, p]));

export const pointInfo = (id: string): PointInfo | undefined =>
  BY_ID.get(id as PointId);

const SIMPLE_RE = /^[A-Za-z0-9_|]+$/;

/** 写入时的校验：返回问题说明，合法返回 null。 */
export function matcherProblem(matcher: string): string | null {
  if (matcher === "" || matcher === "*" || SIMPLE_RE.test(matcher)) return null;
  try {
    new RegExp(matcher);
    return null;
  } catch (err) {
    return `matcher 不是合法的正则：${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 空串或 * 匹配全部；仅字母数字下划线与 | 时按名单精确匹配；其余按正则（不加锚）。 */
export function matches(matcher: string, target: string | undefined): boolean {
  if (matcher === "" || matcher === "*") return true;
  if (target === undefined) return false;
  if (SIMPLE_RE.test(matcher)) return matcher.split("|").includes(target);
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return false;
  }
}
