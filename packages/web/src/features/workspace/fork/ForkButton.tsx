// assistant 消息右上角的分叉入口：hover / 键盘聚焦时出现，点一下就分叉。
// 纯展示组件：能不能分叉只看 disabledReason，动作与数据由上层（TurnFooter 调 flow.ts）负责。

import { IconButton, toast } from "../../../ui";
import "./fork.css";

export interface ForkButtonProps {
  /** 不能分叉的原因；有值时按钮禁用，点击/悬停都会提示 */
  disabledReason?: string | null;
  /** 分叉请求进行中：按钮置忙，避免重复提交 */
  busy?: boolean;
  onFork(): void;
}

// git-branch 风格：一条主干 + 向右分出的枝
const ForkGlyph = () => (
  <svg
    width={11}
    height={11}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4.5 13.5v-11M4.5 9.5h3.5a3 3 0 0 0 3-3v-3M11.5 3l-1.5 1.5L11.5 6" />
  </svg>
);

export function ForkButton({
  disabledReason = null,
  busy = false,
  onFork,
}: ForkButtonProps) {
  const label = busy ? "正在分叉…" : "分叉会话";
  const hint = disabledReason ?? label;
  const blocked = disabledReason !== null || busy;
  return (
    <span className="ch-fork" data-busy={busy || undefined}>
      <IconButton
        label={label}
        icon={<ForkGlyph />}
        className="ch-fork-btn"
        title={hint}
        aria-disabled={blocked || undefined}
        aria-busy={busy || undefined}
        onClick={() => {
          // 禁用时给一句提示而不是静默无响应；忙时直接吞掉重复点击
          if (disabledReason !== null) toast(disabledReason, { tone: "warn" });
          else if (!busy) onFork();
        }}
      />
    </span>
  );
}
