// 会话模式（ADR-0009）：build 为完整工具集，plan 只读。工具定义不动，plan 下的写/执行调用在执行层拦截。
// 排在权限扩展之前：模式是上限，权限档位（含 full）越不过它。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { toolNames } from "../session/tool-catalog.js";

export const MODES = ["build", "plan"] as const;
export type Mode = (typeof MODES)[number];

export const isMode = (v: unknown): v is Mode =>
  (MODES as readonly string[]).includes(v as string);

// 只读工具加 ask_user；MCP 等未知工具无法确认只读，一律不放行。
const PLAN_ALLOWED = new Set([...toolNames((t) => t.readOnly), "ask_user"]);

export const PLAN_PROMPT = `当前处于 plan 模式：只能读取与分析，不能写入文件或执行命令（write、edit、bash 等调用会被拒绝，提示「当前模式下不可用」）。
请调研现状、给出分步方案；需要改动时说明要改什么、为什么，交由用户决定。`;

export const modePrompt = (mode: Mode): string | null =>
  mode === "plan" ? PLAN_PROMPT : null;

export function modeExtension(mode: Mode): ExtensionFactory {
  return (pi) => {
    if (mode === "build") return;
    pi.on("tool_call", (e) => {
      if (PLAN_ALLOWED.has(e.toolName)) return;
      return {
        block: true,
        reason: `当前模式下不可用：plan 模式只读，${e.toolName} 不能调用`,
      };
    });
  };
}
