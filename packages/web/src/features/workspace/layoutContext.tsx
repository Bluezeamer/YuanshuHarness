// 布局运行时：当前工作区那一份布局文档的 store + 主机展示名。
// Provider 管生命周期（载入、同步工作区目录与会话列表、pagehide 立即保存）；左轨之外的一切布局界面共用这一份。

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { ApiError, type Failure } from "../../api/http";
import { getWorkspaceLayout, putWorkspaceLayout } from "../../api/workspaces";
import { type Directory, hostToneOf } from "./model/l2";
import {
  createLayoutStore,
  type LayoutApi,
  type LayoutState,
  type LayoutStore,
  type SessionBrief,
} from "./store/layoutStore";
import { watchLiveTabs } from "./tabs/tabView";

export interface HostInfo {
  id: string;
  name: string;
}

/** 接口错误 → 统一失败类型；不是 ApiError 的只会是响应体解析失败，算服务端问题 */
function failureOf(e: unknown): Failure {
  const status = e instanceof ApiError ? e.status : 500;
  if (status === 0) return { kind: "network" };
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 429) return { kind: "rate_limited", retryAfter: null };
  return { kind: "server" };
}

export function createLayoutApi(token: string | null): LayoutApi {
  return {
    async get(workspaceId) {
      try {
        return { ok: true, data: await getWorkspaceLayout(token, workspaceId) };
      } catch (e) {
        return { ok: false, ...failureOf(e) };
      }
    },
    put: (workspaceId, baseRevision, document, keepalive) =>
      putWorkspaceLayout(token, workspaceId, baseRevision, document, keepalive),
  };
}

interface Env {
  store: LayoutStore;
  /** 会话 id → 展示标题（对话标签的标题用它） */
  titles: ReadonlyMap<string, string>;
  /** 值得看一眼的会话状态：只含正在执行与待处理的，待命的不在表里 */
  runStates: ReadonlyMap<string, RunState>;
  directories: readonly Directory[];
  directoryChoices: readonly DirectoryChoice[];
  hosts: readonly HostInfo[];
  hostName(id: string): string;
}

export type RunState = "running" | "blocked";

/** 工作区里的一个目录，给「放进哪个目录」这类选择用（布局自己只认主机 + 路径）。 */
export interface DirectoryChoice {
  id: string;
  name: string;
}

const LayoutCtx = createContext<Env | null>(null);

export interface LayoutProviderProps {
  /** 访问令牌；与 store 二选一 */
  token?: string | null;
  /** 注入现成 store（测试用） */
  store?: LayoutStore;
  /** 当前工作区；null = 没有 */
  workspaceId: string | null;
  /** 工作区的目录清单（第 0 个是主目录）；null = 还没拿到。调用方要传稳定引用（内容变了才换），否则每次渲染都会重新同步 */
  directories: readonly Directory[] | null;
  /** 当前工作区的会话（顶层）；null = 列表还没到，此时不收敛。同样要传稳定引用 */
  sessions: readonly SessionBrief[] | null;
  hosts: readonly HostInfo[];
  /** 工作区的目录（id 与名称），与 directories 同序；缺省为空。调用方要传稳定引用 */
  directoryChoices?: readonly DirectoryChoice[];
  /** 会话 id → 展示标题；缺省为空 */
  titles?: ReadonlyMap<string, string>;
  /** 会话 id → 运行状态（只含执行中与待处理）；缺省为空 */
  runStates?: ReadonlyMap<string, RunState>;
  children: ReactNode;
}

const NO_DIRECTORIES: readonly Directory[] = [];
const NO_CHOICES: readonly DirectoryChoice[] = [];
const NO_TITLES: ReadonlyMap<string, string> = new Map();
const NO_STATES: ReadonlyMap<string, RunState> = new Map();

export function LayoutProvider({
  token = null,
  store: injected,
  workspaceId,
  directories,
  sessions,
  hosts,
  directoryChoices = NO_CHOICES,
  titles = NO_TITLES,
  runStates = NO_STATES,
  children,
}: LayoutProviderProps) {
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const hostName = useMemo(
    () => (id: string) => hostsRef.current.find((h) => h.id === id)?.name ?? id,
    [],
  );
  const store = useMemo(
    () =>
      injected ?? createLayoutStore({ api: createLayoutApi(token), hostName }),
    [injected, token, hostName],
  );

  useEffect(() => {
    const flush = () => void store.flush(true);
    const onHide = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      store.dispose();
    };
  }, [store]);

  // 关掉的标签（任何途径）要把它的视图状态记录一并清掉：标签 id 会被新标签复用
  useEffect(() => watchLiveTabs(store), [store]);
  useEffect(() => void store.setWorkspace(workspaceId), [store, workspaceId]);
  useEffect(
    () => store.setDirectories(workspaceId, directories),
    [store, workspaceId, directories],
  );
  useEffect(
    () => store.setSessions(workspaceId, sessions),
    [store, workspaceId, sessions],
  );

  const env = useMemo<Env>(
    () => ({
      store,
      titles,
      runStates,
      directories: directories ?? NO_DIRECTORIES,
      directoryChoices,
      hosts,
      hostName,
    }),
    [store, titles, runStates, directories, directoryChoices, hosts, hostName],
  );
  return <LayoutCtx.Provider value={env}>{children}</LayoutCtx.Provider>;
}

function useEnv(): Env {
  const env = useContext(LayoutCtx);
  if (!env) throw new Error("需要 <LayoutProvider>");
  return env;
}

export const useLayoutStore = (): LayoutStore => useEnv().store;
/**
 * 没有 Provider 时返回 null：对话标签在独立测试 / 预览里可能不在布局内，
 * 分叉入口据此隐藏而不是让整条对话流崩掉。
 */
export const useLayoutStoreOptional = (): LayoutStore | null =>
  useContext(LayoutCtx)?.store ?? null;
/** 当前工作区的目录清单（第 0 个是主目录）；还没拿到时是空数组 */
export const useLayoutDirectories = (): readonly Directory[] =>
  useEnv().directories;
/** 当前工作区的目录（id 与名称）；与 useLayoutDirectories 同序 */
export const useDirectoryChoices = (): readonly DirectoryChoice[] =>
  useEnv().directoryChoices;
/** 会话 id → 展示标题（对话标签的标题用它）；没有 Provider 时是空表 */
export const useSessionTitles = (): ReadonlyMap<string, string> =>
  useContext(LayoutCtx)?.titles ?? NO_TITLES;
/** 会话 id → 运行状态（只含执行中与待处理）；没有 Provider 时是空表 */
export const useRunStates = (): ReadonlyMap<string, RunState> =>
  useContext(LayoutCtx)?.runStates ?? NO_STATES;
export const useHostName = (): ((id: string) => string) => useEnv().hostName;
/** 当前可用的主机（Server 本机与已激活的连接） */
export const useHosts = (): readonly HostInfo[] => useEnv().hosts;

/** 订阅 store 的一个切片；selector 必须返回稳定引用（原始值或文档里的子对象） */
export function useLayoutState<T>(selector: (s: LayoutState) => T): T {
  const { store } = useEnv();
  return useSyncExternalStore(store.subscribe, () =>
    selector(store.getState()),
  );
}

const noSub = () => () => {};

/**
 * 主机在当前窗口里的颜色序号（1..6，与窗格头的主机色同一套）；没有 Provider 或不指定主机时是 undefined。
 * 对话标签的页脚用它给「agent 在哪台主机」上色。
 */
export function useHostTone(host: string | null): number | undefined {
  const store = useContext(LayoutCtx)?.store ?? null;
  const tone = useSyncExternalStore(store ? store.subscribe : noSub, () => {
    if (!store || !host) return 0;
    const { windows } = store.getState().doc;
    const win = windows.list[windows.active];
    return win ? hostToneOf(win, host) : 0;
  });
  return tone || undefined;
}

/** 工作区级标签借用的会话（文件监听等需要一条会话流）；文档变化时重新取 */
export function useAnchorSession(): string | null {
  const { store } = useEnv();
  useLayoutState((s) => s.doc);
  return store.anchorSession();
}
