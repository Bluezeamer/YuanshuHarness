import type { Block, Known } from "./history";

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

export interface PromptOption {
  id: string;
  label: string;
}

// prompt.requested.data 的客户端视图（ADR-0028）。
export interface Prompt {
  promptId: string;
  source: "approval" | "question";
  kind: "choice" | "input";
  title: string;
  body: string | null;
  options: PromptOption[];
  detail: { tool: string; summary: string } | null;
  // 毫秒时间戳；服务端给的是 ISO 串或数字都接受，解析不了为 null。
  expiresAt: number | null;
}

export interface ConvState {
  messages: Known[];
  partial: string | null;
  tools: Tool[];
  running: boolean;
  queue: string[];
  prompts: Prompt[];
  error: string | null;
}

export const initial: ConvState = {
  messages: [],
  partial: null,
  tools: [],
  running: false,
  queue: [],
  prompts: [],
  error: null,
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const role = (v: unknown): "user" | "assistant" | null =>
  v === "user" || v === "assistant" ? v : null;

const time = (v: unknown): number | null => {
  const t =
    typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

// 形状不对的弹窗丢弃，不让一条坏数据拖垮界面。
function parsePrompt(v: unknown): Prompt | null {
  const d = v as Record<string, unknown> | null;
  if (!d || typeof d.promptId !== "string" || !d.promptId) return null;
  const opts = Array.isArray(d.options) ? d.options : [];
  const det = d.detail as { tool?: unknown; summary?: unknown } | null;
  return {
    promptId: d.promptId,
    source: d.source === "approval" ? "approval" : "question",
    kind: d.kind === "input" ? "input" : "choice",
    title: str(d.title),
    body: typeof d.body === "string" && d.body ? d.body : null,
    options: opts.flatMap((o: { id?: unknown; label?: unknown }) =>
      typeof o?.id === "string"
        ? [{ id: o.id, label: str(o.label) || o.id }]
        : [],
    ),
    detail:
      det && typeof det === "object" && typeof det.tool === "string"
        ? { tool: det.tool, summary: str(det.summary) }
        : null,
    expiresAt: time(d.expiresAt),
  };
}

// 快照整体替换状态；其余帧按增量套用。未识别的帧原样忽略，协议新增帧不会让界面崩。
const blocksOf = (v: unknown): { blocks?: Block[] } =>
  Array.isArray(v) ? { blocks: v as Block[] } : {};

export function reduce(s: ConvState, f: Frame): ConvState {
  const d = f.data;
  switch (f.type) {
    case "snapshot": {
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      const active = Array.isArray(d.activeTools) ? d.activeTools : [];
      const p = d.partial as { text?: unknown } | null | undefined;
      return {
        messages: msgs.flatMap(
          (m: { role?: unknown; text?: unknown; blocks?: unknown }) => {
            const r = role(m?.role);
            return r
              ? [{ role: r, text: str(m.text), ...blocksOf(m.blocks) }]
              : [];
          },
        ),
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
        prompts: Array.isArray(d.prompts)
          ? d.prompts.flatMap((p) => parsePrompt(p) ?? [])
          : [],
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
        messages: [
          ...s.messages,
          { role: r, text: str(d.text), ...blocksOf(d.blocks) },
        ],
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
    case "prompt.requested": {
      const p = parsePrompt(d);
      if (!p || s.prompts.some((x) => x.promptId === p.promptId)) return s;
      return { ...s, prompts: [...s.prompts, p] };
    }
    case "prompt.resolved":
      return s.prompts.some((p) => p.promptId === d.promptId)
        ? { ...s, prompts: s.prompts.filter((p) => p.promptId !== d.promptId) }
        : s;
    default:
      return s;
  }
}
