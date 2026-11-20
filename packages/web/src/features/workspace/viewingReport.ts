import { useEffect, useState } from "react";
import { useLayoutState, useLayoutStore } from "./layoutContext";
import { useLibraryStore } from "./library/LibraryProvider";

const isVisible = () => document.visibilityState !== "hidden";

/**
 * 把「我在看」的会话上报给服务端（它据此清掉未读标记）：当前窗口里各窗格正在显示的对话标签；
 * 页面不在前台就不算在看。
 */
export function useViewingReport(): void {
  const library = useLibraryStore();
  const layout = useLayoutStore();
  const doc = useLayoutState((s) => s.doc);
  const status = useLayoutState((s) => s.status);
  const [visible, setVisible] = useState(isVisible);

  useEffect(() => {
    const on = () => setVisible(isVisible());
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: doc 与 status 变了 viewing() 才会变
  useEffect(() => {
    library.setViewing(visible ? layout.viewing() : []);
  }, [library, layout, doc, status, visible]);
}
