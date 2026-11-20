// 「添加到主屏幕」：Chromium 在可安装时发一次 beforeinstallprompt（只发一次，页面加载早期就会来），入口处先捕获下来，
// 设置页的按钮才有东西可用；别的浏览器没有它，设置页给图文步骤。已经在独立窗口里就什么都不显示。
import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const cb of [...listeners]) cb();
};

/** 入口处（main.tsx）尽早调一次 */
export function captureInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    changed();
  });
  // 装好之后事件作废
  window.addEventListener("appinstalled", () => {
    deferred = null;
    changed();
  });
}

/** 已经是独立应用在跑（Android 的 standalone 显示模式，或 iOS 的 navigator.standalone） */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export const isIos = (ua: string): boolean => /iPhone|iPad|iPod/.test(ua);

export function useInstall() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const cb = () => rerender((n) => n + 1);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return {
    standalone: isStandalone(),
    ios: isIos(navigator.userAgent),
    /** 浏览器给了安装提示，可以直接弹 */
    canPrompt: deferred !== null,
    async prompt(): Promise<boolean> {
      const e = deferred;
      if (!e) return false;
      deferred = null;
      changed();
      await e.prompt();
      return (await e.userChoice).outcome === "accepted";
    },
  };
}
