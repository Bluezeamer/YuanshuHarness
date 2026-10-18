import { useCallback, useEffect, useState } from "react";

export const LEFT_MIN_WIDTH = 640;
export const RIGHT_MIN_WIDTH = 900;

const key = (side: string) => `yuanshu.side.${side}`;
const read = (side: string): boolean | null => {
  try {
    const v = localStorage.getItem(key(side));
    return v === "pinned" ? true : v === "collapsed" ? false : null;
  } catch {
    return null;
  }
};

// 容器宽度（chat pane 自己的宽度）。量不到（没有 ResizeObserver，或还没回报）时返回 null，按宽度足够处理。
export function useWidth(el: HTMLElement | null): number | null {
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => {
      const last = es[es.length - 1];
      if (last) setW(last.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

// R14：折叠或固定。用户手动设置过就记住，宽度变化只影响没设置过的默认值。
export function useSide(side: string, minWidth: number, width: number | null) {
  const [pref, setPref] = useState<boolean | null>(() => read(side));
  const [open, setOpen] = useState(false);
  const pinned = pref ?? (width === null || width >= minWidth);

  const choose = useCallback(
    (v: boolean) => {
      setPref(v);
      setOpen(false);
      try {
        localStorage.setItem(key(side), v ? "pinned" : "collapsed");
      } catch {
        // 存不下就只在本次页面内生效
      }
    },
    [side],
  );
  return {
    pinned,
    open: !pinned && open,
    pin: () => choose(true),
    collapse: () => choose(false),
    toggleOpen: () => setOpen((o) => !o),
    close: () => setOpen(false),
  };
}
