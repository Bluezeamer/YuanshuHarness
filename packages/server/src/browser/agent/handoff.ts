// 接管提问：agent 请用户接管页面，复用会话的弹窗通道（PromptTable）。
// 只有「请求」这一步；操作权由用户自己点「手动操作」切换，这里不碰 controller。
// 方向按页面此刻的操作者定：agent 的页面 = 请用户接管（operate）；用户的页面 = 请用户把它交给 agent（claim）。
import type { PromptResult, PromptSpec } from "../../session/prompts.js";

export type AskFn = (
  spec: PromptSpec,
  signal?: AbortSignal,
) => Promise<PromptResult>;

export type HandoffOutcome =
  | { kind: "done"; note?: string } // 用户点了「我已操作完成」（claim 方向是「交给 agent」），可附一句补充
  | { kind: "refused"; reason: string } // 用户点了「拒绝」或只写了字；理由可为空串
  | { kind: "timeout" }
  | { kind: "cancelled" };

/** 提问的方向：agent 的页面请用户接管；用户的页面请求使用它。 */
export type HandoffDirection = "operate" | "claim";

export function askHandoff(
  ask: AskFn,
  args: {
    pageTitle: string;
    url: string;
    reason: string;
    direction: HandoffDirection;
  },
  /** 中止 = 撤销提问（用户改在页面上答复时用） */
  signal?: AbortSignal,
): Promise<HandoffOutcome> {
  const title = args.pageTitle || args.url;
  const claim = args.direction === "claim";
  const spec: PromptSpec = {
    source: "question",
    input: "text",
    title: claim
      ? `agent 请求使用页面：${title}`
      : `agent 请你接管页面：${title}`,
    body: [
      ...(args.reason.trim() === "" ? [] : [`原因：${args.reason}`]),
      `页面：${args.url}`,
    ].join("\n"),
    options: [
      claim
        ? { id: "done", label: "交给 agent" }
        : { id: "done", label: "我已操作完成" },
      { id: "refuse", label: "拒绝" },
    ],
  };
  return ask(spec, signal).then((r): HandoffOutcome => {
    if (r.outcome === "timeout") return { kind: "timeout" };
    if (r.outcome === "cancelled") return { kind: "cancelled" };
    const wrote = r.text?.trim() ? r.text : undefined;
    if (r.optionId === "done")
      return wrote === undefined
        ? { kind: "done" }
        : { kind: "done", note: wrote };
    // 「拒绝」，或者没选选项只写了字：都算拒绝，写的话就是理由。
    return { kind: "refused", reason: wrote ?? "" };
  });
}
