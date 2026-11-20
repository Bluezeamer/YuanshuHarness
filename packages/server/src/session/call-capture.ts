import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CallStore, CallTrigger } from "../store/calls.js";
import { messageCount, splitTokens } from "./call-tokens.js";

const SUMMARY_MAX = 160;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) =>
      b?.type === "text" && typeof b.text === "string" ? b.text : "",
    )
    .join(" ");
};

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX)}…` : t;
};

type Trigger = {
  trigger: "user" | "tool_result";
  toolName: string | null;
  summary: string;
};

// 触发这次调用的输入 = 最近一条 user 或 toolResult；custom 等注入消息不算。
function triggerOf(messages: ReadonlyArray<{ role: string }>): Trigger {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      role: string;
      content?: unknown;
      toolName?: string;
    };
    if (m.role === "toolResult")
      return {
        trigger: "tool_result",
        toolName: m.toolName ?? null,
        summary: oneLine(textOf(m.content)),
      };
    if (m.role === "user")
      return {
        trigger: "user",
        toolName: null,
        summary: oneLine(textOf(m.content)),
      };
  }
  return { trigger: "user", toolName: null, summary: "" };
}

/**
 * 记录会话的每一次模型调用：before_provider_request 拿到发给模型的原始请求体（只留该会话最新一次），
 * 紧随其后的助手消息结束（message_end）时带着响应、用量与请求里的对话项数一起落库。
 * 模型提供方不给的两项耗时在这里旁路测量：TTFT（发请求 → 第一个非空流式增量）
 * 与工具执行耗时（SDK tool_execution_end 的 durationMs 之和；工具总在下一次调用前
 * 执行完，所以归到下一次调用记录，会话内求和即工具总耗时）。
 * 纯旁路：任何失败都吞掉，绝不影响会话；只读事件，从不改 payload。
 */
export function callCaptureExtension(opts: {
  store: CallStore;
  sessionId: string;
  /** 子会话的所有调用都标 subagent（审计里的「子代理」档）。 */
  subagent: boolean;
  runId: () => string | null;
}): ExtensionFactory {
  return (pi) => {
    let trig: Trigger = { trigger: "user", toolName: null, summary: "" };
    let pending: {
      requestJson: string;
      payload: unknown;
      startedAt: number;
      trig: Trigger;
      window: number | null;
      /** 本次请求收到第一个非空流式增量的时刻；没收到增量时为 null。 */
      firstDeltaAt: number | null;
    } | null = null;
    // 自上一次调用落库以来执行完的工具耗时。
    let toolMs = 0;
    // 同一窗口内执行过的工具明细（含其它工具发起的嵌套调用）。结构化数据取自 pi 的事件，
    // 而不是解析助手消息——嵌套调用不会出现在消息的 toolCall 块里。
    let executed: {
      toolCallId: string;
      parentToolCallId?: string;
      toolName: string;
      durationMs?: number;
      isError?: boolean;
    }[] = [];

    pi.on("tool_execution_start", (e) => {
      executed.push({
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        ...(e.parentToolCallId === undefined
          ? {}
          : { parentToolCallId: e.parentToolCallId }),
      });
      return undefined;
    });

    pi.on("tool_execution_end", (e) => {
      // durationMs 缺省表示工具没有真正执行（例如被拒绝），不计入耗时。
      if (typeof e.durationMs === "number" && e.durationMs > 0)
        toolMs += e.durationMs;
      const rec = executed.find((x) => x.toolCallId === e.toolCallId);
      if (rec) {
        if (e.durationMs !== undefined) rec.durationMs = e.durationMs;
        rec.isError = e.isError;
      }
      return undefined;
    });

    pi.on("message_update", (e) => {
      if (!pending || pending.firstDeltaAt !== null) return undefined;
      const ev = e.assistantMessageEvent;
      // 流开头可能先来内容为空的增量，空 delta 不算第一个 token。
      if (
        (ev.type === "text_delta" || ev.type === "thinking_delta") &&
        ev.delta.length > 0
      )
        pending.firstDeltaAt = Date.now();
      return undefined;
    });

    pi.on("context", (e) => {
      trig = triggerOf(e.messages);
      return undefined;
    });

    pi.on("before_provider_request", (e, ctx) => {
      try {
        pending = {
          requestJson: JSON.stringify(e.payload),
          payload: e.payload,
          startedAt: Date.now(),
          trig,
          window: ctx.model?.contextWindow ?? null,
          firstDeltaAt: null,
        };
      } catch {
        pending = null;
      }
      return undefined;
    });

    pi.on("message_end", (e) => {
      const m = e.message;
      if (m.role !== "assistant" || !pending) return undefined;
      const p = pending;
      pending = null;
      try {
        const response = {
          content: m.content,
          stopReason: m.stopReason,
          ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}),
          usage: {
            input: m.usage.input,
            output: m.usage.output,
            cacheRead: m.usage.cacheRead,
            cacheWrite: m.usage.cacheWrite,
          },
        };
        const responseJson = JSON.stringify(response);
        const trigger: CallTrigger = opts.subagent
          ? "subagent"
          : p.trig.trigger;
        const ttftMs =
          p.firstDeltaAt === null
            ? undefined
            : Math.max(0, Math.round(p.firstDeltaAt - p.startedAt));
        const timing = {
          toolMs: Math.round(toolMs),
          ...(ttftMs === undefined ? {} : { ttftMs }),
        };
        opts.store.record({
          sessionId: opts.sessionId,
          runId: opts.runId(),
          trigger,
          toolName: trigger === "tool_result" ? p.trig.toolName : null,
          durationMs: Date.now() - p.startedAt,
          tokens: splitTokens(
            p.payload,
            m.usage,
            JSON.stringify(m.content).length,
          ),
          meta: {
            summary: p.trig.summary,
            calledTools: m.content.flatMap((b) =>
              b.type === "toolCall" ? [b.name] : [],
            ),
            // 实际执行过的工具（含嵌套）：来自 pi 的事件信号，与请求体里的 toolCall 块互补
            ...(executed.length === 0 ? {} : { toolCalls: executed }),
            stopReason: m.stopReason,
            model: m.model,
            window: p.window,
          },
          timing,
          msgCount: messageCount(p.payload),
          requestJson: p.requestJson,
          responseJson,
        });
        // 落库成功才清零：写失败时这批工具耗时留给下一次记录，不丢。
        toolMs = 0;
        executed = [];
      } catch {
        // 见函数注释
      }
      return undefined;
    });
  };
}
