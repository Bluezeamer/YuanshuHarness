// B20 双 Esc 手势：500ms 内连按两次 Esc 触发（打开历史节点浮层）。
// 只负责识别手势，不碰业务状态；触发条件由调用方按 active 传入。
import { type RefObject, useEffect, useRef } from "react";

export const DOUBLE_ESC_MS = 500;

// 焦点在对话页里（或整页没有焦点）才算；焦点在其它面板/浮层里时 Esc 属于它们自己的消费方。
const focusInChat = (shell: HTMLElement | null): boolean => {
  const el = document.activeElement;
  return !shell || !el || el === document.body || shell.contains(el);
};

export function useDoubleEscape(
  active: boolean,
  onTrigger: () => void,
  shell: RefObject<HTMLElement | null>,
): void {
  const can = useRef(active);
  can.current = active;
  const trigger = useRef(onTrigger);
  trigger.current = onTrigger;

  useEffect(() => {
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      // 已经被别的消费方（Slash 菜单 / 浮层 / 拖拽）接管的 Esc 不算第一次按下。
      if (e.defaultPrevented) {
        last = 0;
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (!can.current || !focusInChat(shell.current)) {
        last = 0;
        return;
      }
      const now = Date.now();
      if (now - last <= DOUBLE_ESC_MS) {
        last = 0;
        // 第一次 Esc 不 preventDefault；触发打开浮层时接管这次按键。
        e.preventDefault();
        trigger.current();
        return;
      }
      last = now;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shell]);
}
