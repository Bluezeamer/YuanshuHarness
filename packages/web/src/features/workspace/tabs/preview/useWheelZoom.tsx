// 富内容预览的缩放：Ctrl + 滚轮在预览区内调大小，而不是缩放整个浏览器页面。
// 用 CSS zoom 而不是 transform：zoom 会一并缩放布局，滚动条与命中区域都对，transform 不会。
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../../ui";

const MIN = 0.5;
const MAX = 3;
const STEP = 0.1;

const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

export function useWheelZoom(initial = 1) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(initial);

  const reset = useCallback(() => setScale(initial), [initial]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // React 的 onWheel 是 passive 的，压不住浏览器的页面缩放，必须自己挂非 passive 监听。
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setScale((s) => clamp(s + (e.deltaY < 0 ? STEP : -STEP)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return { ref, scale, reset };
}

/** 缩放指示条：只在非 100% 时出现，点一下回到 100%。 */
export function ZoomBadge({
  scale,
  onReset,
}: {
  scale: number;
  onReset: () => void;
}) {
  if (Math.abs(scale - 1) < 0.001) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      className="ws-pv-zoom-badge"
      title="点击恢复 100%"
      onClick={onReset}
    >
      {Math.round(scale * 100)}%
    </Button>
  );
}
