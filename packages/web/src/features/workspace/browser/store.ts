// 工作区级浏览器 store：一条事件流连接、一份状态，同一工作区的所有标签与工作区页面共用。
// 重连策略照 useBrowserStream：断开后重连几次，用尽就停在「已断开」，等人手动重试。
import {
  type BrowserEvent,
  openBrowserEvents,
  type ShowRequest,
} from "../../../api/browser";
import { createProbe, onForeground } from "../../../api/foreground";
import { loadToken } from "../../../api/http";
import {
  type AgentUse,
  agentUseOf,
  applyBrowserEvent,
  type BrowserState,
  INITIAL_BROWSER,
  settleHandback,
} from "./model";

export interface BrowserStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): BrowserState;
  /** 订阅「agent 开始用某个页面」；只对连上之后的实时事件触发，首份快照不触发。 */
  onAgentUse(cb: (u: AgentUse) => void): () => void;
  /** 订阅「agent 请用户看一个页面」（browser_show）；一次性的提示，不进状态。 */
  onShow(cb: (s: ShowRequest) => void): () => void;
  /** 页面刚从手动操作交还给 agent、还没人处理时返回 true 并标记已处理（只会有一个调用方拿到 true）。 */
  takeHandback(pageId: string): boolean;
  /** 连接用尽（link === "lost"）后手动重连。 */
  retry(): void;
}

export interface StoreDeps {
  /** 测试注入建连方式；缺省走 openBrowserEvents(wid, loadToken()) */
  open?: (wid: string) => WebSocket;
  retryMs?: number;
  maxRetries?: number;
}

const DEFAULT_RETRY_MS = 3000;
const DEFAULT_MAX_RETRIES = 5;

const isEvent = (m: unknown): m is BrowserEvent => {
  const type = (m as { type?: unknown } | null)?.type;
  return (
    type === "snapshot" ||
    type === "page" ||
    type === "engine" ||
    type === "show"
  );
};

interface StoreHandle {
  store: BrowserStore;
  dispose(): void;
}

function createBrowserStore(
  workspaceId: string,
  deps: StoreDeps = {},
): StoreHandle {
  const open =
    deps.open ?? ((wid: string) => openBrowserEvents(wid, loadToken()));
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;

  let state: BrowserState = INITIAL_BROWSER;
  let disposed = false;
  let sock: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const subs = new Set<() => void>();
  const uses = new Set<(u: AgentUse) => void>();
  const shows = new Set<(s: ShowRequest) => void>();

  const set = (next: BrowserState) => {
    if (disposed) return;
    state = next;
    for (const fn of [...subs]) fn();
  };

  // 回前台：连着的探一下还活不活（死了就重连），在退避里等着或已放弃的立即重连；首次连接还在路上的不打断。
  const probe = createProbe(
    () => {
      if (sock?.readyState !== 1) return false;
      sock.send(JSON.stringify({ type: "ping" }));
      return true;
    },
    () => restart(),
  );
  const offForeground = onForeground(() => {
    if (disposed) return;
    if (state.link === "live") probe.start();
    else if (state.link !== "connecting") restart();
  });

  const connect = () => {
    timer = undefined;
    if (disposed) return;
    const ws = open(workspaceId);
    sock = ws;
    ws.onopen = () => {
      if (disposed || sock !== ws) return;
      failures = 0;
      set({ ...state, link: "live" });
    };
    ws.onmessage = (e) => {
      if (disposed || sock !== ws) return;
      probe.settle();
      if (typeof e.data !== "string") return;
      let msg: BrowserEvent;
      try {
        msg = JSON.parse(e.data) as BrowserEvent;
      } catch {
        return;
      }
      if (!isEvent(msg)) return;
      if (msg.type === "show") {
        for (const fn of [...shows]) fn(msg.show);
        return;
      }
      const use = agentUseOf(state, msg);
      set(applyBrowserEvent(state, msg));
      if (use) for (const fn of [...uses]) fn(use);
    };
    ws.onclose = () => {
      if (disposed || sock !== ws) return;
      sock = null;
      probe.cancel();
      failures += 1;
      if (failures > maxRetries) return set({ ...state, link: "lost" });
      set({ ...state, link: "reconnecting" });
      timer = setTimeout(connect, retryMs);
    };
    ws.onerror = () => ws.close();
  };

  const restart = () => {
    if (disposed) return;
    clearTimeout(timer);
    probe.cancel();
    failures = 0;
    const ws = sock;
    sock = null;
    ws?.close();
    set({ ...state, link: "connecting" });
    connect();
  };

  connect();

  return {
    store: {
      subscribe(cb) {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
      getSnapshot: () => state,
      onAgentUse(cb) {
        uses.add(cb);
        return () => {
          uses.delete(cb);
        };
      },
      onShow(cb) {
        shows.add(cb);
        return () => {
          shows.delete(cb);
        };
      },
      takeHandback(pageId) {
        if (!state.handedBack.includes(pageId)) return false;
        set(settleHandback(state, pageId));
        return true;
      },
      retry: restart,
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      offForeground();
      probe.cancel();
      const ws = sock;
      sock = null;
      ws?.close();
      subs.clear();
      uses.clear();
    },
  };
}

// 每个工作区一份，引用计数到 0 才关连接。
const shared = new Map<string, { handle: StoreHandle; refs: number }>();

/** 取得（没有就创建并连接）工作区的 store；release 把引用减一，减到 0 才关连接并丢掉 store。 */
export function acquireBrowserStore(
  workspaceId: string,
  deps?: StoreDeps,
): { store: BrowserStore; release: () => void } {
  let entry = shared.get(workspaceId);
  if (!entry) {
    entry = { handle: createBrowserStore(workspaceId, deps), refs: 0 };
    shared.set(workspaceId, entry);
  }
  const held = entry;
  held.refs += 1;
  return {
    store: held.handle.store,
    release() {
      held.refs -= 1;
      if (held.refs > 0) return;
      held.handle.dispose();
      if (shared.get(workspaceId) === held) shared.delete(workspaceId);
    },
  };
}
