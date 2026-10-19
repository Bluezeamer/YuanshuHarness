export interface Frame {
  session: string;
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export interface Rendered {
  out: string;
  err: string;
}

interface Msg {
  role: string;
  text: string;
}

interface PromptView {
  promptId: string;
  source: string;
  kind: string;
  title: string;
  body?: string;
  options: Array<{ id: string; label: string }>;
}

const OUTCOME: Record<string, string> = {
  answered: "已答复",
  timeout: "已超时",
  cancelled: "已撤销",
};

const NONE: Rendered = { out: "", err: "" };
const label = (role: string) => (role === "user" ? "[你]" : "[助手]");

// 帧到文本。inline 表示 stdout 停在行中间（流式追加之后），下一行输出前要先补换行。
export class Renderer {
  private inline = false;
  private queueLen = 0;

  // 助手消息是否正在生成（快照带 partial，或见过 message.started 而未 ended）。
  generating = false;

  // 待回答的弹窗，按到达顺序；/answer 作答最早的一个。
  readonly pendingPrompts: PromptView[] = [];

  private promptText(p: PromptView): string {
    const head = `[${p.source === "approval" ? "审批" : "提问"}] ${p.title}`;
    const body = p.body ? `\n${p.body}` : "";
    const opts = p.options.map((o, i) => `\n  ${i + 1}. ${o.label}`).join("");
    const how = p.kind === "choice" ? "/answer <编号>" : "/answer <文本>";
    return this.line(`${head}${body}${opts}\n  作答：${how}`);
  }

  // 整行输出：行中间时先补一个换行。
  private line(text: string): string {
    const lead = this.inline ? "\n" : "";
    this.inline = false;
    return `${lead}${text}\n`;
  }

  // 开一行但不收尾，后面接流式文本。
  private open(text: string): string {
    const lead = this.inline ? "\n" : "";
    this.inline = true;
    return `${lead}${text}`;
  }

  render(frame: Frame): Rendered {
    const d = frame.data;
    switch (frame.type) {
      case "snapshot": {
        let out = "";
        for (const m of (d.messages as Msg[] | undefined) ?? [])
          out += this.line(`${label(m.role)} ${m.text}`);
        const p = d.partial as Msg | null | undefined;
        this.generating = Boolean(p);
        if (p) out += this.open(`${label(p.role)} ${p.text}`);
        // 快照里的 prompts 是权威的待处理集合。
        this.pendingPrompts.length = 0;
        for (const q of (d.prompts as PromptView[] | undefined) ?? []) {
          this.pendingPrompts.push(q);
          out += this.promptText(q);
        }
        this.queueLen = ((d.queue as unknown[] | undefined) ?? []).length;
        return { out, err: "" };
      }
      case "message.started":
        if (d.role !== "assistant") return NONE;
        this.generating = true;
        return { out: this.open(`${label("assistant")} `), err: "" };
      case "message.delta":
        if (d.kind !== "text" || typeof d.text !== "string") return NONE;
        this.inline = true;
        return { out: d.text, err: "" };
      case "message.ended": {
        const role = String(d.role);
        if (role === "assistant") {
          this.generating = false;
          const out = this.inline ? "\n" : "";
          this.inline = false;
          return { out, err: "" };
        }
        // 用户消息只在 ended 时整条打印：started 与 ended 带同样的文本。
        return {
          out: role === "user" ? this.line(`${label(role)} ${d.text}`) : "",
          err: "",
        };
      }
      case "tool.started":
        return { out: this.line(`[工具] ${d.toolName} 开始`), err: "" };
      case "tool.ended":
        return {
          out: this.line(`[工具] ${d.toolName} ${d.isError ? "失败" : "完成"}`),
          err: "",
        };
      case "run.failed":
        return { out: "", err: `运行失败：${d.message}\n` };
      case "prompt.requested":
        this.pendingPrompts.push(d as unknown as PromptView);
        return { out: this.promptText(d as unknown as PromptView), err: "" };
      case "prompt.resolved": {
        const i = this.pendingPrompts.findIndex(
          (q) => q.promptId === d.promptId,
        );
        if (i >= 0) this.pendingPrompts.splice(i, 1);
        return {
          out: this.line(`[弹窗${OUTCOME[String(d.outcome)] ?? "已结束"}]`),
          err: "",
        };
      }
      case "queue.updated": {
        const n = ((d.queue as unknown[] | undefined) ?? []).length;
        if (n === this.queueLen) return NONE;
        this.queueLen = n;
        return { out: this.line(`[排队] ${n} 条`), err: "" };
      }
      default:
        return NONE;
    }
  }
}
