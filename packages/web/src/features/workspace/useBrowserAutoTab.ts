// agent 一用浏览器工具，就把它在用的页面摆到用户面前：没有浏览器标签就新开窗格、标签在后台就切过去、
// 已经在前台就不动（标签自己在工具条上提示新页面）。常驻在工作区页上，所以没有浏览器标签时也能响应。
import { useEffect } from "react";
import { useBrowser } from "./browser";
import { useLayoutState, useLayoutStore } from "./layoutContext";

export function useBrowserAutoTab(): void {
  const layout = useLayoutStore();
  const workspaceId = useLayoutState((s) => s.workspaceId);
  const { store } = useBrowser(workspaceId);
  useEffect(
    () =>
      store?.onAgentUse((u) => {
        layout.revealBrowser(u.page.id);
      }),
    [store, layout],
  );
}
