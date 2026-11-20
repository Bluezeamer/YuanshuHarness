// 悬浮面板的开合：鼠标一移进触发区就展开，移出去一会儿（CLOSE_DELAY_MS）才收回，中途回来不收；点按钮是手动开合。
// 面板里在做事（改名、菜单、对话框、拖拽……）算「忙」，忙着不收，忙完鼠标还在外面才开始计时收回。
import { useCallback, useEffect, useRef, useState } from "react";

export const CLOSE_DELAY_MS = 300;

export interface FloatPanel {
  open: boolean;
  /** 是点按钮手动展开的（不是悬停展开的） */
  manual: boolean;
  /** 触发区与面板都挂这两个：鼠标进出 */
  onPointerEnter(): void;
  onPointerLeave(): void;
  /**
   * 点按钮：没开就手动展开；悬停展开着（还没手动）就改成手动，让它留着；已经是手动的就收起。
   * 手动的不会因为鼠标离开而收回，要再点、按 Esc、或点了面板以外的地方。
   */
  toggle(): void;
  close(): void;
}

export function useFloatPanel(opts: {
  /** 悬浮模式才有效；换成固定模式时收起 */
  enabled: boolean;
  /** 面板里有没有在做事 */
  busy: boolean;
  /** 面板的根元素：点在它外面算「点了别处」 */
  panel: React.RefObject<HTMLElement | null>;
}): FloatPanel {
  const { enabled, busy, panel } = opts;
  const [open, setOpen] = useState(false);
  const [manual, setManualState] = useState(false);
  const manualRef = useRef(false);
  const openRef = useRef(false);
  openRef.current = open;
  const setManual = useCallback((v: boolean) => {
    manualRef.current = v;
    setManualState(v);
  }, []);
  const inside = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const clear = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!inside.current && !busyRef.current && !manualRef.current)
        setOpen(false);
    }, CLOSE_DELAY_MS);
  }, []);

  const onPointerEnter = useCallback(() => {
    inside.current = true;
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (!enabled || open) return;
    setManual(false);
    setOpen(true);
  }, [enabled, open, setManual]);

  const onPointerLeave = useCallback(() => {
    inside.current = false;
    if (open && !manualRef.current && !busyRef.current) scheduleClose();
  }, [open, scheduleClose]);

  const toggle = useCallback(() => {
    clear();
    if (openRef.current && manualRef.current) setOpen(false);
    else {
      setManual(true);
      setOpen(true);
    }
  }, [clear, setManual]);

  const close = useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);

  // 忙完了而鼠标已经在外面：现在才开始计时收回
  useEffect(() => {
    if (open && !busy && !inside.current && !manualRef.current) scheduleClose();
  }, [busy, open, scheduleClose]);

  // 点开的：点面板以外的地方或按 Esc 收起（面板自己弹出的菜单与对话框在 portal 里，忙着时不理会）
  useEffect(() => {
    if (!open || !manual) return;
    const down = (e: PointerEvent) => {
      if (busyRef.current) return;
      // 开关按钮自己的点击交给它的 onClick（toggle），不然这里先收起、click 又把它打开
      if ((e.target as Element).closest?.("[data-float-toggle]")) return;
      if (panel.current && !panel.current.contains(e.target as Node))
        setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) setOpen(false);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, manual, panel]);

  // 切回固定模式：悬浮的展开状态作废
  useEffect(() => {
    if (!enabled) {
      clear();
      setOpen(false);
    }
  }, [enabled, clear]);

  useEffect(() => clear, [clear]);

  return { open, manual, onPointerEnter, onPointerLeave, toggle, close };
}
