// 触控板双指滑动平移画布；物理滚轮（一格一格的大步长）与捏合（ctrlKey）仍交给 xyflow 缩放。
import { useReactFlow } from "@xyflow/react";
import { type RefObject, useEffect } from "react";

interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

// 同一次滑动里的事件连成一串，间隔超过这个时间算新的一次
const BURST_GAP_MS = 150;
// 触控板的像素步长很小（几到十几），物理滚轮一格通常上百；Firefox 的滚轮按「行」计，不在这个分支里
const TRACKPAD_MAX_STEP = 30;

/** 一次滑动的第一个事件像不像触控板：横向有位移，或像素步长很小 */
export const looksLikeTrackpad = (e: WheelLike): boolean =>
  e.deltaMode === 0 &&
  (e.deltaX !== 0 || Math.abs(e.deltaY) < TRACKPAD_MAX_STEP);

export function useWheelPan(host: RefObject<HTMLElement | null>): void {
  const rf = useReactFlow();
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let until = 0;
    let pan = false;
    const onWheel = (e: WheelEvent) => {
      // 捏合（浏览器给成 ctrl+滚轮）与 Ctrl+滚轮：缩放；卡片里可滚动的内容：让它自己滚
      if (e.ctrlKey || (e.target as Element).closest(".nowheel")) return;
      // 整串事件沿用第一个事件的判断：否则一次滑动里忽大忽小的步长会在平移与缩放之间来回切
      if (e.timeStamp > until) pan = looksLikeTrackpad(e);
      until = e.timeStamp + BURST_GAP_MS;
      if (!pan) return;
      e.preventDefault();
      e.stopPropagation();
      const v = rf.getViewport();
      void rf.setViewport({
        x: v.x - e.deltaX,
        y: v.y - e.deltaY,
        zoom: v.zoom,
      });
    };
    // 捕获阶段：要赶在 xyflow 自己的滚轮缩放之前
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [host, rf]);
}
