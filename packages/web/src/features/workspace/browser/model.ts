// 工作区浏览器的纯状态逻辑：事件流消息怎么合进状态，以及从一条事件里看出「agent 开始用页面」。
// 不碰 React 与 WebSocket，便于单测（store.ts 负责连接，useBrowser.ts 负责接线）。
import type {
  BrowserEvent,
  ConsoleEntry,
  EngineState,
  Limits,
  PageView,
} from "../../../api/browser";

export interface BrowserState {
  link: "connecting" | "live" | "reconnecting" | "lost";
  /** null = 还没收到第一份快照 */
  engine: EngineState | null;
  /** 保持服务端给的相对顺序 */
  pages: PageView[];
  limits: Limits | null;
  /**
   * 刚从手动操作交还给 agent、界面还没处理的页面（用来问要不要保存登录状态）。
   * 记在这里而不是靠按钮：点「交还」、点接管横幅、在聊天里答复，最后都表现为页面的操作者变回 agent；
   * 也不能只在标签挂着时才看得到，窗格切走标签会卸载组件。
   */
  handedBack: string[];
}

export const INITIAL_BROWSER: BrowserState = {
  link: "connecting",
  engine: null,
  pages: [],
  limits: null,
  handedBack: [],
};

// 服务端偶尔把已有页面再报一次 added，两种事件的合并方式一致。
function applyPage(pages: readonly PageView[], page: PageView): PageView[] {
  const at = pages.findIndex((p) => p.id === page.id);
  if (at < 0) return [...pages, page];
  const next = [...pages];
  next[at] = page;
  return next;
}

export function applyBrowserEvent(
  s: BrowserState,
  e: BrowserEvent,
): BrowserState {
  if (e.type === "snapshot")
    return {
      ...s,
      engine: e.engine,
      pages: e.pages,
      limits: e.limits,
      handedBack: s.handedBack.filter((id) => e.pages.some((p) => p.id === id)),
    };
  if (e.type === "engine") return { ...s, engine: e.state };
  if (e.type === "show") return s;
  if (e.event.type === "removed") {
    const { id } = e.event;
    return {
      ...s,
      pages: s.pages.filter((p) => p.id !== id),
      handedBack: s.handedBack.filter((h) => h !== id),
    };
  }
  const page = e.event.page;
  const before = s.pages.find((p) => p.id === page.id);
  const back =
    before?.controller === "user" &&
    page.controller === "agent" &&
    !s.handedBack.includes(page.id);
  return {
    ...s,
    pages: applyPage(s.pages, page),
    ...(back ? { handedBack: [...s.handedBack, page.id] } : {}),
  };
}

/** 界面处理掉一次「刚交还」：之后不再问。 */
export function settleHandback(s: BrowserState, id: string): BrowserState {
  return s.handedBack.includes(id)
    ? { ...s, handedBack: s.handedBack.filter((h) => h !== id) }
    : s;
}

/** agent 开始用一个页面：fresh = 这个页面刚被新开。 */
export interface AgentUse {
  page: PageView;
  fresh: boolean;
}

/**
 * 一条事件前后对比出「agent 开始使用」：界面据此自动出标签。
 * 只在 agent 从没用变成用的时候报一次，连续动作与用户自己的页面都不报。
 */
export function agentUseOf(
  prev: BrowserState,
  e: BrowserEvent,
): AgentUse | null {
  if (e.type !== "page") return null;
  if (e.event.type === "removed") return null;
  const page = e.event.page;
  if (page.controller !== "agent") return null;
  if (e.event.type === "added")
    return page.userOpened ? null : { page, fresh: true };
  const before = prev.pages.find((p) => p.id === page.id);
  const started = before?.inUseBy === null && page.inUseBy !== null;
  return started ? { page, fresh: false } : null;
}

/** 控制台：同一组消息再出现时按组编号原地更新（×n），新的组接在后面，只留最近 max 组。 */
export function foldConsole(
  list: readonly ConsoleEntry[],
  entry: ConsoleEntry,
  max: number,
): ConsoleEntry[] {
  const at = list.findIndex((e) => e.id === entry.id);
  const next =
    at < 0 ? [...list, entry] : list.map((e, i) => (i === at ? entry : e));
  return next.slice(-max);
}
