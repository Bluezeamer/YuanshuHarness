// 窗口条：一排浅灰胶囊，切换 / 新增 / 关闭；胶囊也是拖放落点（把窗格拖到窗口标签上）。
// 键盘：←/→ 在胶囊间循环并切换。落点的判定由调用方给（droppable），放下时回调 onDropTo。

import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { CloseIcon, PlusIcon } from "../icons";

export interface WindowBarProps {
  labels: readonly string[];
  active: number;
  onSwitch(i: number): void;
  onAdd(): void;
  /** 给了才出现 ×（调用方在只剩一个窗口时不给） */
  onClose?(i: number): void;
  /** 此刻拖着的东西能放到窗口标签上 */
  droppable?: boolean;
  onDropTo?(i: number): void;
  /** 右端的提示，平时不放，拖拽时才给 */
  hint?: ReactNode;
  "aria-label": string;
  addLabel: string;
}

export function WindowBar({
  labels,
  active,
  onSwitch,
  onAdd,
  onClose,
  droppable = false,
  onDropTo,
  hint,
  addLabel,
  "aria-label": ariaLabel,
}: WindowBarProps) {
  const list = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<number | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = labels.length;
    const to =
      e.key === "ArrowRight"
        ? (active + 1) % n
        : e.key === "ArrowLeft"
          ? (active - 1 + n) % n
          : undefined;
    if (to === undefined) return;
    e.preventDefault();
    onSwitch(to);
    requestAnimationFrame(() =>
      list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus(),
    );
  };

  const onOver = (e: DragEvent<HTMLElement>, i: number) => {
    if (!droppable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver(i);
  };

  const onDrop = (e: DragEvent<HTMLElement>, i: number) => {
    setOver(null);
    if (!droppable) return;
    e.preventDefault();
    onDropTo?.(i);
  };

  return (
    <div className="u-wbar">
      <div
        ref={list}
        className="u-wbar-list"
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
      >
        {labels.map((label, i) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: 包裹层只作拖放的落点，交互在内部 button 上
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 窗口按位置识别
            key={i}
            className="u-wbar-tab"
            role="presentation"
            data-on={i === active || undefined}
            data-drop={(droppable && over === i) || undefined}
            onDragOver={(e) => onOver(e, i)}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => onDrop(e, i)}
          >
            <button
              type="button"
              role="tab"
              className="u-wbar-main t-entry"
              aria-selected={i === active}
              tabIndex={i === active ? 0 : -1}
              onClick={() => onSwitch(i)}
            >
              {label}
            </button>
            {onClose && (
              <button
                type="button"
                className="u-icon-btn u-reveal u-wbar-x"
                data-size="sm"
                tabIndex={-1}
                aria-label={`关闭${label}`}
                onClick={() => onClose(i)}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="u-icon-btn"
        aria-label={addLabel}
        title={addLabel}
        onClick={onAdd}
      >
        <PlusIcon />
      </button>
      {hint && <span className="u-wbar-hint t-aux">{hint}</span>}
    </div>
  );
}
