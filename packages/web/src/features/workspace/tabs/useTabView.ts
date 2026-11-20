// 标签组件取自己上次的视图状态：挂载时读一次（窗格切走会卸载、切回是新实例），之后每次变化存一次。
import { useCallback, useState } from "react";
import { useLayoutStore } from "../layoutContext";
import { readTabView, writeTabView } from "./tabView";

export function useTabView<T>(tabId: string, parse: (v: unknown) => T | null) {
  const workspaceId = useLayoutStore().getState().workspaceId;
  const [initial] = useState(() =>
    workspaceId === null ? null : readTabView(workspaceId, tabId, parse),
  );
  const save = useCallback(
    (v: T) => {
      if (workspaceId !== null) writeTabView(workspaceId, tabId, v);
    },
    [workspaceId, tabId],
  );
  return { initial, save };
}
