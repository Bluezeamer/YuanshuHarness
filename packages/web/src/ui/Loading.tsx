import type { ComponentProps } from "react";
import { cx } from "./cx";
import { SpinnerIcon } from "./icons";

export type LoadingProps = ComponentProps<"div"> & {
  compact?: boolean;
};

// 读取中：旋转图标 + 一行灰字。不画虚线框，免得读取中与真空态长得一样；读完换成内容或 Empty。
export function Loading({
  compact = false,
  className,
  children,
  ...rest
}: LoadingProps) {
  return (
    <div
      role="status"
      data-compact={compact || undefined}
      className={cx("u-loading t-aux", className)}
      {...rest}
    >
      <SpinnerIcon className="u-spin" size={12} />
      {children}
    </div>
  );
}
