// 输入框草稿相关的纯数据：划选提问的引用 chip（ADR-0061）与附件引用。
// 引用 chip 挂在输入栏上方，发送时把原文拼在问题前面；附件先上传到会话附件区，发送时只带 path。

export interface Quote {
  /** 来源标签：文件形如 `主机:路径:Lx-Ly`，网页用 URL */
  label: string;
  /** 选中的原文（已截断到 QUOTE_MAX） */
  text: string;
}

export interface QuoteChip {
  id: string;
  quote: Quote;
}

/** 附件：上传到会话附件区后的引用；发送时只带 path，不再传文件内容。 */
export interface Attachment {
  id: string;
  /** 原始文件名 */
  name: string;
  mimeType: string;
  /** 字节数；来自服务端引用（已在附件区的文件）时不知道，为 0 */
  size: number;
  /** 服务端已格式化好的体积文案；有就优先于 size */
  sizeText?: string;
  /** 相对 attachment directory 的路径；上传成功前为空串 */
  path: string;
  status: "uploading" | "ready" | "error";
  /** 上传进度 0–100；null 表示进度未知 */
  progress: number | null;
  /** 图片的本地预览 URL：上传中/失败用，完成后改用 content 接口的 blob */
  previewUrl?: string;
  /** 上传失败的中文说明 */
  error?: string;
}

/** 单条引用的字数上限，防止整个文件被选进一条消息 */
export const QUOTE_MAX = 8000;

export const fileLabel = (
  environmentId: string,
  path: string,
  from: number,
  to: number,
) => `${environmentId}:${path}:${from === to ? `L${from}` : `L${from}-L${to}`}`;

export function makeQuote(label: string, selected: string): Quote {
  const text =
    selected.length > QUOTE_MAX
      ? `${selected.slice(0, QUOTE_MAX)}\n…（已截断，原选区 ${selected.length} 字）`
      : selected;
  return { label, text };
}

// 围栏比引用文本里最长的反引号串多一个，引用里带 ``` 也不会提前闭合。
function fence(text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((s) => s.length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

/** 发送给 agent 的消息：每条引用一个围栏块，空行后接用户的问题。 */
export function withQuotes(chips: readonly QuoteChip[], text: string): string {
  if (chips.length === 0) return text;
  const blocks = chips.map(({ quote: q }) => {
    const f = fence(q.text);
    return `Quote ${q.label}\n${f}\n${q.text}\n${f}`;
  });
  return `${blocks.join("\n\n")}\n\n${text}`;
}

/** 草稿：文本、引用、附件。restored 表示文本是发送失败后放回的原样（用户还没动过）。 */
export interface Draft {
  text: string;
  restored: boolean;
  quotes: readonly QuoteChip[];
  attachments: readonly Attachment[];
}

/** 发送失败或断线时要放回草稿的内容。 */
export interface Restore {
  text: string;
  quotes: readonly QuoteChip[];
  attachments: readonly Attachment[];
}

export const emptyDraft: Draft = {
  text: "",
  restored: false,
  quotes: [],
  attachments: [],
};
