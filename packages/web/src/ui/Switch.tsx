import type { ComponentProps } from "react";
import { cx } from "./cx";
import { CheckIcon, MinusIcon } from "./icons";

export type SwitchProps = Omit<
  ComponentProps<"button">,
  "type" | "role" | "onChange" | "children"
> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export function Switch({
  checked,
  onChange,
  className,
  onClick,
  ...rest
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx("u-switch", className)}
      onClick={(e) => {
        onClick?.(e);
        onChange(!checked);
      }}
      {...rest}
    />
  );
}

export type CheckboxProps = Omit<
  ComponentProps<"button">,
  "type" | "role" | "onChange"
> & {
  // "mixed" 为半选；点击半选视为“全选”
  checked: boolean | "mixed";
  onChange: (checked: boolean) => void;
};

export function Checkbox({
  checked,
  onChange,
  className,
  onClick,
  children,
  ...rest
}: CheckboxProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 原生 checkbox 无法表达半选的自绘外观，aria-checked 支持 mixed
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={cx("u-check t-plain", className)}
      onClick={(e) => {
        onClick?.(e);
        onChange(checked !== true);
      }}
      {...rest}
    >
      <span className="u-check-box" aria-hidden="true">
        {checked === "mixed" ? <MinusIcon /> : <CheckIcon />}
      </span>
      {children}
    </button>
  );
}
