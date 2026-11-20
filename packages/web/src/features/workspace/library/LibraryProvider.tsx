// 库数据层的 React 接线：建 store、管生命周期、把状态切片暴露给界面。
// 当前工作区也在这里算：整棵界面只此一份，多个组件看到同一个值。

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { LibrarySession } from "../../../api/sessionLibrary";
import { loadCurrent, resolveCurrent, saveCurrent } from "./currentWorkspace";
import {
  createLibraryApi,
  createLibraryStore,
  type LibraryState,
  type LibraryStore,
} from "./libraryStore";

export interface CurrentWorkspace {
  id: string | null;
  select(id: string | null): void;
}

interface Env {
  store: LibraryStore;
  current: string | null;
  select(id: string | null): void;
}

const LibraryCtx = createContext<Env | null>(null);

/** 订阅 store 的一个切片；pick 必须返回稳定引用，否则每次通知都重渲染 */
function useSlice<T>(store: LibraryStore, pick: (s: LibraryState) => T): T {
  return useSyncExternalStore(store.subscribe, () => pick(store.getState()));
}

export interface LibraryProviderProps {
  /** 访问令牌；与 store 二选一 */
  token?: string | null;
  /** 注入现成 store（测试用） */
  store?: LibraryStore;
  children: ReactNode;
}

export function LibraryProvider({
  token = null,
  store: injected,
  children,
}: LibraryProviderProps) {
  const store = useMemo(
    () => injected ?? createLibraryStore({ api: createLibraryApi(token) }),
    [injected, token],
  );

  useEffect(() => store.start(), [store]);

  const workspaces = useSlice(store, (s) => s.workspaces);
  const isReady = useSlice(store, (s) => s.ready);
  const [picked, setPicked] = useState<string | null>(loadCurrent);
  // ready 之前不校正：列表还没到，校正会把保存的值冲掉
  const current = isReady ? resolveCurrent(picked, workspaces) : picked;
  // 校正过（工作区被删、列表首次到达）与手动选的，都记下来当以后新页签的初始值
  useEffect(() => saveCurrent(current), [current]);

  const select = useCallback((next: string | null) => setPicked(next), []);

  const env = useMemo<Env>(
    () => ({ store, current, select }),
    [store, current, select],
  );
  return <LibraryCtx.Provider value={env}>{children}</LibraryCtx.Provider>;
}

function useEnv(): Env {
  const env = useContext(LibraryCtx);
  if (!env) throw new Error("需要 <LibraryProvider>");
  return env;
}

export const useLibraryStore = (): LibraryStore => useEnv().store;

/** 订阅 store 的一个切片；selector 必须返回稳定引用（原始值或 state 里已有的数组） */
export function useLibraryState<T>(selector: (s: LibraryState) => T): T {
  const { store } = useEnv();
  return useSlice(store, selector);
}

const EMPTY: readonly LibrarySession[] = [];

export function useWorkspaceSessions(
  workspaceId: string | null,
): readonly LibrarySession[] {
  const sessions = useLibraryState((s) => s.sessions);
  return useMemo(
    () =>
      workspaceId === null
        ? EMPTY
        : sessions.filter((s) => s.workspaceId === workspaceId),
    [sessions, workspaceId],
  );
}

export function useCurrentWorkspace(): CurrentWorkspace {
  const { current, select } = useEnv();
  return useMemo(() => ({ id: current, select }), [current, select]);
}
