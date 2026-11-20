// agent 展示了一个页面（browser_show）：弹一条不自动消失的提示，用户点「查看」才把浏览器标签切过去
// （没有浏览器标签就新开）。不阻塞 agent；同一个会话再展示就替换它上一条没处理的提示。
import { useEffect } from "react";
import { wakePage } from "../../api/browser";
import { loadToken } from "../../api/http";
import { dismissToast, toast } from "../../ui";
import { useBrowser } from "./browser";
import { useLayoutState, useLayoutStore } from "./layoutContext";

export function useBrowserShow(): void {
  const layout = useLayoutStore();
  const workspaceId = useLayoutState((s) => s.workspaceId);
  const { store } = useBrowser(workspaceId);
  useEffect(() => {
    if (!store || workspaceId === null) return;
    const shown = new Map<string, number>(); // 会话 → 它当前还挂着的提示
    const off = store.onShow((req) => {
      const old = shown.get(req.sessionId);
      if (old !== undefined) dismissToast(old);
      const look = async () => {
        const page = store.getSnapshot().pages.find((p) => p.id === req.pageId);
        if (!page) return toast("这个页面已经关闭了", { tone: "warn" });
        // 休眠的页面先唤醒，标签里就能直接看到
        if (page.state === "sleeping")
          await wakePage(loadToken(), workspaceId, req.pageId);
        layout.openBrowserPage(req.pageId);
      };
      const title = req.title === "" ? req.url : req.title;
      const id = toast(
        `会话「${req.by}」展示了页面「${title}」${req.note === "" ? "" : `：${req.note}`}`,
        {
          durationMs: 0,
          actions: [
            { label: "查看", onClick: () => void look() },
            { label: "忽略", onClick: () => {} },
          ],
        },
      );
      shown.set(req.sessionId, id);
    });
    return () => {
      off();
      for (const id of shown.values()) dismissToast(id);
    };
  }, [store, layout, workspaceId]);
}
