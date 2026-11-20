// 下载窗口：agent 一次动作期间（及动作后的宽限）收集这一页上开始的下载；窗口外的下载一律取消。
// 同一会话可以有多个窗口（并行的工具调用），所以每个窗口各记一笔。
// 已知并接受的局限：窗口只在动作期间加一小段宽限，来得更晚的下载（比如服务端生成导出文件要好几秒）
// 会被当成「没有 agent 动作在等」而取消；不做长期挂着的窗口，否则用户操作的页面也会被误收。
// 用户接管的页面（`page.controller === "user"`）上的下载不进窗口，交给 userDownload 挂起等用户决定存到哪。

import type { PageDownload } from "../engine/types.js";
import type { PageView } from "../pages/types.js";

// 一个窗口最多收这么多个下载，多出来的取消（免得一次点击刷出几十个文件）。
const MAX_PER_WINDOW = 3;

export interface DownloadWindows {
  /**
   * 在 agent 的一次动作期间收集下载：fn 跑完后若还一个都没收到，再等 graceMs（下载事件常在点击返回前后才到）。
   * pageId 为 null 表示这次动作要新开页面（页面编号此刻未知），此时匹配这个会话在用的任意页面。
   * fn 抛错：已收到的下载全部取消，再把错误原样抛出。
   */
  collect<T>(
    sessionId: string,
    pageId: string | null,
    fn: () => Promise<T>,
    graceMs: number,
  ): Promise<{ value: T; downloads: PageDownload[]; dropped: number }>;
  /** registry 的 onDownload 回调。 */
  dispatch(page: PageView, d: PageDownload): void;
}

interface Window {
  pageId: string | null;
  root: string;
  downloads: PageDownload[];
  dropped: number;
}

export function createDownloadWindows(deps: {
  rootOf(sessionId: string): string;
  /** 用户页上的下载：挂起等用户决定存到哪（由 service 交给待处理清单）。 */
  userDownload(page: PageView, d: PageDownload): void;
}): DownloadWindows {
  const windows = new Set<Window>();

  /** 找这个页面该进的窗口：页面编号精确匹配优先，其次是不指定页面的窗口。 */
  const windowFor = (page: PageView, root: string): Window | null => {
    let fallback: Window | null = null;
    for (const w of windows) {
      if (w.root !== root) continue;
      if (w.pageId === page.id) return w;
      if (w.pageId === null) fallback ??= w;
    }
    return fallback;
  };

  return {
    async collect(sessionId, pageId, fn, graceMs) {
      const w: Window = {
        pageId,
        root: deps.rootOf(sessionId),
        downloads: [],
        dropped: 0,
      };
      windows.add(w);
      try {
        const value = await fn();
        // 一个都没收到：再等一会儿（下载事件常在点击返回前后才到）；收到了就不等。
        if (w.downloads.length === 0 && graceMs > 0)
          await new Promise<void>((r) => setTimeout(r, graceMs));
        return { value, downloads: w.downloads, dropped: w.dropped };
      } catch (err) {
        for (const d of w.downloads) void d.cancel("动作失败");
        throw err;
      } finally {
        windows.delete(w);
      }
    },

    dispatch(page, d) {
      // 用户接管的页面：交给待处理清单，弹窗问用户存到哪。
      if (page.controller === "user") {
        deps.userDownload(page, d);
        return;
      }
      const root = page.inUseBy;
      const w = root === null ? null : windowFor(page, root);
      if (!w) {
        void d.cancel("没有对应的 agent 动作");
        return;
      }
      if (w.downloads.length >= MAX_PER_WINDOW) {
        w.dropped += 1;
        void d.cancel(`一次动作最多收 ${MAX_PER_WINDOW} 个下载`);
        return;
      }
      w.downloads.push(d);
    },
  };
}
