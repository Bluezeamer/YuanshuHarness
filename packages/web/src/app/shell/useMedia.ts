import { useSyncExternalStore } from "react";

/** 媒体查询当前是否命中；视口跨过断点时跟着变 */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
  );
}
