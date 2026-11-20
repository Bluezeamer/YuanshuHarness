import type {
  ComponentProps,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";
import { MoreIcon } from "./icons";
import { Popover, type PopoverPlacement } from "./Popover";

export type MenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: "danger";
  // 右侧 mono 小字，如“内置”
  hint?: ReactNode;
  separatorBefore?: boolean;
};

export type MenuRowProps = Omit<ComponentProps<"button">, "type" | "role"> & {
  tone?: "danger";
};

// 菜单项那一行：Menu 与自己排版的菜单（比如分步选择）共用。
export function MenuRow({ tone, className, ...rest }: MenuRowProps) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      data-tone={tone}
      className={cx("u-menu-item t-plain", className)}
      {...rest}
    />
  );
}

export type MenuTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
};

export type MenuProps = {
  items: ReadonlyArray<MenuItem>;
  // 缺省触发器是 “…” 图标按钮，label 作为它的可访问名
  label: string;
  trigger?: (props: MenuTriggerProps) => ReactNode;
  placement?: PopoverPlacement;
  className?: string;
  /** 受控打开态；不传则保持原来的触发器点击行为。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 直接按视口坐标定位（右键菜单）；给了就不需要锚点元素 */
  point?: { x: number; y: number };
};

const enabled = (root: HTMLElement | null) =>
  Array.from(
    root?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ??
      [],
  );

export function Menu({
  items,
  label,
  trigger,
  placement = "bottom-end",
  className,
  open: controlledOpen,
  onOpenChange,
  point,
}: MenuProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = () => setOpen(false);

  // 菜单打开即把焦点交给第一项，之后方向键接管
  useEffect(() => {
    if (open) enabled(list.current)[0]?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = enabled(list.current);
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
      close();
    }
  };

  const triggerProps: MenuTriggerProps = {
    ref: anchor,
    onClick: () => setOpen(!open),
    "aria-haspopup": "menu",
    "aria-expanded": open,
  };

  return (
    <>
      {trigger ? (
        trigger(triggerProps)
      ) : (
        <button
          type="button"
          className={cx("u-icon-btn", className)}
          aria-label={label}
          title={label}
          {...triggerProps}
        >
          <MoreIcon />
        </button>
      )}
      <Popover
        open={open}
        onClose={close}
        anchorRef={anchor}
        point={point}
        label={label}
        placement={placement}
        role="menu"
        panelRef={list}
        onKeyDown={onKeyDown}
        className="u-menu"
      >
        {items.map((it) => (
          <div key={it.id} role="none">
            {it.separatorBefore && <hr className="u-menu-sep" />}
            <MenuRow
              disabled={it.disabled}
              tone={it.tone}
              onClick={() => {
                close();
                anchor.current?.focus();
                it.onSelect();
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="u-menu-hint t-aux">{it.hint}</span>}
            </MenuRow>
          </div>
        ))}
      </Popover>
    </>
  );
}
