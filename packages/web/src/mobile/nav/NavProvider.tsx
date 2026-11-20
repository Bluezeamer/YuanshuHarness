import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import type { Nav } from "./nav";
import type { Route } from "./route";

const NavCtx = createContext<Nav | null>(null);

export function NavProvider({
  nav,
  children,
}: {
  nav: Nav;
  children: ReactNode;
}) {
  return <NavCtx.Provider value={nav}>{children}</NavCtx.Provider>;
}

export function useNav(): Nav {
  const nav = useContext(NavCtx);
  if (!nav) throw new Error("需要 <NavProvider>");
  return nav;
}

export function useRoute(): Route {
  const nav = useNav();
  return useSyncExternalStore(nav.subscribe, nav.route);
}
