// 浏览器标签的纯逻辑：地址的展示写法、「页面」列表的分组与排序、状态、当前页的选取。不依赖 React。
import type {
  ConsoleEntry,
  ForwardView,
  PageView,
  PortView,
} from "../../../../api/browser";

// 服务端的虚拟主机名：`<主机>.localhost:<端口>` 是服务，`<主机>.files.localhost` 是文件（browser/net/hostnames.ts）。
const SUFFIX = ".localhost";
const FILES = "files";

export interface Address {
  /** 给人看的写法：服务 `主机名:端口/路径`，文件 `主机名:/绝对路径`，公网去掉协议头 */
  text: string;
  kind: "service" | "file" | "public" | "blank";
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 页面地址的展示写法；hostName 把主机标签（环境 id，本机是 server）换成界面上的主机名。 */
export function addressOf(
  url: string,
  hostName: (id: string) => string,
): Address {
  if (url === "" || url === "about:blank") return { text: "", kind: "blank" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { text: url, kind: "public" };
  }
  const host = u.hostname.toLowerCase();
  if (host.endsWith(SUFFIX)) {
    const parts = host.slice(0, -SUFFIX.length).split(".");
    const label = parts[0] ?? "";
    if (parts.length === 1 && label !== "") {
      const tail = `${u.pathname === "/" ? "" : u.pathname}${u.search}`;
      const port = u.port === "" ? "80" : u.port;
      return { text: `${hostName(label)}:${port}${tail}`, kind: "service" };
    }
    if (parts.length === 2 && parts[1] === FILES && label !== "")
      return {
        text: `${hostName(label)}:${decode(u.pathname)}`,
        kind: "file",
      };
  }
  const tail = `${u.pathname === "/" ? "" : u.pathname}${u.search}`;
  return { text: `${u.host}${tail}`, kind: "public" };
}

/** 端口行的展示写法：与地址栏同一套主机名（target 的主机部分是地址里的主机标签，本机是 server）。 */
export const portLabel = (
  port: Pick<PortView, "target" | "port">,
  hostName: (id: string) => string,
): string =>
  `${hostName(port.target.slice(0, port.target.lastIndexOf(":")))}:${port.port}`;

/** 端口列表里的一行：检测到在监听的、已转发的，同一个端口并成一行。 */
export interface PortRow {
  /** `环境 id:端口` */
  key: string;
  envId: string;
  port: number;
  /** 地址栏写法（server:3000），行上的名字与「在内置浏览器打开」都用它 */
  target: string;
  /** 已转发时的转发视图 */
  forward: ForwardView | null;
  /** 此刻被检测到在监听 */
  detected: boolean;
}

/** 检测到的与已转发的并成一份清单，按环境、端口排序；手动转发的端口不要求被检测到。 */
export function portRows(
  ports: readonly PortView[],
  forwards: readonly ForwardView[],
): PortRow[] {
  const rows = new Map<string, PortRow>();
  for (const p of ports)
    rows.set(`${p.envId}:${p.port}`, {
      key: `${p.envId}:${p.port}`,
      envId: p.envId,
      port: p.port,
      target: p.target,
      forward: null,
      detected: true,
    });
  for (const f of forwards) {
    const key = `${f.envId}:${f.port}`;
    const row = rows.get(key);
    if (row) row.forward = f;
    else
      rows.set(key, {
        key,
        envId: f.envId,
        port: f.port,
        target: f.target,
        forward: f,
        detected: false,
      });
  }
  return [...rows.values()].sort((a, b) =>
    a.envId === b.envId ? a.port - b.port : a.envId < b.envId ? -1 : 1,
  );
}

/**
 * 转发出来的服务在用户浏览器里的地址：访问 Server 用的主机名 + 转发端口，协议沿用当前页面的。
 * 转发端口是明文 HTTP；控制台走 https 时不提供（会话 Cookie 不分端口，会跟着明文发出去），所以这里恒为 http。
 */
export const forwardUrl = (
  forward: Pick<ForwardView, "localPort">,
  where: Pick<Location, "protocol" | "hostname">,
): string => `${where.protocol}//${where.hostname}:${forward.localPort}/`;

export const forwardBlocked = (protocol: string): string | null =>
  protocol === "https:"
    ? "控制台是 https 访问的：转发端口是明文 http，登录 Cookie 会跟着明文发出去。请改用内网地址（http）访问控制台后再转发。"
    : null;

/** 页面在列表与标题里的名字：标题，没有标题用地址。 */
export const pageName = (
  page: Pick<PageView, "title" | "url">,
  hostName: (id: string) => string,
): string =>
  page.title.trim() !== ""
    ? page.title
    : addressOf(page.url, hostName).text || "空白页";

export type PageStatus = "agent" | "user" | "sleeping";

/** 状态点：休眠优先，其次你在手动操作，否则是 agent 的页面。 */
export const statusOf = (
  page: Pick<PageView, "state" | "controller">,
): PageStatus =>
  page.state === "sleeping"
    ? "sleeping"
    : page.controller === "user"
      ? "user"
      : "agent";

export interface PageGroup {
  /** "mine" 或会话 id */
  key: string;
  /** 会话分组的会话 id；「我的」为 null */
  sessionId: string | null;
  pages: PageView[];
}

/** 最后使用过这个页面的根会话：此刻在用的，否则用过的最后一个。 */
const lastSession = (p: PageView): string | null =>
  p.inUseBy ?? p.usedBy.at(-1) ?? null;

const byRecent = (a: PageView, b: PageView): number =>
  Number(a.state === "sleeping") - Number(b.state === "sleeping") ||
  b.lastUsedAt.localeCompare(a.lastUsedAt);

/**
 * 「页面」列表的分组：你自己开的页面永远在「我的」；其余按最后使用过它的会话分组
 * （没有会话的也放进「我的」）。「我的」在最前，其后按组内最近使用的时间倒序；
 * 组内休眠的排在后面，其余按最近使用。
 */
export function groupPages(pages: readonly PageView[]): PageGroup[] {
  const mine: PageView[] = [];
  const bySession = new Map<string, PageView[]>();
  for (const p of pages) {
    const sid = p.userOpened ? null : lastSession(p);
    if (sid === null) {
      mine.push(p);
      continue;
    }
    const list = bySession.get(sid);
    if (list) list.push(p);
    else bySession.set(sid, [p]);
  }
  const latest = (list: PageView[]) =>
    list.reduce((m, p) => (p.lastUsedAt > m ? p.lastUsedAt : m), "");
  const sessions = [...bySession.entries()]
    .map(([sessionId, list]) => ({
      key: sessionId,
      sessionId,
      pages: list.sort(byRecent),
    }))
    .sort((a, b) => latest(b.pages).localeCompare(latest(a.pages)));
  return [
    { key: "mine", sessionId: null, pages: mine.sort(byRecent) },
    ...sessions,
  ];
}

/** 标签此刻显示哪一页：标签记着的那页；它没了（被关）就用最近用过的激活页，再没有用最近用过的休眠页。 */
export function currentPage(
  pages: readonly PageView[],
  wanted: string | undefined,
): PageView | null {
  const hit = pages.find((p) => p.id === wanted);
  if (hit) return hit;
  return [...pages].sort(byRecent)[0] ?? null;
}

/** 你自己的页面被 agent 用过：列出用过它的会话名（会话归档后服务端会清掉这个记录）。 */
export const usedByNames = (
  page: Pick<PageView, "userOpened" | "usedBy">,
  title: (sid: string) => string,
): string[] => (page.userOpened ? page.usedBy.map(title) : []);

/** 地址栏里的锁：https 才算加密。 */
export const isSecure = (url: string): boolean => url.startsWith("https:");

/** 控制台：接口取回的历史在前，连接后推来的实时条目接在后面；同一组（组编号相同）以后到的为准（次数更新），位置仍是首次出现处。 */
export function mergeConsole(
  history: readonly ConsoleEntry[],
  live: readonly ConsoleEntry[],
): ConsoleEntry[] {
  const byId = new Map<number, ConsoleEntry>();
  for (const e of [...history, ...live]) byId.set(e.id, e);
  return [...byId.values()];
}

const CLIP_PREVIEW = 60;

/** 提示里显示的复制内容预览：空白折成一格，超长截断。 */
export function clipPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CLIP_PREVIEW ? `${flat.slice(0, CLIP_PREVIEW)}…` : flat;
}
