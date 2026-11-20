import type { Block, MessageAttachment } from "../../../api";
import { Chip } from "../../../ui";
import { splitQuotes } from "./format";
import { Markdown } from "./Markdown";
import { MessageAttachments } from "./MessageAttachments";
import { Think } from "./Think";
import { ToolRuns } from "./ToolGroups";
import { rowOfBlock, type ToolRow } from "./toolRows";

// 用户消息：右对齐灰底气泡；附件卡片、引用块还原成 chip，正文走 Markdown。
export function UserBubble({
  text,
  sessionId,
  attachments,
}: {
  text: string;
  sessionId: string;
  attachments?: readonly MessageAttachment[] | undefined;
}) {
  const { quotes, body } = splitQuotes(text);
  return (
    <div className="ch-msg ch-you">
      <div className="ch-bubble">
        {attachments && attachments.length > 0 && (
          <MessageAttachments sessionId={sessionId} attachments={attachments} />
        )}
        {quotes.length > 0 && (
          <ul className="ch-quotes" aria-label="引用">
            {quotes.map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 引用按发送顺序排列，没有稳定 id
              <li key={i} title={q.text}>
                <Chip className="t-mono">{q.label}</Chip>
              </li>
            ))}
          </ul>
        )}
        {body && <Markdown text={body} sessionId={sessionId} plain />}
      </div>
    </div>
  );
}

// 一条文字块：渲染态走 Markdown，原文态直接给纯文本 pre。
function TextPart({
  text,
  sessionId,
  raw,
}: {
  text: string;
  sessionId: string;
  raw: boolean;
}) {
  return raw ? (
    <pre className="ch-raw t-code">{text}</pre>
  ) : (
    <Markdown text={text} sessionId={sessionId} />
  );
}

// 助手消息：有文本块时按块的先后交错渲染（思考 / 工具 / 文本），否则正文在前、其余块在后。
// 连续的工具块并成一串，串里相邻同类的再折成一组。raw 是轮末操作行的「原文」模式：只把文字块换成纯文本 pre。
export function AgentMessage({
  text,
  blocks,
  sessionId,
  raw = false,
  kids,
}: {
  text: string;
  blocks?: readonly Block[] | undefined;
  sessionId: string;
  raw?: boolean;
  /** 父工具 id → 嵌套子行；有就挂在该工具行内部 */
  kids?: Map<string, ToolRow[]>;
}) {
  const list = blocks ?? [];
  const ordered = list.some((b) => b.type === "text");
  const parts: (
    | { kind: "text"; text: string }
    | { kind: "think"; text: string }
    | { kind: "tools"; rows: ToolRow[] }
  )[] = [];
  if (!ordered && text) parts.push({ kind: "text", text });
  for (const b of list) {
    const last = parts[parts.length - 1];
    if (b.type === "tool") {
      const row = rowOfBlock(b);
      const live = kids?.get(b.id);
      // 历史块里带的子行 + 运行期新增的子行合并（按 id 去重，运行期优先）
      const merged = new Map((row.children ?? []).map((c) => [c.id, c]));
      for (const c of live ?? []) merged.set(c.id, c);
      const withKids = merged.size
        ? { ...row, children: [...merged.values()] }
        : row;
      if (last?.kind === "tools") last.rows.push(withKids);
      else parts.push({ kind: "tools", rows: [withKids] });
    } else if (b.type === "thinking")
      parts.push({ kind: "think", text: b.text });
    else if (b.text) parts.push({ kind: "text", text: b.text });
  }
  return (
    <div className="ch-msg ch-agent">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 块按顺序渲染，只追加
          <TextPart key={i} text={p.text} sessionId={sessionId} raw={raw} />
        ) : p.kind === "think" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 块按顺序渲染，只追加
          <Think key={i} text={p.text} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 块按顺序渲染，只追加
          <ToolRuns key={i} rows={p.rows} />
        ),
      )}
    </div>
  );
}

// 正在生成的助手文本。思考折成一行（它还是当前这一步时由对话流的一行预览负责，不传进来）。
export function Partial({
  text,
  thinking,
  caret,
  sessionId,
}: {
  text: string;
  thinking: string;
  /** 光标只在没有一行预览时出现：有预览说明正在做的是别的事 */
  caret: boolean;
  sessionId: string;
}) {
  if (!text && !thinking && !caret) return null;
  return (
    <div className="ch-msg ch-agent">
      {thinking && <Think text={thinking} />}
      {text && <Markdown text={text} streaming sessionId={sessionId} />}
      {caret && <span className="ch-caret" role="img" aria-label="正在输入" />}
    </div>
  );
}

// typing 占位：运行中、还没有任何输出时。
export function Typing() {
  return (
    <div className="ch-msg ch-agent">
      <span className="ch-typing" role="img" aria-label="正在输入">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
