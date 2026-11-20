// 工作区浏览器状态的 React 接线：在生命周期里 acquire / release store，并把状态交给组件。
// 工作区页面常驻持有一份（用来自动出标签），每个标签再各取一份，acquire 保证它们共用同一条连接。
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { type BrowserState, INITIAL_BROWSER } from "./model";
import { acquireBrowserStore, type BrowserStore } from "./store";

interface Held {
  wid: string;
  store: BrowserStore;
}

export function useBrowser(workspaceId: string | null): {
  state: BrowserState;
  store: BrowserStore | null;
} {
  const [held, setHeld] = useState<Held | null>(null);

  useEffect(() => {
    if (workspaceId === null) {
      setHeld(null);
      return;
    }
    const { store, release } = acquireBrowserStore(workspaceId);
    setHeld({ wid: workspaceId, store });
    return () => {
      release();
      setHeld(null);
    };
  }, [workspaceId]);

  // 工作区刚换、effect 还没跑完的那一帧不能拿上一个工作区的 store。
  const store = held && held.wid === workspaceId ? held.store : null;
  const subscribe = useCallback(
    (cb: () => void) => store?.subscribe(cb) ?? (() => {}),
    [store],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => store?.getSnapshot() ?? INITIAL_BROWSER,
  );

  return { state, store };
}
