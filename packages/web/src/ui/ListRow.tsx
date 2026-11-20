import type { ComponentProps, MouseEventHandler, ReactNode } from "react";
import { cx } from "./cx";
import { HoverCard } from "./HoverCard";

export type ListRowProps = Omit<
  ComponentProps<"div">,
  "title" | "onClick" | "onDoubleClick"
> & {
  label: ReactNode;
  /** 名字下面的一行灰字；有它时行高自动撑到两行 */
  sub?: ReactNode;
  /** 名字左边：状态点、图标 */
  lead?: ReactNode;
  /** 右侧的辅助文字（时间、数量） */
  trail?: ReactNode;
  /** 悬停或键盘聚焦才出现的操作；出现时盖住 trail */
  actions?: ReactNode;
  /** 悬停详情卡片的内容（只读，放行里没有的信息）；约定见 ys-ui-design 的 X05 */
  peek?: ReactNode;
  /** 名字被省略时的完整提示，放在主按钮上 */
  title?: string;
  size?: "compact" | "comfort";
  /** 当前打开的那一行 */
  current?: boolean;
  /** 被多选选中的行 */
  selected?: boolean;
  /** 展开 / 收起的行（折叠区的标题行）：写到主按钮的 aria-expanded */
  expanded?: boolean;
  /** 不可点的行（灰字，主按钮禁用） */
  disabled?: boolean;
  // X01：单击临时查看、双击固定，由使用方在这两个回调里实现
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onDoubleClick?: MouseEventHandler<HTMLButtonElement>;
};

export function ListRow({
  label,
  sub,
  lead,
  trail,
  actions,
  peek,
  title,
  size = "comfort",
  current,
  selected,
  expanded,
  disabled,
  onClick,
  onDoubleClick,
  className,
  ...rest
}: ListRowProps) {
  const row = (
    <div
      data-size={size}
      data-sub={sub ? true : undefined}
      data-actions={actions ? true : undefined}
      data-current={current || undefined}
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
      className={cx("u-lrow", className)}
      {...rest}
    >
      <button
        type="button"
        className="u-lrow-main"
        aria-current={current || undefined}
        aria-expanded={expanded}
        disabled={disabled}
        title={title}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        {lead}
        <span className="u-lrow-text">
          <span className="u-lrow-label t-entry">{label}</span>
          {sub && <span className="u-lrow-sub t-aux">{sub}</span>}
        </span>
        {trail && <span className="u-lrow-trail t-aux">{trail}</span>}
      </button>
      {actions && <div className="u-lrow-act u-reveal">{actions}</div>}
    </div>
  );
  return peek ? <HoverCard card={peek}>{row}</HoverCard> : row;
}
