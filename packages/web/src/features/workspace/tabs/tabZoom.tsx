// 标签内容的 Ctrl+滚轮缩放：只放大要读的字（对话正文、代码、预览——ui/type.css 里的内容族乘上 --tab-zoom），
// 外壳字、图标与间距不动，和界面字号设置是同一个思路；每个标签各有各的比例。
// 比例存浏览器本地（设备相关，不进布局文档），关掉标签时随 tabView 的清理一起删。
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Button } from "../../../ui";
import { useLayoutStore } from "../layoutContext";
import { readTabZoom, writeTabZoom } from "./tabView";

const MIN = 0.7;
const MAX = 2;
const STEP = 0.1;

const clamp = (v: number) =>
  Math.round(Math.min(MAX, Math.max(MIN, v)) * 10) / 10;

// 标签当前的比例：CSS 变量够不着的内容（终端的 canvas 字号）读它
const ScaleContext = createContext(1);
export const TabZoomProvider = ScaleContext.Provider;
export const useTabZoomScale = () => useContext(ScaleContext);

export function useTabZoom(tabId: string, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const workspaceId = useLayoutStore().getState().workspaceId;
  const [scale, setScale] = useState(() => {
    const saved =
      enabled && workspaceId ? readTabZoom(workspaceId, tabId) : null;
    return saved === null ? 1 : clamp(saved);
  });
  // 只有用户动过才写：没缩放过的标签不留记录
  const touched = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    // React 的 onWheel 是 passive 的，压不住浏览器的页面缩放，必须自己挂非 passive 监听。
    // 里面的内容自己处理了 Ctrl+滚轮（富文档预览、PDF）的，不再叠加。
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      touched.current = true;
      setScale((s) => clamp(s + (e.deltaY < 0 ? STEP : -STEP)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [enabled]);

  useEffect(() => {
    if (touched.current && workspaceId) writeTabZoom(workspaceId, tabId, scale);
  }, [scale, workspaceId, tabId]);

  const reset = () => {
    touched.current = true;
    setScale(1);
  };
  return { ref, scale, reset };
}

/** 当前比例，非 100% 时才出现，点一下回到 100% */
export function TabZoomBadge({
  scale,
  onReset,
}: {
  scale: number;
  onReset: () => void;
}) {
  if (scale === 1) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      className="ws-tab-zoom"
      title="点击恢复 100%"
      onClick={onReset}
    >
      {Math.round(scale * 100)}%
    </Button>
  );
}
