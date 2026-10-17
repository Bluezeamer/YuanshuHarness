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
        data: {
          queue: [...e.steering, ...e.followUp]
            .slice(0, MAX_QUEUE_ITEMS)
            .map((q) => cut(q, MAX_QUEUE_ITEM)),
        },
      };
    default:
      return null;
  }
}

export const EVENT_STRING_MAX = 256 * 1024;
export const SNAPSHOT_MESSAGE_MAX = 32 * 1024;
const MAX_DEPTH = 8;

export const FRAME_DATA_MAX = 1024 * 1024;
export const MAX_ID = 256;
export const MAX_QUEUE_ITEMS = 100;
export const MAX_QUEUE_ITEM = 1024;
export const MAX_ACTIVE_TOOLS = 200;

// 按 UTF-16 截断，但不留下被切开的代理对。
export function cut(v: string, max: number): string {
  if (v.length <= max) return v;
  let end = max;
  const last = v.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return v.slice(0, end);
}

// 把任意 SDK 载荷变成可上线的普通 JSON 数据：
// 一次序列化（toJSON、getter、循环引用、BigInt 都在 try 里处理），字符串按 maxString 截断，
// 并以真实 UTF-8 字节数判断整体上限；失败或超限就只留短的标量字段。
// 事件广播与状态累积都用返回值，所以两者必然一致。
export function sanitizeData(
  raw: Record<string, unknown>,
  maxString: number,
): Record<string, unknown> {
  let truncated = false;
  try {
    const text = JSON.stringify(raw, (_k, v: unknown) => {
      if (typeof v === "bigint") v = v.toString();
      if (typeof v === "string" && v.length > maxString) {
        truncated = true;
        return cut(v, maxString);
      }
      return v;
    });
    if (text !== undefined && Buffer.byteLength(text) <= FRAME_DATA_MAX) {
      const data = JSON.parse(text) as Record<string, unknown>;
      return truncated ? { ...data, truncated: true } : data;
    }
  } catch {
    // 落到下面的兜底
  }
  const out: Record<string, unknown> = { truncated: true, omitted: true };
  try {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" || typeof v === "boolean") out[k] = v;
      else if (typeof v === "string" && v.length <= MAX_ID) out[k] = v;
    }
  } catch {
    // 连读取字段都会抛错：只留标记
  }
  return out;
}
