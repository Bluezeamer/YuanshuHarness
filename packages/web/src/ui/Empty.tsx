import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export type EmptyProps = Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  // 灰色说明，写清“为什么空”以及“下一步”
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  /** 读取失败、无法打开这类出错的状态：标题变红，与「还没有」分开 */
  tone?: "danger";
};

export function Empty({
  title,
  description,
  action,
  compact = false,
  tone,
  className,
  ...rest
}: EmptyProps) {
  return (
    <div
      data-compact={compact || undefined}
      data-tone={tone}
      className={cx("u-empty", className)}
      {...rest}
    >
      <div className="u-empty-title t-entry">{title}</div>
      {description && <div className="u-empty-desc t-aux">{description}</div>}
      {action}
    </div>
  );
}
