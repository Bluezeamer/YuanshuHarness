// 预览工具条的两个槽位：lead（文件信息之前，放「预览 / 编辑」切换）与 tail（最右，放未保存 / 还原 / 保存）。
// 工具条由 PreviewTab 画；切换在 TextView、保存在 CodeEditor，它们各自的状态不上提，只把控件 portal 进槽位。
import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

type Slot = "lead" | "tail";
type Slots = Record<Slot, HTMLElement | null>;

const Ctx = createContext<Slots>({ lead: null, tail: null });

export const BarSlotsProvider = Ctx.Provider;

export function BarPortal({
  slot,
  children,
}: {
  slot: Slot;
  children: ReactNode;
}) {
  const target = useContext(Ctx)[slot];
  return target ? createPortal(children, target) : null;
}
