import { type MouseEvent, type ReactNode, useSyncExternalStore } from "react";

export type Route =
  | { name: "workspace" }
  | { name: "capabilities" }
  | { name: "settings"; page?: string }
  | { name: "preview" }
  | { name: "session"; id: string }
  | { name: "notfound" };

export function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "workspace" };
  if (p === "/capabilities") return { name: "capabilities" };
  // /settings/<page>：新设置壳的子页；旧壳只认 name，对 page 无感。
  const s = /^\/settings(?:\/([^/]+))?$/.exec(p);
  if (s)
    return s[1]
      ? { name: "settings", page: decodeURIComponent(s[1]) }
      : { name: "settings" };
  if (p === "/preview") return { name: "preview" };
  const m = /^\/sessions\/([^/]+)$/.exec(p);
  if (m) return { name: "session", id: decodeURIComponent(m[1] as string) };
  return { name: "notfound" };
}

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  window.addEventListener("popstate", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("popstate", cb);
  };
};

export function navigate(path: string) {
  if (path === location.pathname) return;
  history.pushState(null, "", path);
  for (const f of listeners) f();
}

export const useRoute = (): Route =>
  parseRoute(useSyncExternalStore(subscribe, () => location.pathname));

// 普通点击走前端路由；带修饰键、非左键时留给浏览器（新标签页打开等）。
export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a {...rest} href={to} onClick={onClick}>
      {children}
    </a>
  );
}
