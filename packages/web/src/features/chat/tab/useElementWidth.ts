import { type RefObject, useEffect, useState } from "react";

// 量元素的真实内容宽度；右栏据此决定固定右挂还是悬浮。没有 ResizeObserver（旧环境）时取一次 clientWidth。
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === "number") setW(Math.round(next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
