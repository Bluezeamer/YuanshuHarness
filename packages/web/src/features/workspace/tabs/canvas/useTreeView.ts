// 树栏浏览状态的 hook：展开的文件夹与列表滚动位置，初始值从浏览器里读，变了就存。
// 状态放在标签里（不放在树组件里）：悬浮的树栏收起时树组件会被卸载，状态不能跟着丢。
import { useCallback, useEffect, useRef, useState } from "react";
import { readTreeView, treeViewKey, writeTreeView } from "./treeView";

export function useTreeView(env: string, dir: string) {
  const key = treeViewKey(env, dir);
  const [initial] = useState(() => readTreeView(key));
  const [open, setOpen] = useState<Set<string>>(() => new Set(initial.open));
  const scroll = useRef(initial.scroll);
  const latest = useRef({ key, open });
  latest.current = { key, open };

  useEffect(() => {
    writeTreeView(key, { open: [...open], scroll: scroll.current });
  }, [key, open]);

  const onScroll = useCallback((top: number) => {
    scroll.current = top;
    const { key: k, open: o } = latest.current;
    writeTreeView(k, { open: [...o], scroll: top });
  }, []);

  return { open, setOpen, initialScroll: initial.scroll, onScroll };
}
