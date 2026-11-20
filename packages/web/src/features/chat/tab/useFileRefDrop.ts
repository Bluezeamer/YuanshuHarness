// 从文件浏览器把条目拖进对话区：不是上传，而是插入一条文件引用
// `file:<主机>:<绝对路径>`（与内嵌图片、输出里的文件链接同一套约定），多选时每行一条。
// 与 useChatFileDrop 分工：那个只接管系统文件（types 含 Files），这个只接管内部文件行拖拽。
import { type DragEvent, useRef, useState } from "react";
import { getFileDrag } from "../../workspace/tabs/files/dndStore";
import type { FileDragItem } from "../../workspace/tabs/files/verdict";

/** 拖拽物 → 要插入的引用文本 */
export function refTextOf(item: FileDragItem): string {
  return item.entries.map((e) => `file:${item.host}:${e.path}`).join("\n");
}

export interface FileRefDrop {
  dragging: boolean;
  onDragEnter(e: DragEvent<HTMLElement>): void;
  onDragOver(e: DragEvent<HTMLElement>): void;
  onDragLeave(e: DragEvent<HTMLElement>): void;
  onDrop(e: DragEvent<HTMLElement>): void;
}

export function useFileRefDrop(onInsert: (text: string) => void): FileRefDrop {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const active = () => getFileDrag() !== null;
  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };
  return {
    dragging,
    onDragEnter(e) {
      if (!active()) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver(e) {
      if (!active()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave() {
      if (!active()) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(e) {
      const item = getFileDrag();
      if (!item) return;
      e.preventDefault();
      reset();
      onInsert(refTextOf(item));
    },
  };
}
