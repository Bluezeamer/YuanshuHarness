import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PromptResult, PromptSpec } from "./prompts.js";

export type AskFn = (spec: PromptSpec) => Promise<PromptResult>;

const OPTION_MIN = 1;
const OPTION_MAX = 8;
const OPTION_LABEL_MAX = 200;

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
});

// agent 向用户提问的工具：答复总是可以自由写（选项只是快捷回复），结果按选项 / 文字组合给模型。
// 参数 schema 直接写 JSON Schema（TypeBox 的 schema 即 JSON Schema），省一个直接依赖。
export function askUserExtension(ask: AskFn): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "ask_user",
      label: "向用户提问",
      description:
        "Ask the user a question and wait for the answer. The user can always reply in their own words (optionally with images and files); `options` (1 to 8) are only suggested quick replies, so do not assume the answer is one of them — treat a free-form reply as a first-class answer.",
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
        // 空数组当没给：否则会弹出一张「有选项但一个都没有」的卡片。
        const choices = options?.length
          ? options.map((label, i) => ({ id: String(i), label }))
          : undefined;
        const r = await ask({
          source: "question",
          title: question,
          ...(choices ? { options: choices } : {}),
          input: "rich",
        });
        if (r.outcome === "timeout")
          return text("The user did not answer (timed out).");
        if (r.outcome === "cancelled")
          return text("The question was cancelled.");
        const picked = choices?.find((c) => c.id === r.optionId)?.label;
        const wrote = r.text?.trim() ? r.text : undefined;
        const answer = [
          ...(picked === undefined ? [] : [`The user selected: ${picked}`]),
          ...(wrote === undefined
            ? []
            : picked === undefined
              ? [
                  choices
                    ? `The user did not pick a listed option and replied: ${wrote}`
                    : `The user replied: ${wrote}`,
                ]
              : [`The user also wrote: ${wrote}`]),
        ].join("\n");
        // 答复可以带图片（用户传了附件）：图片作为工具结果的一部分交给模型。
        return {
          content: [
            { type: "text" as const, text: answer },
            ...(r.images ?? []).map((i) => ({
              type: "image" as const,
              data: i.data,
              mimeType: i.mimeType,
            })),
          ],
          details: {},
        };
      },
    });
  };
}
