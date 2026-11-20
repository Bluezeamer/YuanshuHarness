import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type AttachmentRef, splitAttachmentMarkers } from "./attachments.js";

export interface ServerEvent {
  type: string;
  data: Record<string, unknown>;
}

export type ChatRole = "user" | "assistant";

// 助手消息里按出现顺序排列的内容块；工具块的 result/isError 来自后续的 toolResult。
export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      args: string;
      result?: string;
      isError?: boolean;
      // 嵌套调用（如 call_tool 转发的）：挂在父工具块内部，与父块同生命周期
      children?: {
        id: string;
        name: string;
        args?: string;
        result?: string;
        isError?: boolean;
        durationMs?: number;
      }[];
    };

export interface ChatMessage {
  role: ChatRole;
  text: string;
  // 消息时间（ISO 8601）：历史取会话条目的 timestamp，实时消息取到达时间。
  ts?: string;
  // 仅当含思考或工具调用时才有，纯文本消息不带。
  blocks?: Block[];
  // 用户消息里的附件引用；文本末尾的 `[attach_file]` 标记已从 text 剥离。
  attachments?: AttachmentRef[];
}

export const TOOL_ARGS_MAX = 2000;
export const TOOL_RESULT_MAX = 4000;

// 工具结果形如 { content: [{type:"text", text}] }；只取文本。
// 流式 partial 里 contentIndex 对应的工具调用块；start 时 id/name 已经确定。
function streamingToolCall(
  m: { content?: unknown } | undefined,
  index: number,
): { id: string; name: string } | null {
  const c = Array.isArray(m?.content) ? m.content[index] : undefined;
  if (!c || c.type !== "toolCall") return null;
  return { id: c.id, name: c.name };
}

const toolOutput = (r: unknown): string =>
  r && typeof r === "object"
    ? messageText((r as { content?: unknown }).content)
    : "";

// 实时输出保留末尾，最新的内容最有用。
const tailText = (t: string, max: number): string =>
  t.length <= max ? t : `…${t.slice(t.length - max)}`;

// 只有这两种角色属于对话；system、toolResult 等由别的事件或不下发。
// 历史投影（history.ts）按同一个判据数序位，两边的 afterIndex 才一致。
export const isChatRole = (role: unknown): role is ChatRole =>
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

export function blocksOf(content: unknown): Block[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: Block[] = [];
  let rich = false;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const x = b as Record<string, unknown>;
    if (x.type === "text")
      out.push({ type: "text", text: String(x.text ?? "") });
    else if (x.type === "thinking") {
      rich = true;
      out.push({ type: "thinking", text: String(x.thinking ?? "") });
    } else if (x.type === "toolCall") {
      rich = true;
      let args = "";
      try {
        args = JSON.stringify(x.arguments ?? {}, null, 2) ?? "";
      } catch {
        // 参数不可序列化时留空
      }
      out.push({
        type: "tool",
        id: String(x.id ?? ""),
        name: String(x.name ?? ""),
        args: cut(args, TOOL_ARGS_MAX),
      });
    }
  }
  return rich ? out : undefined;
}

export function toChatMessage(
  message: {
    role: string;
    content?: unknown;
  },
  ts?: string,
): ChatMessage | null {
  if (!isChatRole(message.role)) return null;
  const blocks =
    message.role === "assistant" ? blocksOf(message.content) : undefined;
  // 用户消息末尾的附件标记不进 text，改投影成 attachments。
  const parsed =
    message.role === "user"
      ? splitAttachmentMarkers(messageText(message.content))
      : { text: messageText(message.content), attachments: undefined };
  return {
    role: message.role,
    text: parsed.text,
    ...(ts === undefined ? {} : { ts }),
    ...(blocks ? { blocks } : {}),
    ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
  };
}

// 后台任务回调、目标卡片这类 custom 消息才能出卡片：其余 custom 消息（含没带快照的）一律不下发。
function noticeOf(
  message: { role?: unknown; customType?: unknown; details?: unknown },
  ts: string,
): ServerEvent | null {
  if (message.role !== "custom") return null;
  const details = message.details as
    | { job?: unknown; goal?: unknown }
    | undefined;
  if (message.customType === "yuanshu.subagent") {
    const job = details?.job;
    if (typeof job !== "object" || job === null || Array.isArray(job))
      return null;
    return { type: "notice", data: { kind: "job", job, ts } };
  }
  if (message.customType === "yuanshu.goal") {
    const goal = details?.goal;
    if (typeof goal !== "object" || goal === null || Array.isArray(goal))
      return null;
    return { type: "notice", data: { kind: "goal", goal, ts } };
  }
  return null;
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
      // SDK 的事件不带消息时间：实时消息以落定（message_end）到达的时间为准。
      const ts =
        e.type === "message_end" ? new Date().toISOString() : undefined;
      const m = toChatMessage(e.message, ts);
      if (!m) {
        // 后台任务回调、目标注入 / 卡片：消息带快照时单独发一帧，界面据此在对话流里放卡片。
        // 它到达的这一刻正是这条消息进入对话序列的位置，与历史接口的 afterIndex 同口径。
        const notice =
          e.type === "message_end" ? noticeOf(e.message, ts ?? "") : null;
        return notice;
      }
      return {
        type: e.type === "message_start" ? "message.started" : "message.ended",
        data: { ...m },
      };
    }
    case "message_update": {
      const ev = e.assistantMessageEvent;
      // 工具参数是逐块流式生成的：把 id/name 与增量下发，界面才能在工具执行前看到内容。
      if (ev.type === "toolcall_start" || ev.type === "toolcall_delta") {
        const tc = streamingToolCall(ev.partial, ev.contentIndex);
        return {
          type: "message.delta",
          data: {
            kind: ev.type === "toolcall_start" ? "toolstart" : "toolarg",
            ...(tc ? { toolCallId: tc.id, toolName: tc.name } : {}),
            text: ev.type === "toolcall_delta" ? ev.delta : "",
          },
        };
      }
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
        data: {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
          // 有值 = 另一工具（如 call_tool）发起的调用，前端据此嵌套而不是并列
          ...(e.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: e.parentToolCallId }),
        },
      };
    case "tool_execution_update":
      return {
        type: "tool.updated",
        data: {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          output: tailText(toolOutput(e.partialResult), TOOL_RESULT_MAX),
          ...(e.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: e.parentToolCallId }),
        },
      };
    case "tool_execution_end":
      return {
        type: "tool.ended",
        data: {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          output: tailText(toolOutput(e.result), TOOL_RESULT_MAX),
          isError: e.isError,
          ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
          ...(e.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: e.parentToolCallId }),
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

export const FRAME_DATA_MAX = 1024 * 1024;
// 留出信封与 truncated 标记的余量，使最终线上 data 不超过 FRAME_DATA_MAX。
const DATA_BUDGET = FRAME_DATA_MAX - 1024;
export const MAX_ID = 256;
export const MAX_QUEUE_ITEMS = 100;
export const MAX_QUEUE_ITEM = 512;
export const MAX_ACTIVE_TOOLS = 100;

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
    if (text !== undefined && Buffer.byteLength(text) <= DATA_BUDGET) {
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
