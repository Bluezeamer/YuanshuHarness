import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HookCtx, HookRuntime } from "./runtime.js";

// 把 pi 的 tool_call / tool_result / input / agent_settled 事件接到 hook 运行时（ADR-0085）。
// 排在 modeExtension 之后、权限扩展之前：plan 模式的只读限制先判；hook 改写后的输入由权限层按最终内容判定。

// 工具结果正文进载荷的上限；hook 要完整内容可以自己读文件。
const RESPONSE_MAX = 16 * 1024;

export interface HooksExtensionDeps {
  runtime: HookRuntime;
  /** 每次触发即时取：会话可能已切换 directory。 */
  ctx: () => HookCtx;
  /** UserPromptSubmit 被阻断时告知用户（该条消息不会交给模型）。 */
  reject: (message: string) => void;
}

const textOf = (content: ReadonlyArray<{ type: string; text?: string }>) =>
  content
    .flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : []))
    .join("\n");

export function hooksExtension(deps: HooksExtensionDeps): ExtensionFactory {
  const { runtime, ctx } = deps;
  return (pi) => {
    // hook 自身的异常一律放行：这里不会向 SDK 抛错（SDK 对 tool_call 的异常会当作阻断）。
    pi.on("tool_call", async (e) => {
      try {
        const out = await runtime.fire("PreToolUse", ctx(), {
          tool_name: e.toolName,
          tool_input: e.input,
          tool_use_id: e.toolCallId,
        });
        if (out.blocked !== null) return { block: true, reason: out.blocked };
        if (out.updatedInput) {
          // SDK 约定：原地改 event.input 才会生效。
          const input = e.input as Record<string, unknown>;
          for (const k of Object.keys(input)) delete input[k];
          Object.assign(input, out.updatedInput);
        }
      } catch {
        // 放行
      }
      return undefined;
    });

    pi.on("tool_result", async (e) => {
      try {
        const text = textOf(e.content);
        const out = await runtime.fire("PostToolUse", ctx(), {
          tool_name: e.toolName,
          tool_input: e.input,
          tool_use_id: e.toolCallId,
          tool_response: {
            text:
              text.length > RESPONSE_MAX
                ? `${text.slice(0, RESPONSE_MAX)}…`
                : text,
            is_error: e.isError,
          },
        });
        const extra = [
          ...out.feedback.map((f) => `[hook 反馈] ${f}`),
          ...out.context.map((c) => `[hook 上下文] ${c}`),
        ];
        if (extra.length === 0) return undefined;
        return {
          content: [
            ...e.content,
            { type: "text" as const, text: extra.join("\n") },
          ],
        };
      } catch {
        return undefined;
      }
    });

    pi.on("input", async (e) => {
      try {
        const out = await runtime.fire("UserPromptSubmit", ctx(), {
          prompt: e.text,
        });
        if (out.blocked !== null) {
          deps.reject(out.blocked);
          return { action: "handled" as const };
        }
        if (out.context.length > 0)
          pi.sendMessage(
            {
              customType: "yuanshu.hook",
              content: out.context.join("\n"),
              display: false,
            },
            { deliverAs: "nextTurn" },
          );
      } catch {
        // 放行
      }
      return { action: "continue" as const };
    });

    // 只观察：不等 hook 跑完，免得拖住运行收尾。
    pi.on("agent_settled", (e) => {
      void runtime.fire("Stop", ctx(), { aborted: e.aborted }).catch(() => {});
    });
  };
}
