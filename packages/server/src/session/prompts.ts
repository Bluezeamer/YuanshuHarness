import { uuidv7 } from "../id.js";
import type { ImageInput } from "./user-content.js";

// 弹窗表：创建、答复、超时、撤销。纯逻辑，不依赖会话；计时用全局 setTimeout，测试可用假定时器。

export const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
export const ANSWER_TEXT_MAX = 8000;
const TITLE_MAX = 500;
const BODY_MAX = 4000;
const LABEL_MAX = 200;
export const DETAIL_STRING_MAX = 8000;
// 已落定弹窗只记最近这些条，用来区分 prompt_resolved 与 prompt_unknown，也供自动审核取证。
const HISTORY_MAX = 50;

export interface PromptOption {
  id: string;
  label: string;
}

// 一个弹窗 = 问题 + 可选的选项 + 可选的输入框。选项是快捷回复，答复里选项、文字、附件可任意组合。
export interface PromptSpec {
  source: "approval" | "question";
  title: string;
  body?: string;
  options?: PromptOption[];
  detail?: Record<string, unknown>;
  /** 有没有输入框：缺省 = 没有（只能选选项）；"text" = 文字；"rich" = 文字 + 附件 */
  input?: "text" | "rich";
}

// 线上 prompt.requested 的 data，同时是快照 prompts 的元素。
export interface PromptData {
  promptId: string;
  source: PromptSpec["source"];
  title: string;
  body?: string;
  options: PromptOption[];
  detail?: Record<string, unknown>;
  /** 只在有输入框时出现。 */
  input?: "text" | "rich";
  expiresAt: string;
}

export interface PromptResult {
  outcome: "answered" | "timeout" | "cancelled";
  optionId?: string;
  text?: string;
  /** 答复里随附的图片（不进 records，也不进事件）。 */
  images?: ImageInput[];
}

// 已解决弹窗的记录（答复文本也在这里，但不进事件）。
export interface PromptRecord {
  source: PromptSpec["source"];
  title: string;
  body?: string;
  outcome: PromptResult["outcome"];
  optionLabel?: string;
  text?: string;
}

export type AnswerFailure =
  | "prompt_resolved"
  | "prompt_unknown"
  | "bad_request";

interface Pending {
  data: PromptData;
  settle(result: PromptResult): void;
  timer: NodeJS.Timeout;
}

const cutText = (s: string, max: number) =>
  s.length > max ? s.slice(0, max) : s;

/** 拒绝原因后面接用户写的话；没写就原样返回。审批的所有拒绝路径共用它。 */
export const withUserNote = (reason: string, r: PromptResult): string =>
  r.text?.trim() ? `${reason}\n用户补充：${r.text.trim()}` : reason;

// detail 是不透明展示数据：字符串逐个限长，保证快照有界。
function boundDetail(
  d: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!d) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d))
    out[k] = typeof v === "string" ? cutText(v, DETAIL_STRING_MAX) : v;
  return out;
}

export class PromptTable {
  private readonly pending = new Map<string, Pending>();
  private readonly resolvedIds: string[] = [];
  private readonly records: PromptRecord[] = [];

  constructor(
    private readonly hooks: {
      requested(data: PromptData): void;
      resolved(data: {
        promptId: string;
        outcome: PromptResult["outcome"];
        optionId?: string;
      }): void;
    },
    private readonly timeoutMs = PROMPT_TIMEOUT_MS,
  ) {}

  list(): PromptData[] {
    return [...this.pending.values()].map((p) => p.data);
  }

  history(): readonly PromptRecord[] {
    return this.records;
  }

  /** signal 中止 = 撤销这个提问（界面上的卡片随 prompt.resolved 消失）；用于答复走了别的入口的场合。 */
  ask(spec: PromptSpec, signal?: AbortSignal): Promise<PromptResult> {
    if (signal?.aborted) return Promise.resolve({ outcome: "cancelled" });
    const promptId = uuidv7();
    const data: PromptData = {
      promptId,
      source: spec.source,
      title: cutText(spec.title, TITLE_MAX),
      ...(spec.body === undefined
        ? {}
        : { body: cutText(spec.body, BODY_MAX) }),
      options: (spec.options ?? []).map((o) => ({
        id: o.id,
        label: cutText(o.label, LABEL_MAX),
      })),
      ...(spec.detail ? { detail: boundDetail(spec.detail) } : {}),
      ...(spec.input === undefined ? {} : { input: spec.input }),
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
    return new Promise<PromptResult>((resolve) => {
      const settle = (result: PromptResult) => {
        // 落定只有一次：超时与答复竞争时先到者清掉表项，后到者找不到。
        const p = this.pending.get(promptId);
        if (!p) return;
        clearTimeout(p.timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(promptId);
        this.resolvedIds.push(promptId);
        if (this.resolvedIds.length > HISTORY_MAX * 4) this.resolvedIds.shift();
        const label = data.options.find((o) => o.id === result.optionId)?.label;
        this.records.push({
          source: data.source,
          title: data.title,
          ...(data.body === undefined ? {} : { body: data.body }),
          outcome: result.outcome,
          ...(label === undefined ? {} : { optionLabel: label }),
          ...(result.text === undefined ? {} : { text: result.text }),
        });
        if (this.records.length > HISTORY_MAX) this.records.shift();
        // text 不进事件
        this.hooks.resolved({
          promptId,
          outcome: result.outcome,
          ...(result.optionId === undefined
            ? {}
            : { optionId: result.optionId }),
        });
        resolve(result);
      };
      const onAbort = () => settle({ outcome: "cancelled" });
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(
        () => settle({ outcome: "timeout" }),
        this.timeoutMs,
      );
      timer.unref?.();
      this.pending.set(promptId, { data, settle, timer });
      this.hooks.requested(data);
    });
  }

  // 成功返回 null；失败返回错误码，弹窗保持原状。
  // 答复 = 选项、文字、附件三者的任意组合，至少要有一样。
  answer(
    promptId: string,
    a: {
      optionId?: unknown;
      text?: unknown;
      images?: ImageInput[];
      /** 这次答复带了附件（附件不一定产生图片）；只对 rich 弹窗成立。 */
      attached?: boolean;
    },
  ): AnswerFailure | null {
    const p = this.pending.get(promptId);
    if (!p)
      return this.resolvedIds.includes(promptId)
        ? "prompt_resolved"
        : "prompt_unknown";
    if (a.optionId !== undefined) {
      if (typeof a.optionId !== "string") return "bad_request";
      if (!p.data.options.some((o) => o.id === a.optionId))
        return "bad_request";
    }
    // 空串当没给：只有真写了字才算「带文字」。
    if (a.text !== undefined && typeof a.text !== "string")
      return "bad_request";
    const wrote = typeof a.text === "string" && a.text !== "";
    if (wrote) {
      if (p.data.input === undefined) return "bad_request";
      if ((a.text as string).length > ANSWER_TEXT_MAX) return "bad_request";
    }
    // 附件只有 rich 弹窗收；空 images 数组当没有附件。
    const hasImages = a.images !== undefined && a.images.length > 0;
    if ((a.attached === true || hasImages) && p.data.input !== "rich")
      return "bad_request";
    if (a.optionId === undefined && !wrote) return "bad_request";
    p.settle({
      outcome: "answered",
      ...(a.optionId === undefined ? {} : { optionId: a.optionId }),
      ...(wrote ? { text: a.text as string } : {}),
      ...(hasImages ? { images: a.images } : {}),
    });
    return null;
  }

  cancelAll(): void {
    for (const p of [...this.pending.values()])
      p.settle({ outcome: "cancelled" });
  }
}
