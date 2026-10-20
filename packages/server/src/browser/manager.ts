// 侧边浏览器的会话管理（ADR-0081）：一个 Chromium 进程，每个会话至多一个隔离的浏览上下文。
// 工具调用与 WebUI 旁观共用同一个页面：用户看到的就是 agent 正在看的。
import { launchChromium } from "./chromium.js";
import type { BrowserDriver, Launcher, PageDriver } from "./driver.js";
import { originOf, parseHttpUrl } from "./guard.js";
import { findBrowser, INSTALL_HINT } from "./locate.js";

export type BrowserErrorCode =
  | "unavailable"
  | "launch_failed"
  | "bad_url"
  | "no_page";

// message 直接给模型和用户看。
export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BrowserState {
  available: boolean;
  hint: string | null;
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
}

export interface BrowserSubscriber {
  state(s: BrowserState): void;
  frame(jpeg: Buffer): void;
}

export interface BrowserOptions {
  launch?: Launcher;
  locate?: () => string | null;
  /** 工具无操作多久后回收该会话的页面。 */
  idleMs?: number;
  /** 最后一个页面关闭后，浏览器进程再留多久。 */
  lingerMs?: number;
}

export const IDLE_MS = 10 * 60_000;
export const LINGER_MS = 60_000;
const STATE_DEBOUNCE_MS = 30;

type NavAllowed = (url: string) => boolean;

interface Slot {
  page: PageDriver;
  nav: { allowed: NavAllowed };
  idle: NodeJS.Timeout | null;
  push: NodeJS.Timeout | null;
  title: string;
  frame: Buffer | null;
  streaming: boolean;
}

const noop = () => {};
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class BrowserManager {
  private readonly locate: () => string | null;
  private readonly launch: Launcher;
  private readonly idleMs: number;
  private readonly lingerMs: number;

  private driver: Promise<BrowserDriver> | null = null;
  private live: BrowserDriver | null = null;
  private linger: NodeJS.Timeout | null = null;
  private closed = false;

  private readonly slots = new Map<string, Slot>();
  private readonly creating = new Map<string, Promise<Slot>>();
  private readonly approvedOrigins = new Map<string, Set<string>>();
  private readonly subs = new Map<string, Set<BrowserSubscriber>>();

  constructor(opts: BrowserOptions = {}) {
    this.locate = opts.locate ?? (() => findBrowser());
    this.launch = opts.launch ?? launchChromium(this.locate);
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.lingerMs = opts.lingerMs ?? LINGER_MS;
  }

  // ---- 审批记录（只在内存，Server 重启后重新审批） ----

  approve(sessionId: string, url: string): void {
    const o = originOf(url);
    if (!o) return;
    let set = this.approvedOrigins.get(sessionId);
    if (!set) {
      set = new Set();
      this.approvedOrigins.set(sessionId, set);
    }
    set.add(o);
  }

  isApproved(sessionId: string, url: string): boolean {
    const o = originOf(url);
    return o !== null && !!this.approvedOrigins.get(sessionId)?.has(o);
  }

  // ---- 状态与旁观 ----

  state(sessionId: string): BrowserState {
    const available = this.locate() !== null;
    const base = { available, hint: available ? null : INSTALL_HINT };
    const slot = this.slots.get(sessionId);
    if (!slot)
      return { ...base, active: false, url: "", title: "", loading: false };
    return {
      ...base,
      active: true,
      url: slot.page.url(),
      title: slot.title,
      loading: slot.page.loading(),
    };
  }

  subscribe(sessionId: string, sub: BrowserSubscriber): () => void {
    let set = this.subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.subs.set(sessionId, set);
    }
    set.add(sub);
    sub.state(this.state(sessionId));
    const frame = this.slots.get(sessionId)?.frame;
    if (frame) sub.frame(frame);
    this.sync(sessionId);
    return () => {
      set.delete(sub);
      if (set.size === 0 && this.subs.get(sessionId) === set)
        this.subs.delete(sessionId);
      this.sync(sessionId);
    };
  }

  // 有人旁观才推屏幕帧；没人看就停，省掉编码开销。
  private sync(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    const want = (this.subs.get(sessionId)?.size ?? 0) > 0;
    if (want && !slot.streaming) {
      slot.streaming = true;
      slot.page
        .startScreencast((jpeg) => {
          slot.frame = jpeg;
          for (const s of this.subs.get(sessionId) ?? [])
            try {
              s.frame(jpeg);
            } catch {}
        })
        .then(() => this.sync(sessionId))
        .catch(() => {
          slot.streaming = false;
        });
    } else if (!want && slot.streaming) {
      slot.streaming = false;
      void slot.page.stopScreencast().catch(noop);
    }
  }

  private emit(sessionId: string): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    const s = this.state(sessionId);
    for (const sub of set)
      try {
        sub.state(s);
      } catch {}
  }

  // 导航事件很密，合并后再取标题推送。
  private schedulePush(sessionId: string, slot: Slot): void {
    if (slot.push) return;
    slot.push = setTimeout(() => {
      slot.push = null;
      void slot.page
        .title()
        .catch(() => slot.title)
        .then((t) => {
          slot.title = t;
          if (this.slots.get(sessionId) === slot) this.emit(sessionId);
        });
    }, STATE_DEBOUNCE_MS);
    slot.push.unref();
  }

  // ---- 工具操作 ----

  async open(
    sessionId: string,
    rawUrl: string,
    navAllowed: NavAllowed,
  ): Promise<string> {
    const u = parseHttpUrl(rawUrl);
    if (!u) throw new BrowserError("bad_url", "只能打开 http 或 https 地址");
    const slot = await this.slotFor(sessionId, navAllowed);
    this.touch(sessionId, slot);
    const { status } = await slot.page.goto(u.href);
    const text = await slot.page.snapshot();
    this.schedulePush(sessionId, slot);
    return this.withBlocked(
      slot,
      `已打开（HTTP ${status ?? "未知"}）\n\n${text}`,
    );
  }

  async snapshot(sessionId: string): Promise<string> {
    const slot = this.need(sessionId);
    this.touch(sessionId, slot);
    return this.withBlocked(slot, await slot.page.snapshot());
  }

  async click(sessionId: string, ref: number): Promise<string> {
    const slot = this.need(sessionId);
    this.touch(sessionId, slot);
    await slot.page.click(ref);
    this.schedulePush(sessionId, slot);
    return this.withBlocked(
      slot,
      `已点击 [${ref}]\n\n${await slot.page.snapshot()}`,
    );
  }

  async type(
    sessionId: string,
    ref: number,
    text: string,
    submit: boolean,
  ): Promise<string> {
    const slot = this.need(sessionId);
    this.touch(sessionId, slot);
    await slot.page.type(ref, text, submit);
    this.schedulePush(sessionId, slot);
    return this.withBlocked(
      slot,
      `已输入到 [${ref}]${submit ? " 并回车" : ""}\n\n${await slot.page.snapshot()}`,
    );
  }

  async screenshot(
    sessionId: string,
  ): Promise<{ jpeg: Buffer; url: string; title: string }> {
    const slot = this.need(sessionId);
    this.touch(sessionId, slot);
    const jpeg = await slot.page.screenshot();
    return { jpeg, url: slot.page.url(), title: await slot.page.title() };
  }

  private need(sessionId: string): Slot {
    const slot = this.slots.get(sessionId);
    if (!slot)
      throw new BrowserError(
        "no_page",
        "还没有打开页面，请先调用 browser_open。",
      );
    return slot;
  }

  private withBlocked(slot: Slot, text: string): string {
    const b = slot.page.takeBlocked();
    return b.length === 0
      ? text
      : `${text}\n\n（已拦截跳转到未批准的站点：${b.join("、")}。要访问请对该地址调用 browser_open。）`;
  }

  // ---- 生命周期 ----

  private touch(sessionId: string, slot: Slot): void {
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = setTimeout(() => void this.release(sessionId), this.idleMs);
    slot.idle.unref();
  }

  private async slotFor(
    sessionId: string,
    navAllowed: NavAllowed,
  ): Promise<Slot> {
    const have = this.slots.get(sessionId);
    if (have) {
      have.nav.allowed = navAllowed;
      return have;
    }
    let p = this.creating.get(sessionId);
    if (!p) {
      p = this.create(sessionId, navAllowed).finally(() =>
        this.creating.delete(sessionId),
      );
      this.creating.set(sessionId, p);
    }
    return p;
  }

  private async create(
    sessionId: string,
    navAllowed: NavAllowed,
  ): Promise<Slot> {
    if (!this.locate()) throw new BrowserError("unavailable", INSTALL_HINT);
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    let driver: BrowserDriver;
    try {
      driver = await this.browser();
    } catch (e) {
      throw new BrowserError("launch_failed", `浏览器启动失败：${reason(e)}`);
    }
    const nav = { allowed: navAllowed };
    const page = await driver.newPage((url) => nav.allowed(url));
    const slot: Slot = {
      page,
      nav,
      idle: null,
      push: null,
      title: "",
      frame: null,
      streaming: false,
    };
    if (this.closed) {
      await page.close().catch(noop);
      throw new BrowserError("unavailable", "浏览器服务已关闭");
    }
    page.onChange(() => this.schedulePush(sessionId, slot));
    this.slots.set(sessionId, slot);
    this.emit(sessionId);
    this.sync(sessionId);
    return slot;
  }

  private browser(): Promise<BrowserDriver> {
    if (this.driver) return this.driver;
    const p = this.launch().then((d) => {
      this.live = d;
      d.onDisconnected(() => this.lost(d));
      return d;
    });
    this.driver = p;
    p.catch(() => {
      if (this.driver === p) this.driver = null;
    });
    return p;
  }

  // 浏览器进程意外退出：所有页面作废，旁观者收到"未开启"。
  private lost(d: BrowserDriver): void {
    if (this.live !== d) return;
    this.live = null;
    this.driver = null;
    for (const id of [...this.slots.keys()]) this.drop(id);
  }

  private drop(sessionId: string): Slot | undefined {
    const slot = this.slots.get(sessionId);
    if (!slot) return undefined;
    this.slots.delete(sessionId);
    if (slot.idle) clearTimeout(slot.idle);
    if (slot.push) clearTimeout(slot.push);
    this.emit(sessionId);
    return slot;
  }

  /** 关掉该会话的页面（空闲回收、用户点关闭）；审批记录保留。 */
  async release(sessionId: string): Promise<void> {
    const slot = this.drop(sessionId);
    if (!slot) return;
    await slot.page.close().catch(noop);
    this.maybeLinger();
  }

  /** 会话被删除：页面与审批记录一并清掉。 */
  async forget(sessionId: string): Promise<void> {
    this.approvedOrigins.delete(sessionId);
    await this.release(sessionId);
  }

  private maybeLinger(): void {
    if (this.slots.size > 0 || this.creating.size > 0 || !this.driver) return;
    if (this.linger) clearTimeout(this.linger);
    this.linger = setTimeout(() => {
      this.linger = null;
      if (this.slots.size === 0 && this.creating.size === 0)
        void this.shutdown();
    }, this.lingerMs);
    this.linger.unref();
  }

  private async shutdown(): Promise<void> {
    const d = this.driver;
    this.driver = null;
    this.live = null;
    await d?.then((x) => x.close()).catch(noop);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    const slots = [...this.slots.keys()].map((id) => this.drop(id));
    await Promise.all(slots.map((s) => s?.page.close().catch(noop)));
    await this.shutdown();
  }
}
