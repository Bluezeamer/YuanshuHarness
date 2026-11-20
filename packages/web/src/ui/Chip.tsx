import type { ComponentProps } from "react";
import { cx } from "./cx";

export type ChipProps = ComponentProps<"span"> & {
  tone?: "on" | "live" | "warn" | "danger" | "accent";
  dot?: boolean;
};

export function Chip({ tone, dot = false, className, ...rest }: ChipProps) {
  return (
    <span
      data-tone={tone}
      data-dot={dot || undefined}
      className={cx("u-chip t-aux", className)}
      {...rest}
    />
  );
}

export type FilterChipProps = Omit<ComponentProps<"button">, "type"> & {
  pressed: boolean;
  count?: number;
};

// 筛选胶囊：aria-pressed 表达选中，count 是该筛选命中的数量。
export function FilterChip({
  pressed,
  count,
  className,
  children,
  ...rest
}: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cx("u-fchip t-aux", className)}
      {...rest}
    >
      {children}
      {count !== undefined && <span className="u-fchip-n t-mono">{count}</span>}
    </button>
  );
}

export type DotProps = Omit<ComponentProps<"span">, "children"> & {
  tone?: "live" | "warn" | "danger" | "idle" | "accent";
  size?: "sm" | "md";
  // breathe：4s 轻呼吸，只给“活着”；pulse：1.3s，给执行中
  motion?: "breathe" | "pulse";
  // 传了 label 才是有语义的图标，否则对读屏隐藏
  label?: string;
};

export function Dot({
  tone = "idle",
  size = "md",
  motion,
  label,
  className,
  ...rest
}: DotProps) {
  return (
    <span
      {...(label
        ? ({ role: "img", "aria-label": label } as const)
        : { "aria-hidden": true })}
      data-tone={tone}
      data-size={size}
      data-motion={motion}
      className={cx("u-dot", className)}
      {...rest}
    />
  );
}

export function Kbd({ className, ...rest }: ComponentProps<"kbd">) {
  return <kbd className={cx("u-kbd t-mono", className)} {...rest} />;
}
