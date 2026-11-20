import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export type CardProps = Omit<ComponentProps<"article">, "title"> & {
  title: ReactNode;
  /** 标题右边的小标记，如 Chip */
  badge?: ReactNode;
  description?: ReactNode;
  /** 底部一行说明（能力数、被引用数……） */
  meta?: ReactNode;
  /** 悬停或键盘聚焦才出现的操作，放右上角 */
  actions?: ReactNode;
  /** 给了就整张卡片可点，标题成为可聚焦的按钮 */
  onOpen?: () => void;
};

export function Card({
  title,
  badge,
  description,
  meta,
  actions,
  onOpen,
  className,
  ...rest
}: CardProps) {
  return (
    <article
      data-open={onOpen ? true : undefined}
      className={cx("u-card", className)}
      {...rest}
    >
      <div className="u-card-h">
        {onOpen ? (
          <button
            type="button"
            className="u-card-open t-entry"
            onClick={onOpen}
          >
            {title}
          </button>
        ) : (
          <span className="u-card-title t-entry">{title}</span>
        )}
        {badge}
      </div>
      {description && <div className="u-card-d t-aux">{description}</div>}
      {meta && <div className="u-card-f t-aux">{meta}</div>}
      {actions && <div className="u-card-act u-reveal">{actions}</div>}
    </article>
  );
}
