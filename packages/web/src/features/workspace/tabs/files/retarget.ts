// 移动/重命名之后，已打开的预览标签跟着新路径走，不留在一条已不存在的路径上。
import { panesOf } from "../../model/l2";
import type { LayoutStore } from "../../store/layoutStore";
import { isUnder } from "./paths";

/**
 * 把当前窗口里同主机、路径等于 from 或在 from 之下的预览标签改写到 to。
 * 受 store.patchTab 限制只改当前窗口（其它窗口里的预览不会跟随）。
 */
export function retargetPreviews(
  store: LayoutStore,
  host: string,
  from: string,
  to: string,
): number {
  const st = store.getState().doc.windows;
  const win = st.list[st.active];
  if (!win) return 0;
  let n = 0;
  for (const pane of panesOf(win)) {
    for (const t of pane.tabs) {
      if (t.type !== "preview" || t.host !== host || !t.path) continue;
      if (t.path !== from && !isUnder(t.path, from)) continue;
      const next = t.path === from ? to : to + t.path.slice(from.length);
      if (store.patchTab(t.id, { path: next })) n++;
    }
  }
  return n;
}
