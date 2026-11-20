// 手机入口的 service worker：只在安全上下文（HTTPS 或 localhost）里注册，明文下浏览器根本不给；
// 开发服务器下不注册（会拦住热更新）。点通知时 sw 往已开着的窗口发 open-session，由这里转成导航。
import type { Nav } from "../nav/nav";

export function registerMobileServiceWorker(nav: Nav): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    const m = e.data as { type?: unknown; sid?: unknown } | null;
    if (m?.type !== "open-session") return;
    const route = nav.route();
    if (typeof m.sid !== "string" || m.sid === "")
      return nav.replace({ name: "list" });
    if (route.name === "chat" && route.sid === m.sid) return;
    nav.push({ name: "chat", sid: m.sid });
  });
  if (!import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
