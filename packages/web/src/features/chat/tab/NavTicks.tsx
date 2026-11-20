// 左缘快速导航：每条用户指令一格横线，当前位置的线与字是深色。
// 鼠标移上去，线条原地不动，这一块向右延展成一张可滚动的小卡（高度有限），文字统一从最长线的末端起对齐；
// 鼠标所在那条：线最长、浅灰底、字最深，两侧逐级变短变淡。悬停某一条再浮出第二张卡：完整内容与时间。
// 展开的是一整块区域，鼠标要完全离开它才收起（X08）。

import { type RefObject, useEffect, useRef, useState } from "react";
import { fmtDateTime, HoverCard, IconButton, PeekCard } from "../../../ui";
import type { ChatSession } from "../hooks";
import { type NavNode, previewLine } from "./conversationNav";
import { tickLook } from "./navTicks";
import { useConversationNav } from "./useConversationNav";

// 纯附件消息没有正文，给一个可读的占位
const labelOf = (n: NavNode): string => previewLine(n.text) || "（附件消息）";

export function NavTicks({
  nodes,
  active,
  onJump,
}: {
  nodes: readonly NavNode[];
  active: number;
  onJump: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState<number | null>(null);

  // 没在操作它时，让当前位置保持在可见区（只用 scrollTop，不调 scrollIntoView）
  useEffect(() => {
    const el = box.current;
    const row = el?.querySelector<HTMLElement>(`[data-nav="${active}"]`);
    if (!el || !row || open) return;
    const top = row.offsetTop;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + row.offsetHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = top + row.offsetHeight - el.clientHeight;
  }, [active, open]);

  if (nodes.length < 2) return null;

  return (
    <nav className="ch-nav-wrap" aria-label="对话导航" data-chat-nav="">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 悬停只负责展开，键盘走里面每条的按钮（聚焦即展开） */}
      <div
        ref={box}
        className="ch-nav"
        data-expanded={open || undefined}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => {
          setOpen(false);
          setHi(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
        }}
      >
        {nodes.map((node, i) => {
          const on = i === active;
          const { width, fade } = tickLook({
            index: i,
            hover: hi,
            active: on,
            open,
          });
          const when = node.timestamp ? fmtDateTime(node.timestamp) : "";
          return (
            <HoverCard
              key={node.entryId ?? i}
              card={
                <PeekCard
                  title={labelOf(node)}
                  {...(node.text.length > 60 ? { text: node.text } : {})}
                  facts={[
                    ...(when ? ([["时间", when]] as const) : []),
                    ["位置", `第 ${i + 1} 条，共 ${nodes.length} 条`],
                  ]}
                />
              }
            >
              <IconButton
                size="sm"
                className="ch-tick"
                label={`跳到第 ${i + 1} 条指令：${labelOf(node)}`}
                title={undefined}
                aria-current={on ? "true" : undefined}
                data-nav={i}
                onClick={() => onJump(i)}
                onPointerEnter={() => setHi(i)}
                icon={
                  <span className="ch-nav-row" style={{ opacity: fade }}>
                    <span className="ch-nav-lane">
                      <i className="ch-tick-mark" style={{ width }} />
                    </span>
                    <span className="t-plain ch-nav-text">{labelOf(node)}</span>
                  </span>
                }
              />
            </HoverCard>
          );
        })}
      </div>
    </nav>
  );
}

// 接上会话：节点与当前位置来自对话流的滚动状态
export function ConversationNav({
  sessionId,
  session,
  scrollRef,
}: {
  sessionId: string;
  session: ChatSession;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const nav = useConversationNav({ sessionId, session, scrollRef });
  return <NavTicks nodes={nav.nodes} active={nav.active} onJump={nav.jump} />;
}
