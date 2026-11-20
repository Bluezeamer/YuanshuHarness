// 手机端的导航栈：history 就是栈，每一页、每个弹层各占一条历史；
// 页面里的「返回」按钮与系统返回键走同一个 back()，URL 与 history.state 是唯一真相。

import { formatRoute, parseRoute, type Route } from "./route";

export interface Nav {
  route(): Route;
  subscribe(cb: () => void): () => void;
  /** 往栈上压一页；必须由用户的点击触发（浏览器会跳过没有用户激活产生的历史条目） */
  push(route: Route): void;
  replace(route: Route): void;
  /** 返回一层；栈底（直接打开的深链接）回列表 */
  back(): void;
}

// history.state：这一条在栈里的深度，0 是栈底。
interface Entry {
  d: number;
}

const LIST: Route = { name: "list" };

export function createNav(): Nav {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of [...listeners]) cb();
  };
  const key = () => location.pathname + location.search;
  const depth = () => (history.state as Entry | null)?.d ?? 0;

  // route() 要在 URL 没变时返回同一个对象，useSyncExternalStore 才不会反复重渲染
  let cached: { key: string; route: Route } | null = null;
  const route = (): Route => {
    const k = key();
    if (cached?.key !== k) cached = { key: k, route: parseRoute(k) };
    return cached.route;
  };

  // 首次进入（没有 state）：直接打开深链接时，先把栈底换成列表再压上目标，返回键不会直接退出。
  if (history.state === null) {
    const target = route();
    if (target.name === "list" && !target.layer) {
      history.replaceState({ d: 0 } satisfies Entry, "", key());
    } else {
      const url = key();
      history.replaceState({ d: 0 } satisfies Entry, "", formatRoute(LIST));
      history.pushState({ d: 1 } satisfies Entry, "", url);
    }
  }

  window.addEventListener("popstate", notify);

  const nav: Nav = {
    route,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    push(next) {
      const url = formatRoute(next);
      if (url === key()) return;
      history.pushState({ d: depth() + 1 } satisfies Entry, "", url);
      notify();
    },
    replace(next) {
      history.replaceState(
        { d: depth() } satisfies Entry,
        "",
        formatRoute(next),
      );
      notify();
    },
    back() {
      if (depth() > 0) history.back();
      else {
        const r = route();
        if (r.name !== "list" || r.layer) nav.replace(LIST);
      }
    },
  };
  return nav;
}
