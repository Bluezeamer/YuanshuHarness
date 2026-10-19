import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PromptResult, PromptSpec } from "./prompts.js";

export type AskFn = (spec: PromptSpec) => Promise<PromptResult>;

const OPTION_MIN = 2;
const OPTION_MAX = 8;
const OPTION_LABEL_MAX = 200;

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
});

// agent 向用户提问的工具：有 options 走 choice，无则 input；答复作为工具结果。
// 参数 schema 直接写 JSON Schema（TypeBox 的 schema 即 JSON Schema），省一个直接依赖。
export function askUserExtension(ask: AskFn): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "ask_user",
      label: "向用户提问",
      description:
        "向用户提一个问题并等待回答。给出 options（2 到 8 项）时用户从中选择，否则自由输入文本。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1, maxLength: 2000 },
          options: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
              maxLength: OPTION_LABEL_MAX,
            },
            minItems: OPTION_MIN,
            maxItems: OPTION_MAX,
          },
        },
        required: ["question"],
      } as never,
      async execute(_id, params) {
        const { question, options } = params as {
          question: string;
          options?: string[];
        };
        const choices = options?.map((label, i) => ({ id: String(i), label }));
        const r = await ask({
          source: "question",
          kind: choices ? "choice" : "input",
          title: question,
          ...(choices ? { options: choices } : {}),
        });
        if (r.outcome === "timeout") return text("用户未回答");
        if (r.outcome === "cancelled") return text("已取消");
        if (choices)
          return text(choices.find((c) => c.id === r.optionId)?.label ?? "");
        return text(r.text ?? "");
      },
    });
  };
}
