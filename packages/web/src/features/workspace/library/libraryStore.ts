// 库数据层：工作区、分组与会话推送流的框架无关 store。
// 会话列表只从推送流来（重连即新快照）；工作区 / 分组走 REST，变更后重新拉取。
// 不做乐观更新：界面等 reload 拿到服务端的真相。

import { ApiError } from "../../../api/http";
import {
  applyLibraryEvent,
  type LibraryEvent,
  LibraryStream,
  type LibraryStreamHandlers,
} from "../../../api/libraryStream";
import type { LibrarySession } from "../../../api/sessionLibrary";
import type { WorkspaceGroup } from "../../../api/workspaceGroups";
import {
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  listWorkspaceGroups,
  patchWorkspaceGroup,
} from "../../../api/workspaceGroups";
import type { Workspace } from "../../../api/workspaces";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  patchWorkspace,
  reorderWorkspaces,
} from "../../../api/workspaces";
import { type ToastTone, toast } from "../../../ui/Toast";

export type WorkspaceInput = Parameters<typeof createWorkspace>[1];
export type WorkspacePatch = Parameters<typeof patchWorkspace>[2];
export type GroupPatch = Parameters<typeof patchWorkspaceGroup>[2];

export interface LibraryApi {
  listWorkspaces(): Promise<Workspace[]>;
  listGroups(): Promise<WorkspaceGroup[]>;
  createWorkspace(input: WorkspaceInput): Promise<Workspace>;
  patchWorkspace(id: string, patch: WorkspacePatch): Promise<Workspace>;
  reorderWorkspaces(ids: string[]): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  createGroup(input: { name: string; tone?: number }): Promise<WorkspaceGroup>;
  patchGroup(id: string, patch: GroupPatch): Promise<WorkspaceGroup>;
  deleteGroup(id: string): Promise<void>;
  /** 打开会话推送流；返回的句柄用于上报「我在看」与关闭 */
  openStream(h: LibraryStreamHandlers): {
    viewing(ids: readonly string[]): void;
    close(): void;
  };
}

/** 把 api/* 的函数绑上 token */
export function createLibraryApi(token: string | null): LibraryApi {
  return {
    listWorkspaces: () => listWorkspaces(token),
    listGroups: () => listWorkspaceGroups(token),
    createWorkspace: (input) => createWorkspace(token, input),
    patchWorkspace: (id, patch) => patchWorkspace(token, id, patch),
    reorderWorkspaces: (ids) => reorderWorkspaces(token, ids),
    deleteWorkspace: (id) => deleteWorkspace(token, id),
    createGroup: (input) => createWorkspaceGroup(token, input),
    patchGroup: (id, patch) => patchWorkspaceGroup(token, id, patch),
    deleteGroup: (id) => deleteWorkspaceGroup(token, id),
    openStream: (h) => new LibraryStream(token, h),
  };
}

export interface LibraryState {
  /** 服务端顺序（按 order） */
  workspaces: readonly Workspace[];
  groups: readonly WorkspaceGroup[];
  /** 顶层会话（含已归档），不含子代理会话；服务端推送合并而来 */
  sessions: readonly LibrarySession[];
  /** 目录已取到，且收到过第一份会话快照 */
  ready: boolean;
  /** 推送流当前是否连着；断开期间 sessions 可能过期 */
  live: boolean;
  /** 最近一次取工作区 / 分组失败 */
  failed: boolean;
}

export interface LibraryStore {
  getState(): LibraryState;
  subscribe(cb: () => void): () => void;
  start(): () => void;
  reload(): Promise<void>;
  setViewing(ids: readonly string[]): void;

  createWorkspace(input: WorkspaceInput): Promise<Workspace | null>;
  patchWorkspace(id: string, patch: WorkspacePatch): Promise<Workspace | null>;
  reorderWorkspaces(ids: string[]): Promise<boolean>;
  deleteWorkspace(id: string): Promise<boolean>;
  createGroup(input: {
    name: string;
    tone?: number;
  }): Promise<WorkspaceGroup | null>;
  patchGroup(id: string, patch: GroupPatch): Promise<WorkspaceGroup | null>;
  deleteGroup(id: string): Promise<boolean>;
}

export interface LibraryStoreOptions {
  api: LibraryApi;
  notify?: (message: string, tone: ToastTone) => void;
  /** 发现未知工作区后去抖重新拉取的间隔，默认 300ms */
  unknownReloadMs?: number;
}

const ERR_TEXT: Record<string, string> = {
  session_running: "有会话正在运行，先停止它再操作",
  not_found: "已不存在，列表已刷新",
  unknown_group: "分组不存在，列表已刷新",
  too_many_directories: "目录太多了，先去掉几个再试",
  duplicate_directory: "同一个目录不能重复添加",
  local_immutable: "本地主目录不能改",
};

/** 把接口错误翻成给人看的一句话 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return "网络不通，请稍后重试";
    return (e.code && ERR_TEXT[e.code]) || "操作失败，请重试";
  }
  return "操作失败，请重试";
}

const yes = () => true as const;

export function createLibraryStore(opts: LibraryStoreOptions): LibraryStore {
  const { api } = opts;
  const notify =
    opts.notify ?? ((m: string, tone: ToastTone) => void toast(m, { tone }));
  const unknownReloadMs = opts.unknownReloadMs ?? 300;

  let state: LibraryState = {
    workspaces: [],
    groups: [],
    sessions: [],
    ready: false,
    live: false,
    failed: false,
  };
  const subs = new Set<() => void>();
  // 停掉之后一律不写回
  const set = (patch: Partial<LibraryState>) => {
    if (!alive) return;
    state = { ...state, ...patch };
    for (const s of [...subs]) s();
  };

  let alive = false;
  let stream: { viewing(ids: readonly string[]): void; close(): void } | null =
    null;
  let haveDirs = false;
  let haveSnapshot = false;
  const ready = () => haveDirs && haveSnapshot;

  // 未知工作区的去抖重取：同一个未知 id 只请求一次，免得来回打
  const unknownAsked = new Set<string>();
  let unknownTimer: ReturnType<typeof setTimeout> | undefined;

  const setLive = (live: boolean) => set({ live });

  /** 记下目录里还没有的工作区 id；返回是否有新的（同一个 id 只记一次） */
  function noteUnknown(list: readonly LibrarySession[]): boolean {
    const known = new Set(state.workspaces.map((w) => w.id));
    let fresh = false;
    for (const s of list) {
      const wid = s.workspaceId;
      if (wid === null || known.has(wid) || unknownAsked.has(wid)) continue;
      unknownAsked.add(wid);
      fresh = true;
    }
    return fresh;
  }

  function onEvent(e: LibraryEvent): void {
    if (e.type === "snapshot") {
      haveSnapshot = true;
      set({ sessions: e.sessions, ready: ready() });
      // 重连后工作区 / 分组可能已被别处改过；未知的工作区也靠这次刷新补上，不必再去抖一次
      noteUnknown(e.sessions);
      void reload();
      return;
    }
    const sessions = applyLibraryEvent(state.sessions, e);
    if (sessions === state.sessions) return;
    set({ sessions });
    if (e.type === "removed" || !noteUnknown(sessions)) return;
    clearTimeout(unknownTimer);
    unknownTimer = setTimeout(() => {
      unknownTimer = undefined;
      void reload();
    }, unknownReloadMs);
  }

  function onStatus(s: "live" | "reconnecting"): void {
    setLive(s === "live");
  }

  async function fetchDirs(): Promise<void> {
    try {
      const [workspaces, groups] = await Promise.all([
        api.listWorkspaces(),
        api.listGroups(),
      ]);
      haveDirs = true;
      const ids = new Set(workspaces.map((w) => w.id));
      for (const id of unknownAsked) if (ids.has(id)) unknownAsked.delete(id);
      set({ workspaces, groups, failed: false, ready: ready() });
    } catch {
      set({ failed: true });
    }
  }

  let inflight: Promise<void> | null = null;
  let again = false;

  async function cycle(): Promise<void> {
    // 在飞时再调：等这轮结束再补一次，多次调用只补一次
    do {
      again = false;
      await fetchDirs();
    } while (again);
  }

  function reload(): Promise<void> {
    if (!inflight) {
      inflight = cycle().then(() => {
        inflight = null;
      });
    } else {
      again = true;
    }
    return inflight;
  }

  /** 跑一个变更：失败 toast；无论成败都重新拉取 */
  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      notify(errorText(e), "danger");
      return null;
    } finally {
      await reload();
    }
  }

  // 布尔类变更：成功 true，失败 false
  const runOk = async (fn: () => Promise<unknown>): Promise<boolean> =>
    (await run(fn)) !== null;

  const store: LibraryStore = {
    getState: () => state,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },

    start() {
      alive = true;
      haveDirs = false;
      haveSnapshot = false;
      set({ ready: false });
      void reload();
      stream = api.openStream({ onEvent, onStatus });
      return () => {
        set({ ready: false });
        setLive(false);
        alive = false;
        haveDirs = false;
        haveSnapshot = false;
        clearTimeout(unknownTimer);
        unknownTimer = undefined;
        stream?.close();
        stream = null;
      };
    },

    reload,

    setViewing(ids) {
      stream?.viewing(ids);
    },

    createWorkspace: (input) => run(() => api.createWorkspace(input)),
    patchWorkspace: (id, patch) => run(() => api.patchWorkspace(id, patch)),
    reorderWorkspaces: (ids) =>
      runOk(() => api.reorderWorkspaces(ids).then(yes)),
    deleteWorkspace: (id) => runOk(() => api.deleteWorkspace(id).then(yes)),
    createGroup: (input) => run(() => api.createGroup(input)),
    patchGroup: (id, patch) => run(() => api.patchGroup(id, patch)),
    deleteGroup: (id) => runOk(() => api.deleteGroup(id).then(yes)),
  };
  return store;
}
