import type { MouseEvent } from "react";
import type { MenuAt } from "./controller";

/** 右键事件 → 菜单位置 */
export const menuAt = (
  kind: MenuAt["kind"],
  id: string,
  e: Pick<MouseEvent, "clientX" | "clientY">,
): MenuAt => ({ kind, id, x: e.clientX, y: e.clientY });
