import type { KeyboardEventHandler, ReactNode, RefObject } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { LayerDepth, useDismissLayer, useOutsidePress } from "./overlay";

export type PopoverPlacement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top-end";

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /** 锚点元素；给了 point 时可以不给 */
  anchorRef?: RefObject<HTMLElement | null>;
  /** 直接按视口坐标定位（右键菜单这类没有锚点元素的场景） */
  point?: { x: number; y: number };
  // 读屏名称
  label: string;
  placement?: PopoverPlacement;
  // "anchor" = 不小于锚点宽；数字 = 固定 px；缺省按内容
  width?: number | "anchor";
  role?: "dialog" | "menu" | "listbox";
  // 需要读取面板 DOM 时传入（Menu 用它找菜单项）
  panelRef?: RefObject<HTMLDivElement | null>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  className?: string;
  children: ReactNode;
};

const GAP = 4;
const EDGE = 8;

// 锚点下方展开，放不下就翻到上方；水平方向夹在视口内。
function place(
  rect: { top: number; bottom: number; left: number; right: number },
  panel: HTMLElement,
  p: PopoverPlacement,
) {
  const a = rect;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const below = window.innerHeight - a.bottom - GAP - EDGE;
  const top = p.startsWith("top")
    ? Math.max(EDGE, a.top - GAP - h)
    : h > below && a.top - GAP - EDGE > below
      ? Math.max(EDGE, a.top - GAP - h)
      : a.bottom + GAP;
  const raw = p.endsWith("end") ? a.right - w : a.left;
  const left = Math.min(Math.max(EDGE, raw), window.innerWidth - w - EDGE);
  return { top, left: Math.max(EDGE, left) };
}

// 不引入定位库：浮层只有“锚点下方，放不下翻到上方”这一种形态。
export function Popover({
  open,
  onClose,
  anchorRef,
  point,
  label,
  placement = "bottom-start",
  width,
  role = "dialog",
  panelRef,
  onKeyDown,
  className,
  children,
}: PopoverProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const panel = panelRef ?? ownRef;
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const depth = useDismissLayer(open, () => {
    onClose();
    anchorRef?.current?.focus();
  });
  useOutsidePress(open, anchorRef ? [panel, anchorRef] : [panel], onClose);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = anchorRef?.current;
      const p = panel.current;
      if (!p) return;
      if (point) {
        // 指针坐标：锚点矩形退化成一点，交给同一套夹取逻辑
        setPos(
          place(
            { top: point.y, bottom: point.y, left: point.x, right: point.x },
            p,
            placement,
          ),
        );
        return;
      }
      if (el) setPos(place(el.getBoundingClientRect(), p, placement));
    };
    update();
    // 过滤/异步内容会让面板高度变化；不重算位置会停在按旧高度算出的上方。
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => update());
    if (ro && panel.current) ro.observe(panel.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef, point, panel, placement]);

  if (!open) return null;
  const minWidth =
    width === "anchor" ? anchorRef?.current?.offsetWidth : undefined;
  return createPortal(
    <LayerDepth.Provider value={depth}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: role 在运行时恒为 dialog 或 menu，onKeyDown 只给 menu 的方向键导航用 */}
      <div
        ref={panel}
        // 展开成对象：role 是联合类型，静态检查无法推断 aria-label 是否合法
        {...{ role, "aria-label": label }}
        onKeyDown={onKeyDown}
        className={cx("u-pop", className)}
        style={{
          top: pos.top,
          left: pos.left,
          width: typeof width === "number" ? width : undefined,
          minWidth,
        }}
      >
        {children}
      </div>
    </LayerDepth.Provider>,
    document.body,
  );
}
