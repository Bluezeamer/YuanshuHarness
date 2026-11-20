// 输入框文本到动作的纯解析。/goal、/compact 走各自的会话命令，/mcp 与 /reload 是界面自己的动作，
// 其余以 / 开头的文本（/plan、/review、/<技能名>、路径……）都当普通消息发给模型。

export type Command =
  | { kind: "goal"; text: string }
  | { kind: "goal-edit"; text: string }
  | { kind: "goal-control"; action: "pause" | "resume" | "clear" }
  | { kind: "compact" }
  | { kind: "mcp" }
  | { kind: "reload" }
  | { kind: "message"; text: string }
  | { kind: "error"; message: string };

// 输入框的斜杠菜单用：内置指令与说明（技能名由界面从技能列表补）。
export const BUILTIN_COMMANDS: readonly {
  name: string;
  hint: string;
  desc: string;
}[] = [
  {
    name: "goal",
    hint: "<目标> | pause | resume | clear | edit <目标>",
    desc: "设定长期目标，agent 会自己续跑到完成",
  },
  { name: "compact", hint: "", desc: "压缩上下文，保留摘要" },
  { name: "mcp", hint: "", desc: "查看 MCP 服务的连接状态" },
  { name: "reload", hint: "", desc: "重载 MCP 与主机环境（装好依赖后用）" },
  { name: "plan", hint: "<任务>", desc: "先出计划再动手" },
  { name: "review", hint: "", desc: "审查当前改动" },
];

const SLASH = /^\/(\S+)(?:\s+([\s\S]*))?$/;

const GOAL_CONTROLS = ["pause", "resume", "clear"] as const;
const GOAL_EDIT = /^edit(?:\s+([\s\S]*))?$/i;

// pause / resume / clear 要独占整行才是控制词，其余一律当目标文本。
function parseGoal(rest: string): Command {
  if (!rest)
    return {
      kind: "error",
      message: "在 /goal 后写目标，或 pause / resume / clear / edit <目标>",
    };
  const control = GOAL_CONTROLS.find((c) => c === rest.toLowerCase());
  if (control) return { kind: "goal-control", action: control };
  const edit = GOAL_EDIT.exec(rest);
  if (edit)
    return edit[1]?.trim()
      ? { kind: "goal-edit", text: edit[1].trim() }
      : { kind: "error", message: "在 /goal edit 后写新的目标" };
  return { kind: "goal", text: rest };
}

export function parseInput(input: string): Command {
  const text = input.trim();
  const m = SLASH.exec(text);
  if (!m) return { kind: "message", text };
  const name = (m[1] ?? "").toLowerCase();
  const rest = (m[2] ?? "").trim();
  if (name === "goal") return parseGoal(rest);
  if (name === "compact")
    return rest
      ? { kind: "error", message: "/compact 不接受参数" }
      : { kind: "compact" };
  if (name === "mcp" || name === "reload")
    return rest
      ? { kind: "error", message: `/${name} 不接受参数` }
      : { kind: name };
  return { kind: "message", text };
}
