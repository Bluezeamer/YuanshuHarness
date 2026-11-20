// 手机端的路由：URL 是唯一真相（`/m/` 下），每一页、每个弹层各占一条历史。
// 列表 /m/ → 对话 /m/s/<会话>（?audit=1 是同一个会话的审计视图）→ 标签页 /m/t/<类型>?…；
// 弹层是同一页加 `?layer=<名>`，列表上的弹层再带一个 `target`（工具抽屉是工作区 id，行操作是会话 id）。

import type { Tab, TabType } from "../../features/workspace/model/types";

/** 弹层：占一条历史，关闭就是返回一层。pages = 浏览器页面清单，row = 列表行的操作 */
export type Layer = "new" | "status" | "tools" | "pages" | "row";

export type Route =
  | { name: "list"; layer?: Layer; target?: string }
  | { name: "chat"; sid: string; layer?: Layer; audit?: true }
  | { name: "tab"; tab: Tab; layer?: Layer }
  | { name: "settings" };

const BASE = "/m";
const LAYERS: readonly Layer[] = ["new", "status", "tools", "pages", "row"];
const TAB_TYPES: readonly TabType[] = [
  "chat",
  "sub",
  "job",
  "term",
  "files",
  "web",
  "preview",
  "canvas",
];

const layerOf = (params: URLSearchParams): { layer?: Layer } => {
  const v = params.get("layer");
  return LAYERS.includes(v as Layer) ? { layer: v as Layer } : {};
};

// 标签里能带在 URL 上的字段：手机上点开的标签页不存布局，只靠这几个字段还原。
const TAB_FIELDS = [
  "sid",
  "sub",
  "job",
  "host",
  "cwd",
  "path",
  "canvas",
  "page",
  "termId",
] as const;

function tabQuery(tab: Tab): URLSearchParams {
  const q = new URLSearchParams();
  for (const k of TAB_FIELDS) {
    const v = tab[k];
    if (v !== undefined) q.set(k, v);
  }
  if (tab.diff) {
    q.set("diff", tab.diff.path);
    if (tab.diff.turn !== null) q.set("turn", String(tab.diff.turn));
    if (tab.diff.team) q.set("team", "1");
  }
  return q;
}

function tabOf(type: TabType, q: URLSearchParams): Tab {
  const tab: Tab = { id: `m-${type}`, type };
  for (const k of TAB_FIELDS) {
    const v = q.get(k);
    if (v !== null) tab[k] = v;
  }
  const diff = q.get("diff");
  if (diff !== null) {
    const turn = q.get("turn");
    tab.diff = {
      turn: turn === null ? null : Number(turn),
      path: diff,
      ...(q.get("team") === "1" ? { team: true as const } : {}),
    };
  }
  if (type === "chat") tab.ctab = "chat";
  return tab;
}

const withQuery = (path: string, q: URLSearchParams): string => {
  const s = q.toString();
  return s ? `${path}?${s}` : path;
};

export function formatRoute(route: Route): string {
  const q = new URLSearchParams();
  if (route.name !== "settings" && route.layer) q.set("layer", route.layer);
  switch (route.name) {
    case "list":
      if (route.target) q.set("target", route.target);
      return withQuery(`${BASE}/`, q);
    case "chat":
      if (route.audit) q.set("audit", "1");
      return withQuery(`${BASE}/s/${encodeURIComponent(route.sid)}`, q);
    case "tab": {
      const params = tabQuery(route.tab);
      for (const [k, v] of q) params.set(k, v);
      return withQuery(`${BASE}/t/${route.tab.type}`, params);
    }
    case "settings":
      return `${BASE}/settings`;
  }
}

/** 解析 `location.pathname + location.search`；不认识的回列表 */
export function parseRoute(path: string): Route {
  const at = path.indexOf("?");
  const pathname = at < 0 ? path : path.slice(0, at);
  const params = new URLSearchParams(at < 0 ? "" : path.slice(at + 1));
  const p = pathname.replace(/\/+$/, "");
  const chat = new RegExp(`^${BASE}/s/([^/]+)$`).exec(p);
  if (chat)
    return {
      name: "chat",
      sid: decodeURIComponent(chat[1] as string),
      ...(params.get("audit") === "1" ? { audit: true as const } : {}),
      ...layerOf(params),
    };
  const tab = new RegExp(`^${BASE}/t/([a-z]+)$`).exec(p);
  if (tab && TAB_TYPES.includes(tab[1] as TabType))
    return {
      name: "tab",
      tab: tabOf(tab[1] as TabType, params),
      ...layerOf(params),
    };
  if (p === `${BASE}/settings`) return { name: "settings" };
  const target = params.get("target");
  return {
    name: "list",
    ...layerOf(params),
    ...(target ? { target } : {}),
  };
}
