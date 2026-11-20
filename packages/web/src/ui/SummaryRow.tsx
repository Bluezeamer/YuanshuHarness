import type { ComponentProps, ReactNode } from "react";
import { Dot } from "./Chip";
import { cx } from "./cx";
import { ChevronRightIcon } from "./icons";

export type SummaryRowProps = Omit<ComponentProps<"div">, "title"> & {
  label: ReactNode;
  value: ReactNode;
  /** 值后面的灰字，如「跟随默认」「无改动」 */
  note?: ReactNode;
  /** 值有问题时给一个红点 */
  tone?: "danger";
  onOpen: () => void;
  /** X02：值被覆盖时给出「恢复跟随」；跟随中就不要传 */
  onReset?: () => void;
  resetLabel?: string;
};

// 折叠成一行的次要设置：名称 + 值 + 灰色备注，悬停出现箭头，点进去展开。
export function SummaryRow({
  label,
  value,
  note,
  tone,
  onOpen,
  onReset,
  resetLabel = "恢复跟随",
  className,
  ...rest
}: SummaryRowProps) {
  return (
    <div className={cx("u-srow", className)} {...rest}>
      <button type="button" className="u-srow-main" onClick={onOpen}>
        <span className="u-srow-k t-aux">{label}</span>
        <span className="u-srow-v t-plain">
          {tone && <Dot tone={tone} />}
          {value}
          {note && <span className="u-srow-note t-aux">· {note}</span>}
        </span>
      </button>
      {onReset && (
        <button type="button" className="u-srow-reset t-aux" onClick={onReset}>
          {resetLabel}
        </button>
      )}
      <ChevronRightIcon className="u-srow-go u-reveal" />
    </div>
  );
}
