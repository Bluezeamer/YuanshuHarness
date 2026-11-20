import { useState } from "react";
import { IconButton } from "../../../ui";
import { BackIcon, ForwardIcon } from "../../../ui/icons";
import type { Prompt } from "../model/conversation";
import type { PromptEntry } from "./flowLog";
import { type Answer, PromptCard } from "./PromptCards";

// 待答的弹窗：只有一个时就是那张卡；一次来了几个（并行的 ask_user、几个工具同时要审批）合成一处，
// 卡头右侧出现「‹ 1 / 3 ›」来回切换。各卡都保持挂载、只隐藏没在看的：切走再切回，写了一半的回答还在。
export function PromptPager({
  entries,
  sessionId,
  errorOf,
  onAnswer,
}: {
  entries: readonly PromptEntry[];
  sessionId: string;
  errorOf(promptId: string): string | null;
  onAnswer(prompt: Prompt, answer: Answer, label: string): void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const n = entries.length;
  // 当前看的那张被答掉（离开了待答列表）就落到剩下的第一张
  const at = Math.max(
    0,
    entries.findIndex((e) => e.prompt.promptId === picked),
  );
  const go = (step: number) =>
    setPicked(entries[(at + step + n) % n]?.prompt.promptId ?? null);
  const pager =
    n > 1 ? (
      // biome-ignore lint/a11y/useSemanticElements: fieldset 自带边框与内边距，这里只是把两个翻页按钮成组
      <span className="ch-pager" role="group" aria-label="待答的弹窗">
        <IconButton
          size="sm"
          label="上一个"
          icon={<BackIcon />}
          onClick={() => go(-1)}
        />
        <span className="t-mono">
          {at + 1} / {n}
        </span>
        <IconButton
          size="sm"
          label="下一个"
          icon={<ForwardIcon />}
          onClick={() => go(1)}
        />
      </span>
    ) : undefined;
  return (
    <>
      {entries.map((e, i) => (
        <div key={e.prompt.promptId} hidden={i !== at}>
          <PromptCard
            sessionId={sessionId}
            entry={e}
            error={errorOf(e.prompt.promptId)}
            onAnswer={onAnswer}
            {...(i === at && pager ? { pager } : {})}
          />
        </div>
      ))}
    </>
  );
}
