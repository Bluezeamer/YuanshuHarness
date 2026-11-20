// 整个对话标签（除审计视图）的文件拖入：拖到正文/状态条/输入框任意位置都算，
// 统一交给附件上传链路。子元素进出用计数抵消，避免高亮闪烁。
import { type DragEvent, useRef, useState } from "react";
import { toast } from "../../../ui";
import { droppedFiles, isFileDrag } from "./dropFiles";

export interface ChatFileDrop {
  dragging: boolean;
  onDragEnter(e: DragEvent<HTMLElement>): void;
  onDragOver(e: DragEvent<HTMLElement>): void;
  onDragLeave(e: DragEvent<HTMLElement>): void;
  onDrop(e: DragEvent<HTMLElement>): void;
}

export function useChatFileDrop(
  onFiles: (files: readonly File[]) => void,
): ChatFileDrop {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  return {
    dragging,
    onDragEnter(e) {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver(e) {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(e) {
      if (!isFileDrag(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(e) {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      void droppedFiles(e.dataTransfer).then((files) => {
        if (files.length === 0) {
          toast("没有找到可上传的文件", { tone: "warn" });
          return;
        }
        onFiles(files);
      });
    },
  };
}
