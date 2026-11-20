// 页面模型：有哪些页面、归谁、谁能动、什么时候休眠、会话没了怎么收。
// 上层（工具、接口）只经这里操作页面；库只负责重启后的恢复与列表持久。
import { randomInt } from "node:crypto";
import type { BrowserPageStore, PageRow } from "../../store/browser-pages.js";
import type {
  BrowserCtx,
  PageDialog,
  PageDownload,
  PageFileChooser,
  PageHandle,
  StorageState,
} from "../engine/types.js";
import {
  actDenied,
  canClaim,
  type PolicyPage,
  pickSleepingToDrop,
  pickSleepVictim,
} from "./policy.js";
import type { ThumbStore } from "./thumbs.js";
import {
  DEFAULT_LIMITS,
  type HandoffAnswer,
  type Limits,
  PageError,
  type PageEvent,
  type PageView,
  type PendingDownloadView,
  type PendingUploadView,
} from "./types.js";

export interface RegistryDeps {
  store: BrowserPageStore;
  thumbs: ThumbStore;
  /** 取（惰性创建）某个键的浏览上下文；失败抛错，这里包成 context_failed。 */
  context(workspaceKey: string): Promise<BrowserCtx>;
  /** 会话的根会话（子代理 → 它的根）；没有层级的会话返回自己。 */
  rootOf(sessionId: string): string;
  /** 根会话此刻是不是在跑一轮。 */
  isBusy(rootSessionId: string): boolean;
  /** 页面里开始的下载（带着它当时的页面视图）；没人接的由实现决定收下还是取消。 */
  onDownload(page: PageView, d: PageDownload): void;
  /** 页面里弹出的文件选择（带着它当时的页面视图）；没人接的由实现决定挂起还是不管。 */
  onFileChooser(page: PageView, c: PageFileChooser): void;
  /** 会话的显示名，用在「页面正被会话 X 使用」里；缺省用会话 id 的前 8 位。 */
  label?(sessionId: string): string;
  limits?: Partial<Limits>;
  now?: () => number;
}

// 内存里的活页面：持久字段 + 只在内存里的归属、观众、加载状态。
interface Live {
  row: PageRow;
  usedBy: string[];
  inUseBy: string | null;
  handle: PageHandle | null;
  viewers: number;
  handoffPending: boolean;
  handoffReason: string | null;
  /** 用户页上挂起、等用户决定存到哪的下载；只在内存里。 */
  pendingDownloads: PendingDownloadView[];
  /** 用户页上等用户选文件的选择器；只在内存里。 */
  pendingUpload: PendingUploadView | null;
  loading: boolean;
  /** 唤醒进行中：并发 use 合流，避免同一页面被激活两次。 */
  waking: Promise<PageHandle> | null;
  /** 我们主动关的页面：onClose 回调里不再处理。 */
  closing: boolean;
}

// 写库限频：页面频繁 onChange 时不跟着抖，同一页面两次写库间隔不小于它。
const WRITE_INTERVAL_MS = 500;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
// 每个工作区的弹窗日志只留最近这么多条。
const POPUP_LOG_MAX = 50;
// 对话框提示里页面文字最多留这么长。
const DIALOG_MESSAGE_MAX = 200;

/** 弹窗日志的一条：序号、页面编号与来源页面（工具层据此告诉 agent 多了哪一页）。 */
interface Popup {
  seq: number;
  pageId: string;
  openerId: string | null;
}

export class PageRegistry {
  private readonly store: BrowserPageStore;
  private readonly thumbs: ThumbStore;
  private readonly deps: RegistryDeps;
  private readonly limits: Limits;
  private readonly now: () => number;
  private readonly pages = new Map<string, Live>();
  private readonly ctxs = new Map<string, BrowserCtx>();
  private readonly ctxPending = new Map<string, Promise<BrowserCtx>>();
  private readonly listeners = new Set<(e: PageEvent) => void>();
  /** 正在等用户接管的页面：值是结算这次等待的函数。 */
  private readonly handoffs = new Map<string, (a: HandoffAnswer) => void>();
  /** 上次写库时间与排队中的写库定时器（按页面限频）。 */
  private readonly writtenAt = new Map<string, number>();
  private readonly writeTimers = new Map<string, NodeJS.Timeout>();
  /** 每个工作区最近的弹窗日志；seq 全局单调递增。 */
  private readonly popupLogs = new Map<string, Popup[]>();
  private popupSeqCount = 0;
  private disposed = false;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.thumbs = deps.thumbs;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
  }

  /** 启动时调用：库里所有记录置为 sleeping（上一进程的真页面都已不在），清理多余缩略图。 */
  restore(): void {
    const rows = this.store.list();
    for (const { row, usedBy } of rows) {
      if (row.state === "active")
        this.store.update(row.id, { state: "sleeping" });
      this.pages.set(row.id, this.live({ ...row, state: "sleeping" }, usedBy));
    }
    this.thumbs.prune(new Set(rows.map((r) => r.row.id)));
  }

  list(workspaceKey: string): PageView[] {
    return this.ordered()
      .filter((p) => p.row.workspaceKey === workspaceKey)
      .map((p) => this.view(p));
  }

  get(id: string): PageView | null {
    const page = this.pages.get(id);
    return page ? this.view(page) : null;
  }

  /** 开一个页面并导航。actor 为 null 表示用户开的；页面先登记再 goto，goto 失败仍留在列表里。 */
  async open(args: {
    workspaceKey: string;
    actor: string | null;
    url: string;
  }): Promise<{ page: PageView; status: number | null; deny: string | null }> {
    this.assertUsable();
    const root = args.actor === null ? null : this.deps.rootOf(args.actor);
    await this.ensureRoom(args.workspaceKey);

    const ctx = await this.context(args.workspaceKey);
    let handle: PageHandle;
    try {
      handle = await ctx.newPage();
    } catch (err) {
      throw new PageError(
        "context_failed",
        `没能打开新页面：${reason(err)}。浏览器可能刚崩过，稍后再试。`,
      );
    }

    const at = new Date(this.now()).toISOString();
    const row: PageRow = {
      id: this.newId(),
      workspaceKey: args.workspaceKey,
      url: args.url,
      title: "",
      // 用户开的页面起始就是用户操作；agent 开的是 agent 操作。
      userOpened: root === null,
      controller: root === null ? "user" : "agent",
      state: "active",
      epoch: 0,
      createdAt: at,
      lastUsedAt: at,
    };
    const usedBy = root === null ? [] : [root];
    this.store.insert(row, usedBy);
    const page: Live = {
      row,
      usedBy,
      inUseBy: root,
      handle,
      viewers: 0,
      handoffPending: false,
      handoffReason: null,
      pendingDownloads: [],
      pendingUpload: null,
      loading: handle.loading(),
      waking: null,
      closing: false,
    };
    this.pages.set(row.id, page);
    this.bind(page);
    this.emit({ type: "added", page: this.view(page) });
    // goto 失败时错误原样抛给调用方：页面已经在列表里了。
    const res = await handle.goto(args.url);
    return { page: this.view(page), status: res.status, deny: res.deny };
  }

  /**
   * 取一个可用的页面句柄（休眠的会先唤醒）。
   * observe 只读，不看归属；act 先过操作权，再认领。
   */
  async use(
    id: string,
    actor: string,
    intent: "observe" | "act",
    opts: { allowDialog?: boolean } = {},
  ): Promise<PageHandle> {
    this.assertUsable();
    const page = this.need(id);
    const root = this.deps.rootOf(actor);
    // 对话框挂着时页面主线程是死的，除纯内存读取外一律拒绝；抛在认领之前，不改变归属。
    if (!opts.allowDialog) {
      const dialog = page.handle?.dialog() ?? null;
      if (dialog !== null)
        throw new PageError("dialog_pending", dialogPendingText(dialog));
    }
    if (intent === "act") this.checkAct(page, root);
    const handle = page.handle ?? (await this.wake(page));

    if (intent === "observe") {
      // 只是看看也刷新「最近用过」，免得正在读的页面被当成最久没用而休眠。
      this.touch(page);
      this.persist(page);
      return handle;
    }
    // 唤醒期间页面可能被别人拿走，认领放在拿到真页面之后再做一次。
    this.checkAct(page, root);
    if (!page.usedBy.includes(root)) {
      page.usedBy = [...page.usedBy, root].sort();
      this.store.addRef(id, root);
    }
    page.inUseBy = root;
    this.touch(page);
    this.persist(page);
    this.emitUpdated(page);
    return handle;
  }

  /** 数量上限，界面显示「已激活 / 上限」用。 */
  limitsView(): Limits {
    return { ...this.limits };
  }

  /** 激活页面的句柄；休眠的给 null，不唤醒。界面的画面流只接活页面。 */
  peek(id: string): PageHandle | null {
    return this.pages.get(id)?.handle ?? null;
  }

  /** 用户主动唤醒休眠页（界面的「唤醒」）：不认领、不过操作权；已激活的原样返回。 */
  async activate(id: string): Promise<PageView> {
    this.assertUsable();
    const page = this.need(id);
    await this.wake(page);
    this.touch(page);
    this.persist(page);
    return this.view(page);
  }

  /** 用户在界面上操作了页面：刷新「最近用过」，免得它被当成最久没用而休眠。 */
  noteActivity(id: string): void {
    const page = this.pages.get(id);
    if (!page) return;
    this.touch(page);
    this.persist(page);
  }

  /** 用户切换操作权：切回 agent 时 epoch + 1，上层据此让旧元素编号作废。 */
  control(id: string, mode: "user" | "agent"): PageView {
    const page = this.need(id);
    // 交还 agent 就是接管完成：等着的接管请求一并结算。
    if (mode === "agent") this.answerHandoff(id, { kind: "done" });
    if (page.row.controller === mode) return this.view(page);
    page.row.controller = mode;
    if (mode === "agent") page.row.epoch += 1;
    this.store.update(id, {
      controller: mode,
      ...(mode === "agent" ? { epoch: page.row.epoch } : {}),
    });
    this.touch(page);
    this.emitUpdated(page);
    return this.view(page);
  }

  /** 关页面并删记录。用户能关任何页面；会话只能关自己用过的、非用户开的页面。 */
  async close(id: string, by: "user" | { session: string }): Promise<void> {
    const page = this.need(id);
    if (by !== "user") {
      const root = this.deps.rootOf(by.session);
      if (page.row.userOpened)
        throw new PageError(
          "user_page",
          `页面「${this.titleOf(page)}」是用户自己打开的，只有用户能关闭。`,
        );
      if (page.row.controller === "user")
        throw new PageError(
          "user_page",
          `页面「${this.titleOf(page)}」正由用户手动操作，agent 不能关；等用户点「交还 agent」后再试。`,
        );
      if (!page.usedBy.includes(root) && page.inUseBy !== root)
        throw new PageError(
          "user_page",
          `页面「${this.titleOf(page)}」不是你用过的页面，不能关闭；只能关闭自己打开或认领过的页面。`,
        );
    }
    await this.discard(page);
  }

  /** 会话归档 / 删除：引用计数，返回被关闭的页面 id。 */
  async releaseSession(sessionId: string): Promise<string[]> {
    const root = this.deps.rootOf(sessionId);
    // 子代理会话的页面记在它的根会话名下：删一个子代理不能放掉根会话的页面。
    if (root !== sessionId) return [];
    // 先一次性清掉库里的引用，再按内存里的活页面逐个决定关不关。
    this.store.removeSessionRefs(root);
    const closed: string[] = [];
    for (const page of [...this.pages.values()]) {
      if (!page.usedBy.includes(root) && page.inUseBy !== root) continue;
      page.usedBy = page.usedBy.filter((s) => s !== root);
      if (page.inUseBy === root) page.inUseBy = null;
      if (page.usedBy.length > 0) {
        this.emitUpdated(page);
        continue;
      }
      // 用户正在手动操作：不关，转成用户的页面，留在「我的」组。
      if (page.row.controller === "user" && !page.row.userOpened) {
        page.row.userOpened = true;
        this.store.update(page.row.id, { userOpened: true });
        this.emitUpdated(page);
        continue;
      }
      // 用户开的页面不参与引用计数，只有用户能关；agent 用过的标记没了，回到手动状态。
      if (page.row.userOpened) {
        if (page.row.controller === "agent") {
          page.row.controller = "user";
          this.store.update(page.row.id, { controller: "user" });
        }
        this.emitUpdated(page);
        continue;
      }
      await this.discard(page);
      closed.push(page.row.id);
    }
    return closed;
  }

  /** 删工作区：关闭并删除该键下所有页面、关掉它的上下文。 */
  async forgetWorkspace(workspaceKey: string): Promise<void> {
    for (const page of [...this.pages.values()])
      if (page.row.workspaceKey === workspaceKey) await this.discard(page);
    this.store.deleteWorkspace(workspaceKey);
    this.thumbs.prune(new Set([...this.pages.keys()]));
    const ctx = this.ctxs.get(workspaceKey);
    this.ctxs.delete(workspaceKey);
    this.ctxPending.delete(workspaceKey);
    await ctx?.close().catch(noop);
  }

  /** 工作区上下文此刻的完整登录状态；上下文不在（没起过、崩过）返回 null。 */
  async storageState(workspaceKey: string): Promise<StorageState | null> {
    return (await this.ctxs.get(workspaceKey)?.storageState()) ?? null;
  }

  /** 此刻开着上下文的工作区键；用来把登录态补进已开着的上下文。 */
  contextKeys(): string[] {
    return [...this.ctxs.keys()];
  }

  /** 把一份登录态补进某个工作区的已存在上下文；上下文不在就什么也不做。 */
  async seedState(workspaceKey: string, state: StorageState): Promise<void> {
    await this.ctxs.get(workspaceKey)?.seed(state);
  }

  /**
   * 文件变了要刷新这个页面（agent 控制、激活中的文件页才刷）：不是这个人管、或没有真页面就什么也不做；
   * 刷新失败（页面正在关、导航中）静默丢弃。
   */
  async reloadFile(pageId: string): Promise<void> {
    const page = this.pages.get(pageId);
    if (page?.row.state !== "active") return;
    if (page.row.controller !== "agent") return;
    await page.handle?.reload().catch(noop);
  }

  /** 浏览器进程崩溃：真页面都没了，全部转休眠（沿用上一张缩略图），清空上下文表。 */
  onEngineCrash(): void {
    this.ctxs.clear();
    this.ctxPending.clear();
    for (const page of this.pages.values()) {
      page.handle = null;
      page.loading = false;
      if (page.row.state !== "active") continue;
      page.row.state = "sleeping";
      this.store.update(page.row.id, { state: "sleeping" });
      this.emitUpdated(page);
    }
  }

  /** 界面正在看这个页面；看着的页面不会被休眠。 */
  watch(id: string): () => void {
    const page = this.pages.get(id);
    if (!page) return noop;
    page.viewers += 1;
    this.emitUpdated(page);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      page.viewers = Math.max(0, page.viewers - 1);
      this.emitUpdated(page);
    };
  }

  /**
   * agent 请用户接管并等着：等待期间页面不能被休眠；用户在界面上答复（answerHandoff）
   * 或点「交还 agent」（control）时 answered 落定。等完必须调 end() 复位等待标记。
   */
  beginHandoff(
    id: string,
    reason: string,
  ): { answered: Promise<HandoffAnswer>; end(): void } {
    const page = this.need(id);
    let settle: (a: HandoffAnswer) => void = noop;
    const answered = new Promise<HandoffAnswer>((ok) => {
      settle = ok;
    });
    this.handoffs.set(id, settle);
    this.markHandoff(page, reason);
    return {
      answered,
      end: () => {
        // 已被新的等待取代（或已结束）：别动它的标记。
        if (this.handoffs.get(id) !== settle) return;
        this.handoffs.delete(id);
        this.markHandoff(page, null);
      },
    };
  }

  /** 用户答复一次等着的接管请求；没有人在等返回 false。 */
  answerHandoff(id: string, answer: HandoffAnswer): boolean {
    const settle = this.handoffs.get(id);
    if (!settle) return false;
    settle(answer);
    return true;
  }

  /** 某个工作区的弹窗日志目前的最大序号；没有是 0。 */
  popupSeq(workspaceKey: string): number {
    return this.popupLogs.get(workspaceKey)?.at(-1)?.seq ?? 0;
  }

  /** 序号大于 seq、页面仍在、且这个 actor 的根会话用过的弹窗，按序号升序。 */
  popupsSince(
    workspaceKey: string,
    actor: string,
    seq: number,
  ): { page: PageView; openerId: string | null }[] {
    const root = this.deps.rootOf(actor);
    const out: { page: PageView; openerId: string | null }[] = [];
    for (const item of this.popupLogs.get(workspaceKey) ?? []) {
      if (item.seq <= seq) continue;
      const page = this.pages.get(item.pageId);
      if (!page?.usedBy.includes(root)) continue;
      out.push({ page: this.view(page), openerId: item.openerId });
    }
    return out;
  }

  /** 用户页上的挂起下载变了（service 的待处理清单回调）：写进内存状态并通知。 */
  setPendingDownloads(pageId: string, items: PendingDownloadView[]): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    // 内容没变（比如空 → 空）不发事件：定时器与清理会反复报同一份空清单。
    if (
      page.pendingDownloads.length === items.length &&
      page.pendingDownloads.every(
        (p, i) => p.id === items[i]?.id && p.filename === items[i]?.filename,
      )
    )
      return;
    page.pendingDownloads = items.map((i) => ({ ...i }));
    this.emitUpdated(page);
  }

  /** 用户页上等用户选文件的选择器变了（service 的待处理清单回调）：写进内存状态并通知。 */
  setPendingUpload(pageId: string, item: PendingUploadView | null): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    const old = page.pendingUpload;
    // 内容没变（同 id 同 multiple，或都为 null）不发事件。
    if (
      (old === null && item === null) ||
      (old !== null &&
        item !== null &&
        old.id === item.id &&
        old.multiple === item.multiple)
    )
      return;
    page.pendingUpload = item === null ? null : { ...item };
    this.emitUpdated(page);
  }

  private markHandoff(page: Live, reason: string | null): void {
    if (page.handoffReason === reason) return;
    page.handoffPending = reason !== null;
    page.handoffReason = reason;
    this.emitUpdated(page);
  }

  subscribe(cb: (e: PageEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  thumb(id: string): Buffer | null {
    return this.thumbs.read(id);
  }

  /** 休眠：截一张缩略图留档，关掉真页面，记录保留。 */
  async sleep(id: string): Promise<void> {
    const page = this.need(id);
    await this.snooze(page);
  }

  /** 关掉所有真页面与上下文，不删记录（Server 退出时调）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // 排队中的写库要一起取消：库可能跟着关掉。
    for (const timer of this.writeTimers.values()) clearTimeout(timer);
    this.writeTimers.clear();
    for (const page of this.pages.values()) {
      page.closing = true;
      const handle = page.handle;
      page.handle = null;
      await handle?.close().catch(noop);
    }
    const ctxs = [...this.ctxs.values()];
    this.ctxs.clear();
    this.ctxPending.clear();
    for (const ctx of ctxs) await ctx.close().catch(noop);
  }

  // —— 内部 ——

  private live(row: PageRow, usedBy: string[]): Live {
    return {
      row,
      usedBy,
      inUseBy: null,
      handle: null,
      viewers: 0,
      handoffPending: false,
      handoffReason: null,
      pendingDownloads: [],
      pendingUpload: null,
      loading: false,
      waking: null,
      closing: false,
    };
  }

  private assertUsable(): void {
    if (this.disposed) throw new PageError("not_found", "浏览器已关闭。");
  }

  private need(id: string): Live {
    const page = this.pages.get(id);
    if (!page)
      throw new PageError(
        "not_found",
        `没有这个页面（${id}）：可能已被关闭，请用 browser_pages 看当前页面列表。`,
      );
    return page;
  }

  /** 动手前过操作权与认领。 */
  private checkAct(page: Live, actorRoot: string): void {
    const denied = actDenied(page.row);
    if (denied)
      throw new PageError(
        denied,
        page.row.userOpened
          ? `页面「${this.titleOf(page)}」是用户自己打开的，用户点「交给 agent」后 agent 才能动手；只读的查看（快照、截图、控制台）照常。`
          : `用户正在操作页面「${this.titleOf(page)}」，agent 不能点、不能输入、不能导航；只读的查看照常，等用户点「交还 agent」后再试。`,
      );
    if (!canClaim(page.inUseBy, actorRoot, this.deps.isBusy))
      throw new PageError(
        "busy",
        `页面「${this.titleOf(page)}」正被会话「${this.labelOf(page.inUseBy)}」使用，请稍后再试，或打开自己的页面。`,
      );
  }

  /** 数量上限：先按工作区，再按全局，把最久没用的休眠掉；挑不出就报上限。 */
  private async ensureRoom(workspaceKey: string): Promise<void> {
    await this.freeRoom(
      workspaceKey,
      this.limits.perWorkspace,
      `每个工作区最多同时激活 ${this.limits.perWorkspace} 个页面`,
    );
    await this.freeRoom(
      null,
      this.limits.global,
      `最多同时激活 ${this.limits.global} 个页面`,
    );
  }

  /** 逐个休眠直到腾出位置；受保护的页面挑不出来就报上限。 */
  private async freeRoom(
    scope: string | null,
    limit: number,
    what: string,
  ): Promise<void> {
    for (;;) {
      const pages = this.policyPages();
      const active = pages.filter(
        (p) =>
          p.state === "active" && (scope === null || p.workspaceKey === scope),
      );
      if (active.length < limit) return;
      const victim = pickSleepVictim(pages, scope);
      if (!victim)
        throw new PageError(
          "limit",
          `${what}，现在都已满，其余页面都在使用中（你正在看、待接管答复或由用户操作），没法自动休眠。请先关掉不用的页面。`,
        );
      await this.snooze(this.need(victim.id));
    }
  }

  private policyPages(): PolicyPage[] {
    return [...this.pages.values()].map((p) => ({
      id: p.row.id,
      workspaceKey: p.row.workspaceKey,
      // 以真页面在不在为准：关闭进行中的页面记录还在、handle 已摘掉，不能再当激活页面挑
      state: p.handle !== null ? ("active" as const) : ("sleeping" as const),
      controller: p.row.controller,
      userOpened: p.row.userOpened,
      lastUsedAt: Date.parse(p.row.lastUsedAt),
      viewers: p.viewers,
      handoffPending: p.handoffPending,
    }));
  }

  private async context(workspaceKey: string): Promise<BrowserCtx> {
    const existing = this.ctxs.get(workspaceKey);
    if (existing) return existing;
    const pending = this.ctxPending.get(workspaceKey);
    if (pending) return pending;
    const p = (async () => {
      try {
        const ctx = await this.deps.context(workspaceKey);
        ctx.onPopup((handle) => this.adoptPopup(workspaceKey, handle));
        this.ctxs.set(workspaceKey, ctx);
        return ctx;
      } catch (err) {
        throw new PageError(
          "context_failed",
          `没能打开工作区的浏览器上下文：${reason(err)}。浏览器可能没装好或已崩溃，稍后再试。`,
        );
      } finally {
        this.ctxPending.delete(workspaceKey);
      }
    })();
    this.ctxPending.set(workspaceKey, p);
    return p;
  }

  /** 页面内自己打开的新页面：继承来源的归属，登记成一条新记录。 */
  private adoptPopup(workspaceKey: string, handle: PageHandle): void {
    if (this.disposed) {
      void handle.close().catch(noop);
      return;
    }
    // 弹窗不走 ensureRoom（同步登记，也不该为它去休眠别的页面）：到上限直接关，免得广告页刷出无数真页面。
    const active = this.policyPages().filter((p) => p.state === "active");
    if (
      active.length >= this.limits.global ||
      active.filter((p) => p.workspaceKey === workspaceKey).length >=
        this.limits.perWorkspace
    ) {
      void handle.close().catch(noop);
      return;
    }
    const parent = [...this.pages.values()].find(
      (p) => p.handle !== null && p.handle === handle.opener,
    );
    const at = new Date(this.now()).toISOString();
    const row: PageRow = {
      id: this.newId(),
      workspaceKey,
      url: handle.url(),
      title: "",
      userOpened: parent?.row.userOpened ?? false,
      controller: parent?.row.controller ?? "agent",
      state: "active",
      epoch: parent?.row.epoch ?? 0,
      createdAt: at,
      lastUsedAt: at,
    };
    const usedBy = parent ? [...parent.usedBy] : [];
    this.store.insert(row, usedBy);
    const page: Live = {
      row,
      usedBy,
      inUseBy: parent?.inUseBy ?? null,
      handle,
      viewers: 0,
      handoffPending: false,
      handoffReason: null,
      pendingDownloads: [],
      pendingUpload: null,
      loading: handle.loading(),
      waking: null,
      closing: false,
    };
    this.pages.set(row.id, page);
    this.bind(page);
    this.recordPopup(workspaceKey, row.id, parent?.row.id ?? null);
    this.emit({ type: "added", page: this.view(page) });
  }

  /** 记一笔弹窗：序号全局递增，每个工作区只留最近 50 条。 */
  private recordPopup(
    workspaceKey: string,
    pageId: string,
    openerId: string | null,
  ): void {
    const log = this.popupLogs.get(workspaceKey) ?? [];
    log.push({ seq: ++this.popupSeqCount, pageId, openerId });
    if (log.length > POPUP_LOG_MAX) log.splice(0, log.length - POPUP_LOG_MAX);
    this.popupLogs.set(workspaceKey, log);
  }

  /** 绑页面事件：地址标题变化写库并通知；页面自己关了我们删记录。 */
  private bind(page: Live): void {
    const handle = page.handle;
    if (!handle) return;
    handle.onChange(() => {
      if (page.handle !== handle) return;
      page.row.url = handle.url();
      page.loading = handle.loading();
      this.persist(page);
      this.emitUpdated(page);
      // 标题是异步取的；变了再单独通知一次。
      void handle.title().then((t) => {
        if (page.handle !== handle || t === page.row.title) return;
        page.row.title = t;
        this.persist(page);
        this.emitUpdated(page);
      });
    });
    handle.onClose(() => {
      if (page.closing || page.handle !== handle) return;
      page.handle = null;
      this.forget(page);
    });
    handle.onDownload((d) => this.deps.onDownload(this.view(page), d));
    handle.onFileChooser((c) => this.deps.onFileChooser(this.view(page), c));
    // 对话框出现 / 消失：页面要重新推给界面（界面据此弹回答框）。
    handle.onDialog(() => {
      if (page.handle !== handle) return;
      this.emitUpdated(page);
    });
  }

  /** 合并写库：同一页面两次写库间隔不小于 WRITE_INTERVAL_MS，期间的多次变化一起写。 */
  private persist(page: Live): void {
    if (this.disposed) return;
    const id = page.row.id;
    const wait =
      (this.writtenAt.get(id) ?? Number.NEGATIVE_INFINITY) +
      WRITE_INTERVAL_MS -
      Date.now();
    if (wait <= 0) {
      this.write(id, page);
      return;
    }
    if (this.writeTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.writeTimers.delete(id);
      if (this.pages.has(id)) this.write(id, page);
    }, wait);
    timer.unref();
    this.writeTimers.set(id, timer);
  }

  private write(id: string, page: Live): void {
    this.writtenAt.set(id, Date.now());
    this.store.update(id, {
      url: page.row.url,
      title: page.row.title,
      lastUsedAt: page.row.lastUsedAt,
    });
  }

  private touch(page: Live): void {
    page.row.lastUsedAt = new Date(this.now()).toISOString();
  }

  private async wake(page: Live): Promise<PageHandle> {
    const existing = page.handle;
    if (existing) return existing;
    const pending = page.waking;
    if (pending) return pending;
    const p = (async () => {
      try {
        await this.ensureRoom(page.row.workspaceKey);
        const ctx = await this.context(page.row.workspaceKey);
        const handle = await ctx.newPage();
        // 上下文在这期间被换掉（浏览器崩过），这个页面也死在旧进程里了。
        if (this.ctxs.get(page.row.workspaceKey) !== ctx) {
          await handle.close().catch(noop);
          throw new PageError(
            "context_failed",
            "浏览器刚重启过，页面没唤醒成；再试一次就好。",
          );
        }
        page.row.state = "active";
        page.handle = handle;
        page.closing = false;
        page.loading = true;
        this.bind(page);
        this.store.update(page.row.id, {
          state: "active",
          lastUsedAt: page.row.lastUsedAt,
        });
        this.emitUpdated(page);
        // 地址可能被重定向改掉，先记下要去的地址。
        const target = page.row.url;
        try {
          await handle.goto(target);
        } catch (err) {
          page.loading = false;
          this.emitUpdated(page);
          throw new Error(
            `唤醒页面时加载「${target}」失败：${reason(err)}。页面已重新打开，可以再试一次或换个地址。`,
          );
        }
        return handle;
      } finally {
        page.waking = null;
      }
    })();
    page.waking = p;
    return p;
  }

  /** 休眠：真页面截一张缩略图留档，然后关掉它，记录与归属都保留。 */
  private async snooze(page: Live): Promise<void> {
    const handle = page.handle;
    // 已经是休眠页（或真页面刚随浏览器崩掉）：没有东西要关。
    if (!handle) return;
    if (page.row.controller === "user")
      throw new PageError(
        "user_controlling",
        `页面「${this.titleOf(page)}」正由用户手动操作，不能休眠。`,
      );
    if (page.viewers > 0)
      throw new PageError(
        "busy",
        `页面「${this.titleOf(page)}」正在被查看，关掉对应的浏览器标签后再休眠。`,
      );
    if (page.handoffPending)
      throw new PageError(
        "busy",
        `页面「${this.titleOf(page)}」正在等用户答复接管请求，不能休眠。`,
      );
    page.handle = null;
    page.closing = true;
    page.row.state = "sleeping";
    page.loading = false;
    try {
      const jpeg = await handle.screenshot();
      this.thumbs.save(page.row.id, jpeg);
    } catch {
      // 截不到就算了：列表里没有缩略图，唤醒后照常能看。
    }
    await handle.close().catch(noop);
    this.persist(page);
    this.store.update(page.row.id, { state: "sleeping" });
    this.emitUpdated(page);
    await this.dropSleeping(page.row.workspaceKey);
  }

  /** 休眠记录太多时删掉最久没用的非用户页。 */
  private async dropSleeping(workspaceKey: string): Promise<void> {
    for (;;) {
      const sleeping = this.policyPages().filter(
        (p) => p.workspaceKey === workspaceKey && p.state === "sleeping",
      );
      if (sleeping.length <= this.limits.sleepingPerWorkspace) return;
      const victim = pickSleepingToDrop(this.policyPages(), workspaceKey);
      if (!victim) return;
      const page = this.pages.get(victim.id);
      if (!page) return;
      this.forget(page);
    }
  }

  /** 关掉真页面、删记录与缩略图，通知移除。 */
  private async discard(page: Live): Promise<void> {
    const handle = page.handle;
    page.handle = null;
    page.closing = true;
    if (handle) await handle.close().catch(noop);
    this.forget(page);
  }

  private forget(page: Live): void {
    if (!this.pages.delete(page.row.id)) return;
    this.store.delete(page.row.id);
    this.thumbs.remove(page.row.id);
    this.writtenAt.delete(page.row.id);
    const timer = this.writeTimers.get(page.row.id);
    if (timer) clearTimeout(timer);
    this.writeTimers.delete(page.row.id);
    this.emit({
      type: "removed",
      id: page.row.id,
      workspaceKey: page.row.workspaceKey,
    });
  }

  private newId(): string {
    for (;;) {
      let id = "p";
      for (let i = 0; i < 5; i++)
        id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
      if (!this.pages.has(id) && !this.store.get(id)) return id;
    }
  }

  private titleOf(page: Live): string {
    return page.row.title || page.row.url;
  }

  private labelOf(sessionId: string | null): string {
    if (sessionId === null) return "无";
    return this.deps.label?.(sessionId) ?? sessionId.slice(0, 8);
  }

  private ordered(): Live[] {
    return [...this.pages.values()].sort(
      (a, b) =>
        Date.parse(b.row.lastUsedAt) - Date.parse(a.row.lastUsedAt) ||
        a.row.id.localeCompare(b.row.id),
    );
  }

  private view(page: Live): PageView {
    return {
      id: page.row.id,
      workspaceKey: page.row.workspaceKey,
      url: page.row.url,
      title: page.row.title,
      state: page.row.state,
      controller: page.row.controller,
      userOpened: page.row.userOpened,
      usedBy: [...page.usedBy],
      inUseBy: page.inUseBy,
      loading: page.handle !== null && page.loading,
      hasThumb: this.thumbs.has(page.row.id),
      epoch: page.row.epoch,
      viewers: page.viewers,
      handoffPending: page.handoffPending,
      handoffReason: page.handoffReason,
      pendingDownloads: page.pendingDownloads.map((p) => ({ ...p })),
      pendingUpload:
        page.pendingUpload === null ? null : { ...page.pendingUpload },
      dialog: page.handle?.dialog() ?? null,
      createdAt: page.row.createdAt,
      lastUsedAt: page.row.lastUsedAt,
    };
  }

  private emitUpdated(page: Live): void {
    if (!this.pages.has(page.row.id)) return;
    this.emit({ type: "updated", page: this.view(page) });
  }

  private emit(e: PageEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // 订阅者自己的问题，不能影响注册表。
      }
    }
  }
}

const noop = () => {};

/** 对话框挂着时 tool 层的拒绝文案：直接给模型看，页面文字放在引号里原样保留。 */
function dialogPendingText(dialog: PageDialog): string {
  const message =
    dialog.message.length > DIALOG_MESSAGE_MAX
      ? `${dialog.message.slice(0, DIALOG_MESSAGE_MAX)}…(+${dialog.message.length - DIALOG_MESSAGE_MAX} chars)`
      : dialog.message;
  return `页面正在等你回答一个 ${dialog.type} 对话框：「${message}」。先用 browser_dialog 回答（accept 为 true 是确定，false 是取消），其它操作要等它处理完；不回答的话 120 秒后会自动取消。`;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
