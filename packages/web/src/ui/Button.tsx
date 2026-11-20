import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { SpinnerIcon } from "./icons";

export type ButtonProps = Omit<ComponentProps<"button">, "type"> & {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "md" | "sm" | "lg";
  icon?: ReactNode;
  loading?: boolean;
  // 两步确认上膛态，由 ConfirmButton 驱动
  armed?: boolean;
  type?: "button" | "submit" | "reset";
};

export function Button({
  variant = "outline",
  size = "md",
  icon,
  loading = false,
  armed = false,
  type = "button",
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-size={size}
      data-armed={armed || undefined}
      className={cx("u-btn t-entry", className)}
      {...rest}
    >
      {loading ? <SpinnerIcon className="u-spin" size={12} /> : icon}
      {children}
    </button>
  );
}

export type IconButtonProps = Omit<
  ComponentProps<"button">,
  "type" | "children" | "aria-label"
> & {
  // 纯图标按钮必须有可访问名，同时用作悬停提示
  label: string;
  icon: ReactNode;
  pressed?: boolean;
  size?: "md" | "sm";
};

export function IconButton({
  label,
  icon,
  pressed,
  size = "md",
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-size={size}
      className={cx("u-icon-btn", className)}
      {...rest}
    >
      {icon}
    </button>
  );
}
