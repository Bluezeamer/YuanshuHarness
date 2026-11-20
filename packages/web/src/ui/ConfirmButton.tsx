import { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "./Button";

export type ConfirmButtonProps = Omit<ButtonProps, "onClick" | "armed"> & {
  onConfirm: () => void;
  // 上膛后显示的文案
  armedLabel?: string;
  // 超时自动解除上膛
  timeoutMs?: number;
};

// 两步确认：第一次点击上膛，第二次才执行；超时或 Esc 自动复位。
export function ConfirmButton({
  onConfirm,
  armedLabel = "确认…",
  timeoutMs = 3200,
  variant = "danger",
  children,
  onKeyDown,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const disarm = () => {
    clearTimeout(timer.current);
    setArmed(false);
  };

  const handleClick = () => {
    if (armed) {
      disarm();
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), timeoutMs);
  };

  return (
    <Button
      variant={variant}
      armed={armed}
      onClick={handleClick}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        // 已上膛时 Esc 只负责解除，不再冒泡去关外层弹窗
        if (armed && e.key === "Escape") {
          e.stopPropagation();
          disarm();
        }
      }}
      {...rest}
    >
      {armed ? armedLabel : children}
    </Button>
  );
}
