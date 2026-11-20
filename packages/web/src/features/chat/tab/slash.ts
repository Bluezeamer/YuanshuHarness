// 斜杠菜单的候选项：内置命令、会话已加载技能、会话的 MCP 状态（只读提示）。纯函数。

import type { SessionContext } from "../../../api/flows";
import { BUILTIN_COMMANDS } from "../model/commands";

export type SlashGroup = "command" | "skill" | "mcp";

export const SLASH_GROUPS: readonly SlashGroup[] = ["command", "skill", "mcp"];

/** 分组的显示名（菜单里的组标题）。 */
export const SLASH_GROUP_LABEL: Record<SlashGroup, string> = {
  command: "命令",
  skill: "技能",
  mcp: "MCP",
};

export interface SlashOption {
  id: string;
  group: SlashGroup;
  label: string;
  hint: string;
  /** MCP 行：握手是否成功；其余为 undefined */
  ready?: boolean;
  /** 选中后做的事；没有就是只读提示行（MCP 名称与状态），不进键盘选择 */
  run?: () => void;
}

export function slashOptions(
  context: SessionContext | null,
  command: (name: string) => void,
): SlashOption[] {
  return [
    ...BUILTIN_COMMANDS.map(
      (c): SlashOption => ({
        id: c.name,
        group: "command",
        label: `/${c.name}`,
        hint: c.desc,
        run: () => command(c.name),
      }),
    ),
    ...(context?.skills ?? []).map(
      (s): SlashOption => ({
        id: `skill:${s.name}`,
        group: "skill",
        label: `/${s.name}`,
        hint: "技能",
        run: () => command(s.name),
      }),
    ),
    ...(context?.mcp ?? []).map(
      (m): SlashOption => ({
        id: `mcp:${m.name}`,
        group: "mcp",
        label: m.name,
        hint:
          m.state === "ready"
            ? `${m.tools} 个工具`
            : m.state === "disabled"
              ? "已停用"
              : m.state === "connecting"
                ? "连接中"
                : m.state === "pending"
                  ? "下一条消息时加载"
                  : (m.error ?? "启动失败"),
        ready: m.state === "ready",
      }),
    ),
  ];
}

/** 按输入过滤（匹配名称与说明，不分大小写）；query 已是小写。 */
export const filterSlash = (
  options: readonly SlashOption[],
  query: string,
): SlashOption[] =>
  query
    ? options.filter((o) =>
        `${o.label} ${o.hint}`.toLowerCase().includes(query),
      )
    : [...options];

/** 键盘能选的项（MCP 只读提示不算） */
export const pickable = (options: readonly SlashOption[]): SlashOption[] =>
  options.filter((o) => o.run !== undefined);
