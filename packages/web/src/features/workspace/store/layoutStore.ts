// 每个工作区一份布局的 store：载入 /workspaces/:id/layout、会话列表变化后收敛、变更后去抖保存。
// 不用外部状态库：getState/subscribe 直接接 useSyncExternalStore。
// 所有布局变换只调用 model 里的纯函数；失败的 Result 在这里统一转成 toast 文案。
// 骨架照抄 store/store.ts（旧的全局文档 store），只在容器与上下文的粒度上不同。

import type { Result as ApiResult, Failure } from "../../../api/http";
import type { PutResult, Workbench } from "../../../api/layout";
import { type ToastTone, toast } from "../../../ui/Toast";
import type { EdgeZone } from "../../../ui/tiling/tree";
import type { DropZone } from "../../../ui/tiling/zones";
import * as L2 from "../model/l2";
import * as MV from "../model/l2move";
import {
  emptyLayout,
  hasWindows,
  type LayoutDoc,
  layoutIds,
  layoutWithinBudget,
  loadLayout,
} from "../model/layoutDoc";
import * as Ops from "../model/layoutOps";
import { MAX_DOC_BYTES } from "../model/persist";
import type {
  Result,
  Tab,
  TabAfx,
  Window,
  WindowState,
  WinMap,
} from "../model/types";
import { ok } from "../model/types";

export interface LayoutApi {
  get(workspaceId: string): Promise<ApiResult<Workbench>>;
  put(
    workspaceId: string,
    baseRevision: number,
    document: unknown,
    keepalive?: boolean,
  ): Promise<PutResult>;
}

export type LayoutStatus = "idle" | "loading" | "ready" | "error" | "blocked";

export interface LayoutState {
  workspaceId: string | null;
  doc: LayoutDoc;
  status: LayoutStatus;
  /** 载入失败时的原因（status=error） */
  error: Failure["kind"] | null;
  /** 有尚未落盘的修改 */
  dirty: boolean;
  revision: number;
}

/** 当前工作区的会话（顶层，不含子代理会话） */
export interface SessionBrief {
  id: string;
  updatedAt: string;
  archived: boolean;
}

export interface LayoutStoreOptions {
  api: LayoutApi;
  /** 去抖间隔，默认 800ms */
  debounceMs?: number;
  /** 文档体积上限，默认与服务端 bodyLimit 一致（256KB） */
  maxBytes?: number;
  /** 主机 id → 展示名，用于 host-conflict 文案 */
  hostName?: (id: string) => string;
  notify?: (message: string, tone: ToastTone) => void;
}

export interface LayoutStore {
  getState(): LayoutState;
  subscribe(cb: () => void): () => void;
  /** 切到另一个工作区：先保存当前工作区，再载入新的；null 回到空状态 */
  setWorkspace(id: string | null): Promise<void>;
  /** 工作区目录清单（第 0 个是主目录）；只对 workspaceId 就是当前工作区时生效 */
  setDirectories(
    workspaceId: string | null,
    list: readonly L2.Directory[] | null,
  ): void;
  /** 会话列表；null 表示还没拿到，此时不收敛；同样只对当前工作区生效 */
  setSessions(
    workspaceId: string | null,
    list: readonly SessionBrief[] | null,
  ): void;
  flush(keepalive?: boolean): Promise<void>;
  dispose(): void;

  // ── 窗口与窗格（均作用于当前工作区的文档）──
  switchWindow(index: number): boolean;
  addWindow(): boolean;
  closeWindow(index: number): boolean;
  focusPane(pid: string): boolean;
  activateTab(pid: string, tid: string): boolean;
  closeTab(pid: string, tid: string): boolean;
  addTab(pid: string, type: Tab["type"], init?: L2.TabInit): boolean;
  /** 新建标签（+ 菜单入口）：主机级标签的主机与窗格不同时，在窗格右侧新建窗格承载 */
  openTab(pid: string, type: Tab["type"], init?: L2.TabInit): boolean;
  splitWithTab(pid: string, zone: EdgeZone, tab: Tab): boolean;
  closePane(pid: string): boolean;
  setPaneSizes(path: readonly number[], sizes: readonly number[]): boolean;
  patchTab(tid: string, patch: L2.TabPatch): boolean;
  patchAfx(tid: string, patch: Partial<TabAfx>): boolean;
  openDiff(
    fromPid: string,
    fromTabId: string | null,
    /** null = 工作区 vs HEAD（git 面板） */
    turn: number | null,
    path: string,
    /** 某一轮属于哪个会话；turn 为 null 时不需要 */
    sid?: string,
  ): boolean;
  /** 团队建队以来某文件的改动；sid 是团队所属的会话 */
  openTeamDiff(
    fromPid: string,
    fromTabId: string | null,
    path: string,
    sid: string,
  ): boolean;
  /** 文件管理器点文件：temp = 单击（临时预览），否则固定（双击 / Enter） */
  openPreview(
    fromPid: string,
    fromTabId: string | null,
    path: string,
    temp: boolean,
  ): boolean;
  /** agent 开始用浏览器：把它在用的页面摆出来（没有浏览器标签就新开窗格、在后台就切过去、在前台不动），不动焦点 */
  revealBrowser(pageId: string): boolean;
  /** 用户点了「查看」（agent 展示的页面）：从当前焦点窗格出发 openInBrowser */
  openBrowserPage(pageId: string): boolean;
  /** 用户主动在浏览器里看某个页面：已有浏览器标签就显示它并切过去，没有就在来源窗格右侧新开窗格；焦点跟过去 */
  openInBrowser(fromPid: string, pageId: string): boolean;
  /** 对话里点文件引用：落点规则与 diff 一致（有预览窗格就用，没有就新开窗格） */
  openFilePreview(
    fromPid: string,
    fromTabId: string | null,
    host: string,
    path: string,
  ): boolean;
  moveTab(
    fromPid: string,
    tid: string,
    toPid: string,
    zone: DropZone,
    beforeTabId?: string,
  ): boolean;
  movePane(fromPid: string, toPid: string, zone: DropZone): boolean;
  movePaneToWindow(pid: string, winIndex: number): boolean;
  detachPane(pid: string): boolean;

  // ── 会话行 ──
  /** 单击会话行：临时查看（替换临时标签） */
  showSession(sid: string): boolean;
  /** 双击会话行 / 明确的「固定」 */
  pinSession(sid: string): boolean;
  /** 把会话行拖进窗格：落点处放它的固定对话标签（已显示就移动那个标签） */
  placeSession(
    sid: string,
    toPid: string,
    zone: DropZone,
    beforeTabId?: string,
  ): boolean;
  /** 当前窗口里正在显示的会话 id */
  viewing(): string[];
  /** 刚新建 / 分叉出、会话列表还没带上的会话：先当作存在，免得它的标签被收敛关掉 */
  adoptSession(sid: string): void;
  /** 会话属于当前工作区（含刚新建、列表还没带上的）；别的工作区的会话不能放进这里的窗口 */
  hasSession(sid: string): boolean;
  /**
   * 工作区级标签（终端、文件）要借用一条会话流时用的会话：正在显示的第一个，
   * 否则窗口里任一对话标签的会话，再否则最近的未归档会话；都没有为 null。
   */
  anchorSession(): string | null;
}

const MERGE_HINT = L2.MERGE_HINT;

export function createLayoutStore(opts: LayoutStoreOptions): LayoutStore {
  const { api } = opts;
  const debounceMs = opts.debounceMs ?? 800;
  const maxBytes = opts.maxBytes ?? MAX_DOC_BYTES;
  const notify =
    opts.notify ?? ((m: string, tone: ToastTone) => void toast(m, { tone }));
  const hostName = opts.hostName ?? ((id: string) => id);

  let state: LayoutState = {
    workspaceId: null,
    doc: emptyLayout(),
    status: "idle",
    error: null,
    dirty: false,
    revision: 0,
  };
  /**
   * 目录清单与会话列表是按工作区给的；切换时新工作区的上下文会先于旧文档落盘到达，
   * 只认属于当前文档所在工作区的那一份，免得旧文档被别的工作区的会话列表「收敛」掉。
   */
  const scoped = <T>() => {
    let held: { workspaceId: string | null; value: T | null } = {
      workspaceId: null,
      value: null,
    };
    return {
      set: (workspaceId: string | null, value: T | null) => {
        held = { workspaceId, value };
      },
      get: (): T | null =>
        held.workspaceId === state.workspaceId ? held.value : null,
    };
  };
  const dirs = scoped<readonly L2.Directory[]>();
  const sessions = scoped<readonly SessionBrief[]>();
  /** 载入的文档还没有窗口，等上下文到齐再补默认窗口 */
  let pendingDefault = false;
  /** 刚登记、列表里还没出现的会话 id；列表带上之后移出 */
  const adopted = new Set<string>();
  /** 本次载入的文档是否已经收敛过（第一次收敛要把空对话标签回落到最新会话） */
  let filled = false;
  /** 载入令牌：切换工作区后丢弃过期的载入结果 */
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 保存串行化：每次保存等上一次落盘，切换工作区时才有一份确定的旧文档要存 */
  let queue: Promise<void> = Promise.resolve();
  let failedOnce = false;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<LayoutState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };

  const latestSid = (): string | null => {
    const list = sessions.get();
    if (list === null) return null;
    let best: SessionBrief | null = null;
    for (const b of list) {
      if (b.archived) continue;
      if (!best || b.updatedAt > best.updatedAt) best = b;
    }
    return best?.id ?? null;
  };

  const ctxOf = (doc: LayoutDoc): L2.Ctx => ({
    ids: L2.idGenFrom(layoutIds(doc)),
  });

  /**
   * 布局文档 ↔ 单键 WinMap：l2.updateWindow 与 l2move 的函数以 WinMap 为参，
   * 键就是当前工作区（占位串在 ready 之外用不到）。适配只在这里。
   */
  const withWins = (
    doc: LayoutDoc,
    fn: (wins: WinMap, sid: string, ctx: L2.Ctx) => Result<WinMap>,
  ): Result<LayoutDoc> => {
    const sid = state.workspaceId ?? "";
    const r = fn({ [sid]: doc.windows }, sid, ctxOf(doc));
    if (!r.ok) return r;
    const next = r.value[sid] ?? doc.windows;
    return ok(next === doc.windows ? doc : { ...doc, windows: next });
  };

  // ── 保存 ──

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  };

  function flush(keepalive = false): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    const next = queue.then(() => save(keepalive));
    // 一次失败不阻挡后续保存（save 自己已经提示过）
    queue = next.catch(() => undefined);
    return next;
  }

  async function save(keepalive: boolean): Promise<void> {
    const id = state.workspaceId;
    if (!state.dirty || state.status !== "ready" || id === null) return;
    const snap = state.doc;
    if (!layoutWithinBudget(snap, maxBytes)) {
      notify("布局超过 256KB，未保存。请关闭一些窗口或标签页", "danger");
      return;
    }
    const r = await api.put(id, state.revision, snap, keepalive);
    if (r.ok) {
      failedOnce = false;
      set({ revision: r.revision, dirty: state.doc !== snap });
      if (state.doc !== snap) schedule();
      return;
    }
    if (r.kind === "conflict") {
      adopt(r.current);
      notify("布局已在别处更新，已载入最新版本", "warn");
      return;
    }
    if (!failedOnce) notify("布局保存失败，修改会在下次变更时重试", "warn");
    failedOnce = true;
  }

  // ── 载入 / 采用服务端文档 ──

  function adopt(wb: Workbench): void {
    clearTimeout(timer);
    filled = false;
    const loaded =
      wb.document == null ? ok(emptyLayout()) : loadLayout(wb.document);
    if (!loaded.ok) {
      // 版本比当前客户端新：不覆盖，保持只读
      pendingDefault = false;
      set({ status: "blocked", revision: wb.revision, dirty: false });
      return;
    }
    pendingDefault = !hasWindows(loaded.value);
    set({
      doc: loaded.value,
      status: pendingDefault ? "loading" : "ready",
      error: null,
      revision: wb.revision,
      dirty: false,
    });
    if (tryDefault()) return;
    reconcile();
  }

  /** 文档还没有窗口时补一个默认窗口；上下文没到齐就继续等 */
  function tryDefault(): boolean {
    const directories = dirs.get();
    if (!pendingDefault || !directories || !sessions.get()) return false;
    pendingDefault = false;
    const doc = state.doc;
    const windows = L2.initialWindows(
      ctxOf(doc),
      directories,
      latestSid() ?? undefined,
    );
    set({ doc: { ...doc, windows }, status: "ready", dirty: true });
    schedule();
    reconcile();
    return true;
  }

  async function loadWorkspace(id: string): Promise<void> {
    const mine = ++token;
    pendingDefault = false;
    set({
      workspaceId: id,
      doc: emptyLayout(),
      status: "loading",
      error: null,
      dirty: false,
      revision: 0,
    });
    const r = await api.get(id);
    if (mine !== token) return;
    if (!r.ok) {
      set({ status: "error", error: r.kind });
      return;
    }
    adopt(r.data);
  }

  function clearState(): void {
    token += 1;
    clearTimeout(timer);
    pendingDefault = false;
    filled = false;
    set({
      workspaceId: null,
      doc: emptyLayout(),
      status: "idle",
      error: null,
      dirty: false,
      revision: 0,
    });
  }

  async function setWorkspace(id: string | null): Promise<void> {
    if (id === state.workspaceId) return;
    await flush();
    if (id === null) clearState();
    else await loadWorkspace(id);
  }

  /** 会话列表变化后收敛：失效会话的标签关掉，必要时空对话标签绑最新会话；有变化才提交 */
  function reconcile(): void {
    const list = sessions.get();
    if (state.status !== "ready" || list === null) return;
    const doc = state.doc;
    const known = new Set(list.map((b) => b.id));
    for (const id of adopted) {
      if (known.has(id)) adopted.delete(id);
      else known.add(id);
    }
    const fill = !filled;
    filled = true;
    const windows = Ops.reconcileSessions(
      doc.windows,
      known,
      latestSid(),
      ctxOf(doc),
      fill,
    );
    if (windows !== doc.windows) commit({ ...doc, windows });
  }

  // ── 提交 ──

  function commit(next: LayoutDoc): void {
    if (state.status !== "ready" || next === state.doc) return;
    set({ doc: next, dirty: true });
    schedule();
  }

  /** 失败文案：host-conflict 用主机展示名替换 id */
  function explain(r: Extract<Result<unknown>, { ok: false }>): string {
    if (r.code === "host-conflict" && r.hosts) {
      const [a, b] = r.hosts;
      return `窗格已绑定 ${hostName(a)}，标签属于 ${hostName(b)}${MERGE_HINT}`;
    }
    return r.error;
  }

  function apply(fn: (doc: LayoutDoc) => Result<LayoutDoc>): boolean {
    if (state.status !== "ready") return false;
    const r = fn(state.doc);
    if (!r.ok) {
      notify(explain(r), r.code === "too-new" ? "danger" : "warn");
      return false;
    }
    commit(r.value);
    return true;
  }

  /** 对当前窗口应用窗口级操作 */
  const winAct = (fn: (w: Window, ctx: L2.Ctx) => Result<Window>): boolean =>
    apply((doc) =>
      withWins(doc, (wins, sid, ctx) =>
        L2.updateWindow(wins, sid, (w) => fn(w, ctx)),
      ),
    );

  const stateAct = (
    fn: (st: WindowState, ctx: L2.Ctx) => Result<WindowState>,
  ): boolean =>
    apply((doc) => {
      const r = fn(doc.windows, ctxOf(doc));
      if (!r.ok) return r;
      return ok(r.value === doc.windows ? doc : { ...doc, windows: r.value });
    });

  return {
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    setWorkspace,
    setDirectories(workspaceId, list) {
      dirs.set(workspaceId, list);
      tryDefault();
    },
    setSessions(workspaceId, list) {
      sessions.set(workspaceId, list);
      if (!tryDefault()) reconcile();
    },
    flush,
    dispose() {
      clearTimeout(timer);
      listeners.clear();
    },

    switchWindow: (index) => stateAct((st) => L2.switchWindow(st, index)),
    addWindow() {
      const directories = dirs.get();
      if (!directories) return false;
      return stateAct((st, ctx) => ok(L2.addWindow(st, ctx, directories)));
    },
    closeWindow: (index) => stateAct((st) => L2.closeWindow(st, index)),
    focusPane(pid) {
      const { list, active } = state.doc.windows;
      if (list[active]?.focus === pid) return true;
      return winAct((w) => L2.setFocus(w, pid));
    },
    activateTab: (pid, tid) => winAct((w) => L2.activateTab(w, pid, tid)),
    closeTab: (pid, tid) => winAct((w, ctx) => L2.closeTab(w, pid, tid, ctx)),
    addTab: (pid, type, init) =>
      winAct((w, ctx) => L2.addTab(w, pid, L2.newTab(ctx, type, init), ctx)),
    openTab: (pid, type, init) =>
      winAct((w, ctx) => {
        const tab = L2.newTab(ctx, type, init);
        const pane = L2.findPane(w, pid);
        if (pane && L2.hostConflict(pane, tab))
          return L2.splitPane(w, pid, "right", tab, ctx);
        return L2.addTab(w, pid, tab, ctx);
      }),
    splitWithTab: (pid, zone, tab) =>
      winAct((w, ctx) => L2.splitPane(w, pid, zone, tab, ctx)),
    closePane: (pid) => winAct((w) => L2.closePane(w, pid)),
    setPaneSizes: (path, sizes) =>
      winAct((w) => L2.setPaneSizes(w, path, sizes)),
    patchTab: (tid, patch) => winAct((w) => L2.patchTab(w, tid, patch)),
    patchAfx: (tid, patch) => winAct((w) => L2.patchAfx(w, tid, patch)),
    openPreview: (fromPid, fromTabId, path, temp) =>
      winAct((w, ctx) =>
        L2.openPreview(w, fromPid, fromTabId, path, ctx, temp),
      ),
    openFilePreview: (fromPid, fromTabId, host, path) =>
      winAct((w, ctx) =>
        L2.openFilePreview(w, fromPid, fromTabId, host, path, ctx),
      ),
    openInBrowser: (fromPid, pageId) =>
      winAct((w, ctx) => L2.openInBrowser(w, fromPid, pageId, ctx)),
    openBrowserPage: (pageId) =>
      winAct((w, ctx) => L2.openInBrowser(w, w.focus, pageId, ctx)),
    revealBrowser: (pageId) =>
      winAct((w, ctx) => L2.revealBrowser(w, pageId, ctx)),
    openDiff: (fromPid, fromTabId, turn, path, sid) =>
      winAct((w, ctx) =>
        L2.openDiff(w, fromPid, fromTabId, turn, path, ctx, sid),
      ),
    openTeamDiff: (fromPid, fromTabId, path, sid) =>
      winAct((w, ctx) =>
        L2.openTeamDiff(w, fromPid, fromTabId, path, ctx, sid),
      ),

    moveTab: (fromPid, tid, toPid, zone, before) =>
      apply((doc) =>
        withWins(doc, (wins, _sid, ctx) =>
          MV.moveTabIn(wins, fromPid, tid, toPid, zone, ctx.ids, before),
        ),
      ),
    movePane: (fromPid, toPid, zone) =>
      apply((doc) =>
        withWins(doc, (wins) => MV.movePaneIn(wins, fromPid, toPid, zone)),
      ),
    movePaneToWindow: (pid, winIndex) =>
      apply((doc) =>
        withWins(doc, (wins, sid) =>
          MV.movePaneToWindowIn(wins, sid, pid, winIndex),
        ),
      ),
    detachPane: (pid) => stateAct((st, ctx) => MV.detachPane(st, pid, ctx.ids)),

    showSession: (sid) => winAct((w, ctx) => Ops.showSession(w, sid, ctx)),
    pinSession: (sid) => winAct((w, ctx) => Ops.pinSession(w, sid, ctx)),
    placeSession: (sid, toPid, zone, before) =>
      winAct((w, ctx) => Ops.placeSession(w, sid, toPid, zone, ctx, before)),
    viewing: () => Ops.viewingSids(state.doc.windows),
    adoptSession(sid) {
      adopted.add(sid);
    },
    hasSession: (sid) =>
      adopted.has(sid) || (sessions.get()?.some((b) => b.id === sid) ?? false),
    anchorSession: () =>
      Ops.viewingSids(state.doc.windows)[0] ??
      Ops.chatSids(state.doc.windows)[0] ??
      latestSid(),
  };
}
