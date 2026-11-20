// 把东西拖到画布上：文件管理器里的条目不是上传，而是放一个项目文件引用；从系统里拖进来的文件才是上传。
// 前者与聊天输入框的 useFileRefDrop 同一套：被拖的东西在 dndStore 的单例里，dragover 阶段读不到 dataTransfer 内容。
import { type DragEvent, useRef, useState } from "react";
import { getFileDrag } from "../files/dndStore";
import type { FileDragItem } from "../files/verdict";
import { NOTE_DRAG_TYPE } from "./navTree";

export interface CanvasFileDrop {
  dragging: boolean;
  onDragEnter(e: DragEvent<HTMLElement>): void;
  onDragOver(e: DragEvent<HTMLElement>): void;
  onDragLeave(e: DragEvent<HTMLElement>): void;
  onDrop(e: DragEvent<HTMLElement>): void;
}

export function useCanvasFileDrop(
  onFile: (item: FileDragItem, at: { x: number; y: number }) => void,
  onOsFiles: (files: File[], at: { x: number; y: number }) => void,
  /** 从左边的树里拖来的笔记（路径相对 `.canvas/`） */
  onNotes: (paths: string[], at: { x: number; y: number }) => void,
): CanvasFileDrop {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  // 系统里拖来的文件：dragover 阶段只能看到类型里有 "Files"，内容要到 drop 才读得到
  const fromOs = (e: DragEvent<HTMLElement>) =>
    getFileDrag() === null &&
    Array.from(e.dataTransfer.types).includes("Files");
  const fromTree = (e: DragEvent<HTMLElement>) =>
    Array.from(e.dataTransfer.types).includes(NOTE_DRAG_TYPE);
  const active = (e: DragEvent<HTMLElement>) =>
    getFileDrag() !== null || fromOs(e) || fromTree(e);
  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };
  return {
    dragging,
    onDragEnter(e) {
      if (!active(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver(e) {
      if (!active(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(e) {
      if (!active(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(e) {
      const item = getFileDrag();
      const at = { x: e.clientX, y: e.clientY };
      if (item) {
        e.preventDefault();
        reset();
        onFile(item, at);
      } else if (fromTree(e)) {
        e.preventDefault();
        reset();
        try {
          const paths = JSON.parse(e.dataTransfer.getData(NOTE_DRAG_TYPE));
          if (Array.isArray(paths) && paths.length > 0)
            onNotes(
              paths.filter((p) => typeof p === "string"),
              at,
            );
        } catch {
          // 载荷坏了：当没拖
        }
      } else if (fromOs(e)) {
        e.preventDefault();
        reset();
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onOsFiles(files, at);
      }
    },
  };
}
