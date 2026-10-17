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

export const FRAME_DATA_MAX = 1024 * 1024;
const MAX_ITEMS = 200;
const MAX_KEY = 256;

// 按 UTF-16 截断，但不留下被切开的代理对。
function cut(v: string, max: number): string {
  let end = max;
  const last = v.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return v.slice(0, end);
}

// 递归限制字符串长度、数组与对象的宽度、嵌套深度；Buffer 等非普通对象不展开。
// 返回是否发生过截断，由调用方在 data 顶层加 truncated: true。
export function boundStrings<T>(
  value: T,
  max: number,
): { value: T; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      if (v.length <= max) return v;
      truncated = true;
      return cut(v, max);
    }
    if (typeof v === "bigint") return String(v);
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return null;
    }
    if (Array.isArray(v)) {
      if (v.length > MAX_ITEMS) truncated = true;
      return v.slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1));
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      truncated = true;
      return null;
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const k in v) {
      if (n++ >= MAX_ITEMS) {
        truncated = true;
        break;
      }
      const key =
        k.length > MAX_KEY ? ((truncated = true), cut(k, MAX_KEY)) : k;
      out[key] = walk((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  };
  return { value: walk(value, 0) as T, truncated };
}

// 最后一道保险：宽度与长度各自有界，乘起来仍可能很大；序列化后超过上限就只留短的标量字段。
export function capFrameData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  let size: number;
  try {
    size = JSON.stringify(data).length;
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  if (size <= FRAME_DATA_MAX) return data;
  const out: Record<string, unknown> = { truncated: true, omitted: true };
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= MAX_KEY) out[k] = v;
  }
  return out;
}
