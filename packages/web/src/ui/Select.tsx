import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { Popover } from "./Popover";

export type SelectOption = {
  value: string;
  label: string;
  /** 右侧的灰字，如「默认」「供应商名」 */
  hint?: ReactNode;
  disabled?: boolean;
};

export type SelectProps = Omit<
  ComponentProps<"button">,
  "value" | "onChange" | "type" | "children"
> & {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<SelectOption>;
  /** value 不在 options 里时显示的占位字 */
  placeholder?: string;
  /** 32 / 36 */
  size?: "md" | "lg";
};

const enabledOptions = (root: HTMLElement | null) =>
  Array.from(
    root?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? [],
  );

// 全站唯一的下拉：自绘触发器 + 浮层列表，当前项带勾。方向键、Home / End 移动，回车选中，Esc 关闭。
export function Select({
  value,
  onChange,
  options,
  placeholder,
  size = "md",
  disabled,
  className,
  onKeyDown,
  ...rest
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  // 打开即把焦点交给当前项（没有就第一项）
  useEffect(() => {
    if (!open) return;
    const els = enabledOptions(list.current);
    const on = els.find((e) => e.getAttribute("aria-selected") === "true");
    (on ?? els[0])?.focus();
  }, [open]);

  const pick = (v: string) => {
    setOpen(false);
    anchor.current?.focus();
    if (v !== value) onChange(v);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(e);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = enabledOptions(list.current);
    const at = els.indexOf(document.activeElement as HTMLElement);
    const to = {
      ArrowDown: (at + 1) % els.length,
      ArrowUp: (at - 1 + els.length) % els.length,
      Home: 0,
      End: els.length - 1,
    }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      els[to]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-value={value}
        data-size={size}
        data-empty={current ? undefined : true}
        disabled={disabled}
        className={cx("u-select t-plain", className)}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKey}
        {...rest}
      >
        <span className="u-select-v">
          {current?.label ?? placeholder ?? ""}
        </span>
        <ChevronDownIcon className="u-select-chev" />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        label={rest["aria-label"] ?? "选项"}
        role="listbox"
        width="anchor"
        panelRef={list}
        onKeyDown={onListKey}
        className="u-select-pop"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={o.value === value}
            data-value={o.value}
            disabled={o.disabled}
            className="u-option t-plain"
            onClick={() => pick(o.value)}
          >
            <CheckIcon className="u-option-ck" />
            <span className="u-option-t">{o.label}</span>
            {o.hint && <span className="u-option-hint t-aux">{o.hint}</span>}
          </button>
        ))}
      </Popover>
    </>
  );
}
