import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface ServerEvent {
  type: string;
  data: Record<string, unknown>;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  text: string;
}

// 只有这两种角色属于对话；system、toolResult 等由别的事件或不下发。
const isChatRole = (role: unknown): role is ChatRole =>
  role === "user" || role === "assistant";

// 拼接文本块；图片、思考、工具调用块都不进 text。
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: unknown }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

export function toChatMessage(message: {
  role: string;
  content?: unknown;
}): ChatMessage | null {
  return isChatRole(message.role)
    ? { role: message.role, text: messageText(message.content) }
    : null;
}

// 纯映射。表外的事件返回 null，不下发。
export function mapEvent(e: AgentSessionEvent): ServerEvent | null {
  switch (e.type) {
    case "agent_start":
      return { type: "run.started", data: {} };
    case "agent_settled":
      return { type: "run.ended", data: { aborted: e.aborted } };
    case "message_start":
    case "message_end": {
      const m = toChatMessage(e.message);
      if (!m) return null;
      return {
        type: e.type === "message_start" ? "message.started" : "message.ended",
        data: { ...m },
      };
    }
    case "message_update": {
      const ev = e.assistantMessageEvent;
      if (ev.type === "text_delta")
        return {
          type: "message.delta",
          data: { kind: "text", text: ev.delta },
        };
      if (ev.type === "thinking_delta")
        return {
          type: "message.delta",
          data: { kind: "thinking", text: ev.delta },
        };
      return null;
    }
    case "tool_execution_start":
      return {
        type: "tool.started",
        data: { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args },
      };
    case "tool_execution_update":
      return {
        type: "tool.updated",
        data: {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          partialResult: e.partialResult,
        },
      };
    case "tool_execution_end":
      return {
        type: "tool.ended",
        data: {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          result: e.result,
          isError: e.isError,
          ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
        },
      };
    case "queue_update":
      return {
        type: "queue.updated",
        data: { queue: [...e.steering, ...e.followUp] },
      };
    default:
      return null;
  }
}

export const EVENT_STRING_MAX = 256 * 1024;
export const SNAPSHOT_MESSAGE_MAX = 32 * 1024;
const MAX_DEPTH = 8;

// 递归截断过长的字符串（按 UTF-16 长度，足够限制量级），截断处不加标记字符，
// 由调用方在 data 顶层加 truncated: true。返回是否发生过截断。
export function boundStrings<T>(
  value: T,
  max: number,
): { value: T; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      if (v.length <= max) return v;
      truncated = true;
      return v.slice(0, max);
    }
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return null;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  return { value: walk(value, 0) as T, truncated };
}
