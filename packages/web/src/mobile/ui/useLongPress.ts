// 长按：触屏上按住不动 500 毫秒触发（鼠标不用）；中途手指移动（要滚动了）或抬起就取消。
// 触发之后吞掉随后那一下点击，并挡住系统自己的长按菜单。
// 抬手时浏览器还会补发鼠标事件与点击：长按弹出的抽屉已经盖在手指下面，补发的 mousedown 会落在它的遮罩上把它关掉，
// 所以要在 touchend 里取消默认行为（这样不会再补发任何鼠标事件）。
import {
  type MouseEvent,
  type PointerEvent,
  type TouchEvent,
  useRef,
} from "react";

const HOLD_MS = 500;
const SLOP = 8;

export function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    origin.current = null;
  };
  return {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType === "mouse") return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        origin.current = null;
        onLong();
      }, HOLD_MS);
    },
    onPointerMove(e: PointerEvent) {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > SLOP) cancel();
    },
    onTouchEnd(e: TouchEvent) {
      if (fired.current && e.cancelable) e.preventDefault();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
    onClickCapture(e: MouseEvent) {
      if (!fired.current) return;
      fired.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };
}
