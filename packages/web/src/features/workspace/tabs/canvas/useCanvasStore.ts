// 画布的 store 按标签存在组件外面：窗格只渲染当前标签，切走再回来组件会卸载，攒着的改动不能跟着丢。
// 一个标签一份：同一个目录开两个画布标签时各看各的画布、各攒各的改动（以前按「主机 + 目录」共用一份，
// 一个标签换了画布另一个跟着换）。没有标签在用、也没有未保存的改动时才丢掉，下次重新载入。
import { useEffect, useMemo } from "react";
import { type CanvasStore, createCanvasStore, isDirty } from "./store";

interface Entry {
  store: CanvasStore;
  users: number;
}

const entries = new Map<string, Entry>();

export function useCanvasStore(
  env: string,
  dir: string,
  tabId: string,
): CanvasStore {
  const key = `${tabId}\0${env}\0${dir}`;
  const store = useMemo(() => {
    let e = entries.get(key);
    if (!e) {
      e = { store: createCanvasStore({ env, dir }), users: 0 };
      entries.set(key, e);
    }
    return e.store;
  }, [key, env, dir]);

  useEffect(() => {
    const e = entries.get(key);
    if (e) e.users += 1;
    return () => {
      if (!e) return;
      e.users -= 1;
      // 严格模式会先卸载再挂一次：等一拍再判断还有没有人用
      setTimeout(() => {
        if (
          e.users === 0 &&
          !isDirty(e.store.getSnapshot()) &&
          entries.get(key) === e
        )
          entries.delete(key);
      }, 0);
    };
  }, [key]);

  return store;
}
