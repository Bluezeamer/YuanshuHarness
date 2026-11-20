import type { DragEvent } from "react";
import type { SidebarController, WsDropTarget } from "./controller";

/** 拖着工作区时，这个落点接受 dragover / drop；没在拖工作区就什么都不加，不干扰别的拖拽 */
export function wsDropProps(c: SidebarController, target: WsDropTarget) {
  if (c.drag?.workspace === undefined) return {};
  return {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      c.dragOver(target);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
        c.dragOver(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      c.dropWorkspace(target);
    },
  };
}

/** 工作区拖到某个分组（null = 未分组）上时，该落点是否高亮 */
export const overGroup = (c: SidebarController, group: string | null) => {
  const over = c.drag?.over;
  return over !== undefined && "group" in over && over.group === group;
};

/** 工作区拖到某个工作区头上（会插到它前面） */
export const overBefore = (c: SidebarController, id: string) => {
  const over = c.drag?.over;
  return over !== undefined && "before" in over && over.before === id;
};
