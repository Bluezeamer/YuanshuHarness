import { useLayoutEffect, useRef, useState } from "react";
import { Dot, ListRow } from "../../../ui";
import { ChevronDownIcon, ChevronRightIcon } from "../../../ui/icons";
import type { LiveLine } from "./liveLine";

// 贴底阈值：离底不足这么多像素就算「在看最新输出」
const TAIL_GAP = 24;

// 点开后的输出框：内容增长时跟到底；用户往上翻了就不再抢回去
function LiveBody({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const tail = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: text 变了才需要补滚，函数体里不读它
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && tail.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className="ch-live-body t-code"
      onScroll={(e) => {
        const el = e.currentTarget;
        tail.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_GAP;
      }}
    >
      {text}
    </pre>
  );
}

// 运行态：默认一行淡色预览（类型标签 + 最新一行内容，随流式刷新）；点开看目前的全部内容并跟到底。这一步结束就收成折叠行。
export function LiveLineRow({ line }: { line: LiveLine }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ch-live" data-live="">
      <ListRow
        size="compact"
        lead={open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        expanded={open}
        label={
          <span className="ch-line">
            <Dot size="sm" tone="live" motion="pulse" />
            <span className="t-aux ch-live-k">{line.label}</span>
            <span className="t-aux ch-live-t">{line.text}</span>
          </span>
        }
        trail={
          line.more > 0 ? (
            <span className="t-mono">+{line.more}</span>
          ) : undefined
        }
        onClick={() => setOpen(!open)}
      />
      {open && <LiveBody text={line.body} />}
    </div>
  );
}
