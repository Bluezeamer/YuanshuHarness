// 拖放共享状态：原生 HTML5 DnD 的 dataTransfer 在 dragover 阶段读不到内容，
// 所以被拖的东西放在这个模块级单例里，落点组件订阅它来决定是否接受、怎么高亮。
// Esc：浏览器原生会取消拖拽并触发 dragend；这里额外监听 keydown 立刻清掉高亮，
// 并让之后的 drop 变成空操作（getDrag() 为 null）。

import { useSyncExternalStore } from "react";
import type { PointInBox } from "../../../ui/tiling";
import type { HostId, Tab } from "../model/types";

export type DragItem =
  | { kind: "tab"; fromPid: string; tid: string; tab: Tab }
  | { kind: "pane"; pid: string; host: HostId | null }
  | { kind: "session"; sid: string };

let current: DragItem | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of [...listeners]) l();
};

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") endDrag();
};

export const getDrag = (): DragItem | null => current;

export function startDrag(item: DragItem): void {
  current = item;
  window.addEventListener("keydown", onKey, true);
  emit();
}

export function endDrag(): void {
  if (!current) return;
  current = null;
  window.removeEventListener("keydown", onKey, true);
  emit();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export const useDrag = (): DragItem | null =>
  useSyncExternalStore(subscribe, getDrag);

/** 在 dragstart 里调用：登记拖拽物并设置 dataTransfer（Firefox 没有数据不会开始拖） */
export function beginDrag(
  e: { dataTransfer: DataTransfer | null },
  item: DragItem,
): void {
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.kind);
  }
  startDrag(item);
}

/** 指针相对元素左上角的位置（供 *DropZone 判定用） */
export function pointIn(
  e: { clientX: number; clientY: number },
  el: Element,
): PointInBox {
  const r = el.getBoundingClientRect();
  return {
    x: e.clientX - r.left,
    y: e.clientY - r.top,
    width: r.width,
    height: r.height,
  };
}
