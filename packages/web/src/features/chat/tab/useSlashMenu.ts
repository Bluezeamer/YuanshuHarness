import { type KeyboardEvent, useState } from "react";
import type { InsertApi } from "./InsertMenus";
import { filterSlash, pickable, type SlashOption, slashOptions } from "./slash";
import type { ChatConfig } from "./useChatConfig";

// 斜杠菜单的状态：空输入框里按 / 打开，输入过滤，↑↓ 在可选项里循环，Enter / Tab 选中，Esc 关闭并清掉 /xxx。
// 焦点始终留在输入框；MCP 这类只读行不进键盘选择。
export function useSlashMenu({
  cfg,
  insert,
  text,
  setText,
}: {
  cfg: ChatConfig;
  insert: InsertApi;
  text: string;
  setText(next: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);

  const options = filterSlash(slashOptions(cfg.context, insert.command), query);
  const keys = pickable(options);
  const active = Math.min(at, Math.max(0, keys.length - 1));

  const show = () => {
    cfg.refetchContext();
    setAt(0);
    setQuery("");
    setOpen(true);
  };
  const close = (clearDraft = false) => {
    setOpen(false);
    setQuery("");
    if (clearDraft && text.startsWith("/"))
      setText(text.replace(/^\/\S*\s?/, ""));
  };
  const pick = (option: SlashOption) => {
    setOpen(false);
    setQuery("");
    option.run?.();
  };
  const move = (delta: number) => {
    if (keys.length === 0) return;
    setAt((active + delta + keys.length) % keys.length);
  };

  return {
    open,
    options,
    active,
    close,
    pick,
    /** textarea 的 onChange：跟着输入开、关、过滤菜单 */
    onChange(next: string) {
      if (open) {
        // 退格删掉 / 前缀，或输入了非命令文本：收起菜单。
        if (!next.startsWith("/")) close();
        else {
          setQuery(next.slice(1).trim().toLowerCase());
          setAt(0);
        }
      } else if (next === "/") {
        // 输入法 / 键盘布局吞掉 keydown 时的兜底。
        show();
      }
    },
    /** textarea 的 onKeyDown：返回 true 表示按键已被菜单处理 */
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          move(e.key === "ArrowDown" ? 1 : -1);
          return true;
        }
        const choose =
          (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) ||
          (e.key === "Tab" && !e.shiftKey);
        if (choose) {
          e.preventDefault();
          const option = keys[active];
          if (option) pick(option);
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          close(true);
          return true;
        }
      }
      // 空输入框按 /：吃掉按键，插入一个 / 作为过滤前缀，焦点仍留在输入框。
      const atStart =
        e.currentTarget.selectionStart === 0 &&
        e.currentTarget.selectionEnd === 0;
      if (
        e.key === "/" &&
        atStart &&
        text === "" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        show();
        setText("/");
        return true;
      }
      return false;
    },
  };
}
