import { uuidv7 } from "../id.js";

// 弹窗表：创建、答复、超时、撤销。纯逻辑，不依赖会话；计时用全局 setTimeout，测试可用假定时器。

export const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
export const ANSWER_TEXT_MAX = 8000;
const TITLE_MAX = 500;
const BODY_MAX = 4000;
const LABEL_MAX = 200;
const DETAIL_STRING_MAX = 2000;
// 已落定弹窗只记最近这些条，用来区分 prompt_resolved 与 prompt_unknown，也供自动审核取证。
const HISTORY_MAX = 50;

export interface PromptOption {
  id: string;
  label: string;
}

export interface PromptSpec {
  source: "approval" | "question";
  kind: "choice" | "input";
  title: string;
  body?: string;
  options?: PromptOption[];
  detail?: Record<string, unknown>;
}

// 线上 prompt.requested 的 data，同时是快照 prompts 的元素。
export interface PromptData {
  promptId: string;
  source: PromptSpec["source"];
  kind: PromptSpec["kind"];
  title: string;
  body?: string;
  options: PromptOption[];
  detail?: Record<string, unknown>;
  expiresAt: string;
}

export interface PromptResult {
  outcome: "answered" | "timeout" | "cancelled";
  optionId?: string;
  text?: string;
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

  ask(spec: PromptSpec): Promise<PromptResult> {
    const promptId = uuidv7();
    const data: PromptData = {
      promptId,
      source: spec.source,
      kind: spec.kind,
      title: cutText(spec.title, TITLE_MAX),
      ...(spec.body === undefined
        ? {}
        : { body: cutText(spec.body, BODY_MAX) }),
      options:
        spec.kind === "input"
          ? []
          : (spec.options ?? []).map((o) => ({
              id: o.id,
              label: cutText(o.label, LABEL_MAX),
            })),
      ...(spec.detail ? { detail: boundDetail(spec.detail) } : {}),
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
    return new Promise<PromptResult>((resolve) => {
      const settle = (result: PromptResult) => {
        // 落定只有一次：超时与答复竞争时先到者清掉表项，后到者找不到。
        const p = this.pending.get(promptId);
        if (!p) return;
        clearTimeout(p.timer);
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
  answer(
    promptId: string,
    a: { optionId?: unknown; text?: unknown },
  ): AnswerFailure | null {
    const p = this.pending.get(promptId);
    if (!p)
      return this.resolvedIds.includes(promptId)
        ? "prompt_resolved"
        : "prompt_unknown";
    if (p.data.kind === "choice") {
      if (
        typeof a.optionId !== "string" ||
        !p.data.options.some((o) => o.id === a.optionId)
      )
        return "bad_request";
      p.settle({ outcome: "answered", optionId: a.optionId });
      return null;
    }
    if (
      typeof a.text !== "string" ||
      a.text.length < 1 ||
      a.text.length > ANSWER_TEXT_MAX
    )
      return "bad_request";
    p.settle({ outcome: "answered", text: a.text });
    return null;
  }

  cancelAll(): void {
    for (const p of [...this.pending.values()])
      p.settle({ outcome: "cancelled" });
  }
}
