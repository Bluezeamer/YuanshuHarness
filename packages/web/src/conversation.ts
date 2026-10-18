import type { Known } from "./history";

export interface Frame {
  session: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export interface Tool {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
}

export interface ConvState {
  messages: Known[];
  partial: string | null;
  tools: Tool[];
  running: boolean;
  queue: string[];
  error: string | null;
}

export const initial: ConvState = {
  messages: [],
  partial: null,
  tools: [],
  running: false,
  queue: [],
  error: null,
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const role = (v: unknown): "user" | "assistant" | null =>
  v === "user" || v === "assistant" ? v : null;

// 快照整体替换状态；其余帧按增量套用。未识别的帧原样忽略，协议新增帧不会让界面崩。
export function reduce(s: ConvState, f: Frame): ConvState {
  const d = f.data;
  switch (f.type) {
    case "snapshot": {
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      const active = Array.isArray(d.activeTools) ? d.activeTools : [];
      const p = d.partial as { text?: unknown } | null | undefined;
      return {
        messages: msgs.flatMap((m: { role?: unknown; text?: unknown }) => {
          const r = role(m?.role);
          return r ? [{ role: r, text: str(m.text) }] : [];
        }),
        partial: p && typeof p === "object" ? str(p.text) : null,
        tools: active.map(
          (t: { toolCallId?: unknown; toolName?: unknown }) => ({
            id: str(t?.toolCallId),
            name: str(t?.toolName),
            status: "running" as const,
          }),
        ),
        running: d.running === true,
        queue: Array.isArray(d.queue) ? d.queue.map(str) : [],
        error: null,
      };
    }
    case "message.started":
      return role(d.role) === "assistant" ? { ...s, partial: "" } : s;
    case "message.delta":
      return d.kind === "text" && s.partial !== null
        ? { ...s, partial: s.partial + str(d.text) }
        : s;
    case "message.ended": {
      const r = role(d.role);
      if (!r) return s;
      return {
        ...s,
        partial: r === "assistant" ? null : s.partial,
        messages: [...s.messages, { role: r, text: str(d.text) }],
      };
    }
    case "tool.started":
      return {
        ...s,
        tools: [
          ...s.tools.filter((t) => t.id !== str(d.toolCallId)),
          { id: str(d.toolCallId), name: str(d.toolName), status: "running" },
        ],
      };
    case "tool.ended":
      return {
        ...s,
        tools: s.tools.map((t) =>
          t.id === str(d.toolCallId)
            ? { ...t, status: d.isError === true ? "error" : "ok" }
            : t,
        ),
      };
    case "run.started":
      return { ...s, running: true, error: null };
    case "run.ended":
      return { ...s, running: false, partial: null };
    case "run.failed":
      return { ...s, error: str(d.message) || "运行失败" };
    case "queue.updated":
      return {
        ...s,
        queue: Array.isArray(d.queue) ? d.queue.map(str) : s.queue,
      };
    default:
      return s;
  }
}
