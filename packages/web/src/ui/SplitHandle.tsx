import type { KeyboardEvent, PointerEvent } from "react";
import { useRef, useState } from "react";
import { cx } from "./cx";

export type SplitHandleProps = {
  // 被调整那一侧面板的当前尺寸（px）
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  // 双击复位到这个值
  defaultValue: number;
  // vertical = 竖条，左右拖动调宽度；horizontal = 横条，上下拖动调高度
  orientation?: "vertical" | "horizontal";
  // 被调整的面板在手柄的右侧/下侧时为 true，拖动方向取反
  reverse?: boolean;
  step?: number;
  bigStep?: number;
  // 拖动期间每次移动都会调 onChange；使用方若想避免重绘，可只在 onDragEnd 提交
  onDragStart?: () => void;
  onDragEnd?: (value: number) => void;
  "aria-label": string;
  className?: string;
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), hi);

export function SplitHandle({
  value,
  onChange,
  min,
  max,
  defaultValue,
  orientation = "vertical",
  reverse = false,
  step = 16,
  bigStep = 48,
  onDragStart,
  onDragEnd,
  className,
  ...rest
}: SplitHandleProps) {
  const vertical = orientation === "vertical";
  const sign = reverse ? -1 : 1;
  const drag = useRef<{ from: number; start: number } | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const [dragging, setDragging] = useState(false);

  const commit = (next: number) => {
    const v = clamp(next, min, max);
    if (v === latest.current) return;
    latest.current = v;
    onChange(v);
  };

  const coord = (e: PointerEvent) => (vertical ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { from: latest.current, start: coord(e) };
    setDragging(true);
    onDragStart?.();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) commit(d.from + sign * (coord(e) - d.start));
  };

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    onDragEnd?.(latest.current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const inc = vertical ? "ArrowRight" : "ArrowDown";
    const dec = vertical ? "ArrowLeft" : "ArrowUp";
    const delta = e.shiftKey ? bigStep : step;
    let next: number | undefined;
    if (e.key === inc) next = latest.current + sign * delta;
    else if (e.key === dec) next = latest.current - sign * delta;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === undefined) return;
    e.preventDefault();
    commit(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: 可聚焦的分隔条是 ARIA window splitter 模式，<hr> 不可交互
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-orientation={orientation}
      data-dragging={dragging || undefined}
      className={cx("u-split", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => commit(defaultValue)}
      onKeyDown={onKeyDown}
      {...rest}
    />
  );
}
