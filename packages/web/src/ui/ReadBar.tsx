import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

export type ReadBarProps = Omit<ComponentProps<"div">, "children"> & {
  value: number;
  max: number;
  // 读屏名称，如“上下文占用”
  label: string;
  // 条旁的绝对值文本，如 "84k / 200k"；不给则只画条
  text?: ReactNode;
  warnAt?: number;
  dangerAt?: number;
};

// 横向读条：占用类数据一律用它，不画圆环。
export function ReadBar({
  value,
  max,
  label,
  text,
  warnAt = 0.8,
  dangerAt = 0.95,
  className,
  ...rest
}: ReadBarProps) {
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const level = ratio >= dangerAt ? "danger" : ratio >= warnAt ? "warn" : "ok";
  const style = { "--w": `${(ratio * 100).toFixed(1)}%` } as CSSProperties;
  return (
    <div className={cx("u-readbar-wrap t-mono", className)} {...rest}>
      {/* biome-ignore lint/a11y/useSemanticElements: 原生 <meter> 的轨道与填充无法用令牌跨浏览器统一着色 */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(Math.max(value, 0), max)}
        data-level={level}
        className="u-readbar"
        style={style}
      >
        <i />
      </div>
      {text !== undefined && <span>{text}</span>}
    </div>
  );
}
