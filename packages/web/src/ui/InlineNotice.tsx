import type { ComponentProps } from "react";
import { Dot } from "./Chip";
import { cx } from "./cx";

export type InlineNoticeProps = ComponentProps<"div"> & {
  tone?: "info" | "warn" | "danger";
  /** 需要更强时加一道左线；仍然不铺色块 */
  strong?: boolean;
};

// 提示条：左边一个状态点 + 文字，不铺底色。
export function InlineNotice({
  tone = "info",
  strong,
  className,
  children,
  ...rest
}: InlineNoticeProps) {
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      data-tone={tone}
      data-strong={strong || undefined}
      className={cx("u-notice t-plain", className)}
      {...rest}
    >
      <Dot tone={tone === "info" ? "idle" : tone} />
      <div>{children}</div>
    </div>
  );
}
