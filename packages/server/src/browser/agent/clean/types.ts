// 清洗层与工具层之间的契约：工具只认这里的接口，清洗层怎么实现（机械层、diff、辅助模型、读页面 agent）与工具无关。

/** 辅助模型单次调用：入参已过变量遮罩；没配辅助模型时清洗器拿到的是 null，就一次都不调 */
export type AuxCall = (args: {
  system: string;
  user: string;
}) => Promise<string>;

/**
 * 读大页面的只读 agent（设计稿 §8.3）：返回它交付的指针 JSON 文本；任何失败返回 null。
 * label 是子代理标签上显示的名字。
 */
export type PageReader = (args: {
  sessionId: string;
  task: string;
  label: string;
  signal?: AbortSignal;
}) => Promise<string | null>;

export interface CleanInput {
  sessionId: string;
  pageId: string;
  /** 引擎的原始快照（完整，不截断） */
  raw: string;
  url: string;
  title: string;
  /** 显式 browser_snapshot：永远走完整路径、不做 diff；动作之后的调用传 false */
  explicit: boolean;
  /** 动作的一行说明（ACTION 行），如 "click e12"；open / snapshot 不传 */
  action?: string;
  /** agent 想从页面里找什么；每次调用现给，不跨调用记忆 */
  intent?: string;
  /** 外壳里 ACTION / URL 行之后、内容之前的附加行（剪贴板、下载、PAGE ID 等），原样放 */
  notes?: string[];
  /** 把一份文本存成本会话的附件，返回 `[attach_file]` 标记行；由工具层接线 */
  saveText(name: string, text: string): Promise<string>;
  signal?: AbortSignal;
}

export interface CleanOutput {
  text: string;
  /** 这一步的去向，给审计与统计用 */
  stage:
    | "no-changes"
    | "diff"
    | "direct"
    | "aux"
    | "agent"
    | "inline"
    | "structure"
    | "fallback";
}

export interface Cleaner {
  clean(input: CleanInput): Promise<CleanOutput>;
  /** 不输出内容，只把基线重置成这份快照（`browser_snapshot` 的 raw 逃生口用） */
  rebase(sessionId: string, pageId: string, raw: string, url: string): void;
  /** 页面被关掉：丢掉所有会话对它的基线（释放内存）。操作权易手**不**丢基线：用户手动操作造成的变化要出现在下一次 diff 里（元素身份不依赖编号） */
  forgetPage(pageId: string): void;
}
