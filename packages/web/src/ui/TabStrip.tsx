import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { CloseIcon, PlusIcon } from "./icons";

export type StripTab = {
  id: string;
  title: string;
  icon?: ReactNode;
  /** 临时标签：单击预览位，标题斜体（X01），双击才固定 */
  temp?: boolean;
  closable?: boolean;
};

export type StripMainProps = Omit<ComponentProps<"button">, "type" | "role"> & {
  selected: boolean;
};

// 标签的主体按钮（图标 + 标题由使用方放进去）：TabStrip 与工作区窗格头共用。
export function StripMain({ selected, className, ...rest }: StripMainProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={cx("u-strip-main", className)}
      {...rest}
    />
  );
}

export type TabStripProps = {
  tabs: ReadonlyArray<StripTab>;
  value: string;
  onChange: (id: string) => void;
  onClose?: (id: string) => void;
  /** 双击标签：把临时标签固定下来 */
  onPin?: (id: string) => void;
  onAdd?: () => void;
  addLabel?: string;
  "aria-label": string;
  className?: string;
};

// 窗格头的标签条。每个标签的标题区宽度固定（超出省略，完整标题在 title 提示里），
// 这样增删、改名、切换标签时整条不会左右抖动。关闭键悬停或聚焦才出现。
export function TabStrip({
  tabs,
  value,
  onChange,
  onClose,
  onPin,
  onAdd,
  addLabel = "新建",
  className,
  ...rest
}: TabStripProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.id === value);
    const to = {
      ArrowRight: (at + 1) % tabs.length,
      ArrowLeft: (at - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[e.key];
    const next = to === undefined ? undefined : tabs[to];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
  };
  return (
    <div className={cx("u-strip", className)}>
      <div
        role="tablist"
        className="u-strip-list"
        onKeyDown={onKeyDown}
        {...rest}
      >
        {tabs.map((t) => {
          const on = t.id === value;
          return (
            <div
              key={t.id}
              className="u-strip-tab"
              data-on={on || undefined}
              data-temp={t.temp || undefined}
            >
              <StripMain
                selected={on}
                title={t.title}
                onClick={() => onChange(t.id)}
                onDoubleClick={() => onPin?.(t.id)}
              >
                {t.icon}
                <span className="u-strip-title t-entry">{t.title}</span>
              </StripMain>
              {t.closable !== false && onClose && (
                <IconButton
                  size="sm"
                  label={`关闭 ${t.title}`}
                  icon={<CloseIcon size={12} />}
                  className="u-strip-x u-reveal"
                  onClick={() => onClose(t.id)}
                />
              )}
            </div>
          );
        })}
      </div>
      {onAdd && (
        <IconButton
          label={addLabel}
          icon={<PlusIcon />}
          className="u-strip-add"
          onClick={onAdd}
        />
      )}
    </div>
  );
}
