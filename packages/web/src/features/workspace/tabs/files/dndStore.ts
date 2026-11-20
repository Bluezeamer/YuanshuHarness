// 文件拖拽的共享状态（kind: "file"）。原生 DnD 的 dataTransfer 在 dragover 阶段读不到内容，
// 所以被拖的东西放在这个模块级单例里，落点标签订阅它来判定、高亮。
// 与 layout/drag.ts（标签/窗格/会话拖拽）互不相通：两边各管各的单例，彼此的 dragover 都会因为对方没有拖拽物而放行。

import { useSyncExternalStore } from "react";
import type { FileDragItem } from "./verdict";

/** 幽灵条右侧的判定提示 */
export interface Hint {
  text: string;
  bad: boolean;
  /** 目标主机色（已解析的颜色值）；缺省用强调色 */
  tone: string | null;
}

export const IDLE_HINT = (hostName: string): Hint => ({
  text: hostName,
  bad: false,
  tone: null,
});

interface State {
  item: FileDragItem | null;
  hint: Hint;
  /** 指针当前悬停在哪个文件标签上；别的标签据此清掉自己的落点标记（dragleave 不一定可靠） */
  hover: string | null;
}

let state: State = { item: null, hint: IDLE_HINT(""), hover: null };
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") endFileDrag();
};

export const getFileDrag = (): FileDragItem | null => state.item;

/** dragstart 时的指针位置，幽灵条据此初始定位 */
export let startPoint = { x: 0, y: 0 };

export function beginFileDrag(
  e: { dataTransfer: DataTransfer | null; clientX?: number; clientY?: number },
  item: FileDragItem,
): void {
  startPoint = { x: e.clientX ?? 0, y: e.clientY ?? 0 };
  if (e.dataTransfer) {
    // 同主机是移动、跨主机是复制：两者都放行，由落点决定
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(
      "text/plain",
      item.entries.map((x) => x.path).join("\n"),
    );
  }
  state = { item, hint: IDLE_HINT(item.hostName), hover: null };
  window.addEventListener("keydown", onKey, true);
  emit();
}

export function endFileDrag(): void {
  if (!state.item) return;
  state = { item: null, hint: IDLE_HINT(""), hover: null };
  window.removeEventListener("keydown", onKey, true);
  emit();
}

/** 只在内容变化时才通知，dragover 每帧都会调 */
export function setHint(h: Hint): void {
  const cur = state.hint;
  if (cur.text === h.text && cur.bad === h.bad && cur.tone === h.tone) return;
  state = { ...state, hint: h };
  emit();
}

export function setHover(tabId: string | null): void {
  if (state.hover === tabId) return;
  state = { ...state, hover: tabId };
  emit();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export const useFileDrag = (): FileDragItem | null =>
  useSyncExternalStore(subscribe, () => state.item);
export const useHint = (): Hint =>
  useSyncExternalStore(subscribe, () => state.hint);
export const useHover = (): string | null =>
  useSyncExternalStore(subscribe, () => state.hover);
