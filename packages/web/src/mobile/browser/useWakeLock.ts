// 屏幕常亮：只在 enabled（在看浏览器画面）时持有；仅 HTTPS 下浏览器才给，没有就静默什么都不做。
// 页面回到前台时系统已经释放了旧的锁，要重新申请。
import { useEffect } from "react";

export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !window.isSecureContext || !navigator.wakeLock) return;
    let alive = true;
    let lock: WakeLockSentinel | null = null;
    const acquire = () => {
      navigator.wakeLock
        .request("screen")
        .then((l) => {
          if (alive) lock = l;
          else void l.release();
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [enabled]);
}
