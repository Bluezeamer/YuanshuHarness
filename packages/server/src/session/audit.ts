import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AuditInput } from "../store/audit.js";

const TARGET_MAX = 160;

type ToolEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_end" }
>;

// 工具调用的审计内容：开始时只取命令或路径，write.content 等大字段与结果输出都不进审计。
export function toolAudit(
  e: ToolEvent,
): Pick<AuditInput, "summary" | "detail"> {
  if (e.type === "tool_execution_end")
    return {
      summary: `${e.toolName} ${e.isError ? "失败" : "完成"}`,
      detail: {
        op: e.toolName,
        result: e.isError ? "error" : "ok",
        toolCallId: e.toolCallId,
        isError: e.isError,
        ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
      },
    };
  const a = (e.args ?? {}) as Record<string, unknown>;
  const target = [a.command, a.path].find((v) => typeof v === "string") as
    | string
    | undefined;
  return {
    summary: target
      ? `${e.toolName} ${target.slice(0, TARGET_MAX)}`
      : e.toolName,
    detail: {
      op: e.toolName,
      ...(target ? { target: target.slice(0, TARGET_MAX) } : {}),
      toolCallId: e.toolCallId,
    },
  };
}
