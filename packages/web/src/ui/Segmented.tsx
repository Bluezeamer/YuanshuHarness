import type { ComponentProps, KeyboardEvent } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "./cx";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** 标签后的 mono 计数（如「审计 11」）；缺省不显示 */
  count?: number;
  disabled?: boolean;
};

export type SegmentedProps<T extends string> = Omit<
  ComponentProps<"div">,
  "onChange" | "role" | "children"
> & {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: "md" | "sm";
  disabled?: boolean;
};

const KEY_STEP: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

// 单选组：只有选中项在 Tab 序列里，方向键在启用项之间循环并立即选中（与原生 radio 一致）。
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  disabled = false,
  className,
  ...rest
}: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const hasChecked = options.some((o) => o.value === value && !o.disabled);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  // 量选中项的位置；容器缩放后宽度会变，所以随尺寸变化重量
  // biome-ignore lint/correctness/useExhaustiveDependencies: value 与 options 变化时要重新量
  useLayoutEffect(() => {
    const measure = () => {
      const el = group.current?.querySelector<HTMLElement>(
        '[aria-checked="true"]',
      );
      setPill(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !group.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(group.current);
    return () => ro.disconnect();
  }, [value, options]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEP[e.key];
    if (!step || disabled) return;
    const enabled = options.filter((o) => !o.disabled);
    const at = enabled.findIndex((o) => o.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    group.current
      ?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)
      ?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-disabled={disabled || undefined}
      data-size={size}
      className={cx("u-seg", className)}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {pill && (
        <i
          aria-hidden="true"
          className="u-seg-pill"
          style={{ left: pill.x, width: pill.w }}
        />
      )}
      {options.map((opt, i) => {
        const checked = opt.value === value;
        // 当前值不可选时，退化为第一项可聚焦，避免整组跳出 Tab 序列
        const tabbable = checked || (!hasChecked && i === 0);
        return (
          // biome-ignore lint/a11y/useSemanticElements: 分段按钮需要自绘外观，方向键与 roving tabindex 在 onKeyDown 里实现
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={opt.value}
            tabIndex={tabbable ? 0 : -1}
            className={size === "sm" ? "t-aux" : "t-plain"}
            disabled={disabled || opt.disabled}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
            {opt.count !== undefined && (
              <>
                {" "}
                <span className="u-seg-n t-mono">{opt.count}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type TriValue = "auto" | "on" | "off";

const TRI_OPTIONS: ReadonlyArray<SegmentedOption<TriValue>> = [
  { value: "auto", label: "自动" },
  { value: "on", label: "开" },
  { value: "off", label: "关" },
];

// 三段开关：未设置（交给端点自动推断）/ 开 / 关。
export function Tri(props: Omit<SegmentedProps<TriValue>, "options">) {
  return <Segmented size="sm" options={TRI_OPTIONS} {...props} />;
}
