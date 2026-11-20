// 每页的流中枢：同一页面共用一路推流、分发状态与控制台、裁定操作窗口与输入门禁。
// 不依赖 HTTP / WebSocket：丢帧与发帧的细节在连接层（api/browser-stream.ts）。
import type { ConsoleEntry, InputEvent, PageHandle } from "../engine/types.js";
import { denyText } from "../net/proxy.js";
import type { PageRegistry } from "../pages/registry.js";
import type { PageView } from "../pages/types.js";
import {
  type ClientMessage,
  FRAME_OPTS,
  mergeInput,
  type Parsed,
  parseClientMessage,
  type StreamEvent,
} from "./protocol.js";

// 用户输入之后盯一会儿页面剪贴板：浏览器要求写本机剪贴板前「刚有过用户操作」，页面里点了分享 /
// 复制按钮之后才写的内容得趁这个窗口推给用户。
const COPY_FIRST_MS = 200; // 输入后第一次查的延迟
const COPY_POLL_MS = 250; // 之后每次查的间隔
const COPY_WATCH_MS = 2500; // 输入之后监视多久：覆盖「点击 1.5 秒后才异步写」

export interface Viewer {
  event(e: StreamEvent): void;
  frame(jpeg: Buffer): void; // 丢不丢由实现决定
}

export interface Attachment {
  /** 处理一条已解析成对象的客户端消息；任何问题都回 error 事件，不抛。 */
  handle(raw: unknown): Promise<void>;
  /** 离开：释放观看计数、操作窗口、必要时停推流；幂等。 */
  detach(): void;
}

export interface StreamHubDeps {
  registry: Pick<
    PageRegistry,
    "get" | "peek" | "subscribe" | "watch" | "noteActivity"
  >;
  /** 用户在地址栏输入的目标 → 可导航地址（接线时用 resolveTarget，默认环境按页面所属工作区定）；失败给人看的中文原因。 */
  resolveGoto(
    workspaceKey: string,
    raw: string,
  ): { ok: true; url: string } | { ok: false; error: string };
}

interface Conn {
  viewer: Viewer;
  /** 观看计数（页面不会被自动休眠）的释放函数。 */
  unwatch: () => void;
  live: boolean;
  /** 上一次发出去的 state：注册表的 updated 会重复触发，内容没变就不重发。 */
  sent: string;
}

interface Entry {
  pageId: string;
  workspaceKey: string;
  /** 按 attach 顺序：第一个是操作窗口。 */
  conns: Conn[];
  /** 当前跟随的句柄（控制台订阅跟着它）；休眠页为 null。 */
  handle: PageHandle | null;
  /** 正在推流的句柄，与 handle 分开记：有人看且页面是激活态才推。 */
  casting: PageHandle | null;
  lastFrame: Buffer | null;
  consoleOff: (() => void) | null;
  /** 已经推过（或已经由 copy 请求处理掉）的最新一次复制的 ts。 */
  copyPushed: number;
  /** 最近一次触发监视的输入时间：早于它的复制是旧账，不推。 */
  copyInputAt: number;
  /** 正在跑的剪贴板监视；输入密集时只把 until 往后延，不叠第二个计时器。 */
  copyWatch: { until: number; timer: NodeJS.Timeout } | null;
  dropped: boolean;
}

const noop = () => {};

export class StreamHub {
  private readonly deps: StreamHubDeps;
  private readonly entries = new Map<string, Entry>();
  private readonly unsubscribeRegistry: () => void;
  private disposed = false;

  constructor(deps: StreamHubDeps) {
    this.deps = deps;
    // 注册表订阅只建一份，按 pageId 分发给各个页面的条目。
    this.unsubscribeRegistry = deps.registry.subscribe((e) =>
      e.type === "removed" ? this.onRemoved(e.id) : this.onUpdated(e.page),
    );
  }

  attach(pageId: string, viewer: Viewer): Attachment | null {
    if (this.disposed) return null;
    const page = this.deps.registry.get(pageId);
    if (!page) return null;
    const entry = this.entryFor(pageId, page.workspaceKey);
    const conn: Conn = {
      viewer,
      unwatch: this.deps.registry.watch(pageId),
      live: true,
      sent: "",
    };
    entry.conns.push(conn);
    this.sync(entry);
    this.emitState(conn, entry);
    // 推流只在画面变化时出帧：新窗口加入一路已经在推的流时要补上最后一帧，否则一直空白。
    if (entry.lastFrame) viewer.frame(entry.lastFrame);

    // 同一连接的消息按到达顺序一条条处理：输入事件各自要几次 CDP 往返，并发会让后到的键盘抢在
    // 前面的鼠标按下之前（点输入框后马上打字，第一个字会丢）。
    // 例外是鼠标移动与滚轮：它们每秒几十条、每条一次往返，处理不过来就越排越长，点击会排在一长串后面；
    // 排队中还没开始的、与它紧挨着的同类输入并成一条（规则见 mergeInput）。
    let tail: Promise<void> = Promise.resolve();
    let waiting: { parsed: Parsed; run: Promise<void> } | null = null;
    let done = false;
    return {
      handle: (raw) => {
        const parsed = parseClientMessage(raw);
        const merged =
          parsed.ok && waiting?.parsed.ok
            ? mergeInput(waiting.parsed.msg, parsed.msg)
            : null;
        if (waiting && merged) {
          waiting.parsed = { ok: true, msg: merged };
          return waiting.run;
        }
        const job = { parsed, run: Promise.resolve() };
        job.run = tail.then(() => {
          if (waiting === job) waiting = null; // 开始处理了：之后的输入另起一条
          return this.onMessage(entry, conn, job.parsed);
        });
        tail = job.run.catch(noop);
        // 只有最后排进来的那条才可能被并入：别的消息排在中间时，更晚的输入不能越过它去改写前面那条
        waiting = job;
        return job.run;
      },
      detach: () => {
        if (done) return;
        done = true;
        this.removeConn(entry, conn);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRegistry();
    for (const entry of [...this.entries.values()]) this.drop(entry);
  }

  // —— 页面状态 ——

  private entryFor(pageId: string, workspaceKey: string): Entry {
    const existing = this.entries.get(pageId);
    if (existing) return existing;
    const entry: Entry = {
      pageId,
      workspaceKey,
      conns: [],
      handle: null,
      casting: null,
      lastFrame: null,
      consoleOff: null,
      copyPushed: 0,
      copyInputAt: 0,
      copyWatch: null,
      dropped: false,
    };
    this.entries.set(pageId, entry);
    this.follow(entry, this.deps.registry.peek(pageId));
    return entry;
  }

  private onUpdated(page: PageView): void {
    const entry = this.entries.get(page.id);
    if (!entry) return;
    this.sync(entry);
    this.emitStates(entry);
  }

  private onRemoved(pageId: string): void {
    const entry = this.entries.get(pageId);
    if (!entry) return;
    for (const conn of entry.conns)
      if (conn.live) conn.viewer.event({ type: "closed" });
    this.drop(entry);
  }

  /** 对齐句柄与推流：句柄换了就重新跟随；有人看且页面激活才推。 */
  private sync(entry: Entry): void {
    const handle = this.deps.registry.peek(entry.pageId);
    if (handle !== entry.handle) this.follow(entry, handle);
    if (entry.conns.length === 0 || !handle) {
      this.stopCast(entry);
      return;
    }
    if (entry.casting !== handle) this.startCast(entry, handle);
  }

  /** 跟随新句柄：控制台订阅跟着换，旧帧作废（换句柄意味着画面全变了）。 */
  private follow(entry: Entry, handle: PageHandle | null): void {
    this.stopCast(entry);
    entry.consoleOff?.();
    entry.consoleOff = null;
    entry.handle = handle;
    if (!handle) return;
    entry.consoleOff = handle.onConsole((e: ConsoleEntry) =>
      this.broadcast(entry, { type: "console", entry: e }),
    );
  }

  private startCast(entry: Entry, handle: PageHandle): void {
    entry.lastFrame = null;
    entry.casting = handle;
    void handle
      .startScreencast(FRAME_OPTS, (jpeg) => {
        // 换句柄后旧推流可能还有一帧在途：只认当前这一路。
        if (entry.casting !== handle) return;
        entry.lastFrame = jpeg;
        for (const conn of entry.conns) if (conn.live) conn.viewer.frame(jpeg);
      })
      .catch((err: unknown) => {
        // 启动期间页面被关、句柄被换掉的失败不算：那些由 closed / state 事件交代。
        if (entry.casting !== handle) return;
        this.broadcast(entry, {
          type: "error",
          message: `画面流没能启动：${firstLine(err)}`,
        });
      });
  }

  /** 停推流：lastFrame 一并清掉，免得之后有人加入时补发过期的帧。 */
  private stopCast(entry: Entry): void {
    const handle = entry.casting;
    entry.casting = null;
    entry.lastFrame = null;
    if (handle) void handle.stopScreencast().catch(noop);
  }

  private removeConn(entry: Entry, conn: Conn): void {
    // 先摘出连接再放观看计数：取消观看会让观众数变化、注册表发一次 updated，
    // 各连接的新状态（操作窗口可能顺位给了下一个）在那次里统一播出去。
    const at = entry.conns.indexOf(conn);
    if (at >= 0) entry.conns.splice(at, 1);
    this.release(conn);
    if (entry.conns.length === 0) this.drop(entry);
  }

  /** 放掉一个连接：观看计数与「还在」的标记一起清，重复调不会重复释放。 */
  private release(conn: Conn): void {
    if (!conn.live) return;
    conn.live = false;
    conn.unwatch();
  }

  /** 清掉一个页面条目：停推流、摘订阅、放掉观看计数。幂等。 */
  private drop(entry: Entry): void {
    if (entry.dropped) return;
    entry.dropped = true;
    this.entries.delete(entry.pageId);
    this.follow(entry, null);
    if (entry.copyWatch) {
      clearTimeout(entry.copyWatch.timer);
      entry.copyWatch = null;
    }
    for (const conn of entry.conns) this.release(conn);
    entry.conns = [];
  }

  // —— 客户端消息 ——

  private async onMessage(
    entry: Entry,
    conn: Conn,
    parsed: Parsed,
  ): Promise<void> {
    if (entry.dropped || !conn.live) return;
    if (!parsed.ok) {
      this.error(conn, parsed.error);
      return;
    }
    const msg = parsed.msg;
    // take 就是用来抢窗口的，不过门禁；页面没了就没什么可抢的。
    if (msg.type === "take") {
      if (!this.deps.registry.get(entry.pageId)) {
        this.error(conn, "页面已关闭");
        return;
      }
      if (entry.conns[0] !== conn) {
        entry.conns = [conn, ...entry.conns.filter((c) => c !== conn)];
        this.emitStates(entry);
      }
      return;
    }

    const handle = this.gate(entry, conn);
    if (!handle) return;
    let acted: boolean;
    try {
      if (msg.type === "copy") {
        // 只回给发起的窗口；复制不动页面，不算「用过」
        conn.viewer.event({ type: "copied", text: await handle.selection() });
        // 用户真按 Ctrl+C 时注入脚本也记了这次复制：抬到它上面，同一个复制不会再当 clipboard 推一遍。
        const c = await handle.copied().catch(() => null);
        if (c && c.ts > entry.copyPushed) entry.copyPushed = c.ts;
        return;
      }
      if (msg.type === "input") {
        // 输入「开始」的时间：点击的处理函数在派发期间就写了剪贴板，等 input 返回再记就把这次复制当成旧的了。
        const inputAt = Date.now();
        await handle.input(msg.event);
        acted = true;
        if (mayCopy(msg.event)) this.watchCopy(entry, inputAt);
      } else {
        acted = await this.navigate(entry, conn, handle, msg);
      }
    } catch (err) {
      this.error(conn, firstLine(err));
      return;
    }
    // 被网关 / 代理拒掉的导航不算「用过页面」，别让它顶掉真正最近用过的那个。
    if (acted) this.deps.registry.noteActivity(entry.pageId);
  }

  /** 输入门禁：页面在、是激活态、由用户操作、且发送者是操作窗口。不通过时已回 error。 */
  private gate(entry: Entry, conn: Conn): PageHandle | null {
    const page = this.deps.registry.get(entry.pageId);
    if (!page) {
      this.error(conn, "页面已关闭");
      return null;
    }
    const handle = this.deps.registry.peek(entry.pageId);
    if (!handle) {
      this.error(conn, "页面已休眠，请先唤醒");
      return null;
    }
    if (page.controller !== "user") {
      this.error(conn, "页面当前由 agent 操作；点「手动操作」后才能输入");
      return null;
    }
    if (entry.conns[0] !== conn) {
      this.error(conn, "另一个窗口正在操作这个页面；点「接管操作」后再试");
      return null;
    }
    return handle;
  }

  /**
   * 输入之后盯住页面剪贴板：页面自己写的复制（分享 / 复制按钮）趁「刚有用户操作」推给操作窗口。
   * 后台跑，不阻塞输入队列；已经在看就只把窗口往后延、更新「新鲜」的起点。
   */
  private watchCopy(entry: Entry, inputAt: number): void {
    entry.copyInputAt = inputAt;
    const until = Date.now() + COPY_WATCH_MS;
    const running = entry.copyWatch;
    if (running) {
      running.until = until;
      return;
    }
    // 每轮查完再排下一轮（setTimeout 链）：drop 清掉手上的计时器，链就断了。
    const schedule = (delay: number): NodeJS.Timeout => {
      const timer = setTimeout(() => {
        void this.checkCopy(entry)
          .catch(noop)
          .then(() => {
            const watch = entry.copyWatch;
            if (watch === null) return; // drop 已经清掉了
            if (Date.now() >= watch.until) {
              entry.copyWatch = null;
              return;
            }
            watch.timer = schedule(COPY_POLL_MS);
          });
      }, delay);
      timer.unref();
      return timer;
    };
    entry.copyWatch = { until, timer: schedule(COPY_FIRST_MS) };
  }

  /** 查一轮页面剪贴板：这次输入之后发生、还没推过的复制只发给操作窗口（别的窗口不该动用户的剪贴板）。 */
  private async checkCopy(entry: Entry): Promise<void> {
    // 现取最新句柄：页面在监视期间休眠 / 关掉就没有句柄，这一轮跳过（监视窗口很短，到点自己结束）。
    const handle = this.deps.registry.peek(entry.pageId);
    if (!handle) return;
    // 读失败当作这一轮没有（页面正在导航、frame 已分离之类）。
    const c = await handle.copied().catch(() => null);
    if (!c || c.ts <= entry.copyPushed || c.ts < entry.copyInputAt) return;
    entry.copyPushed = c.ts;
    entry.conns[0]?.viewer.event({ type: "clipboard", text: c.text });
  }

  /** 执行一条导航；返回是否真的动过页面（被拒的 goto 返回 false）。 */
  private async navigate(
    entry: Entry,
    conn: Conn,
    handle: PageHandle,
    msg: Extract<ClientMessage, { type: "nav" }>,
  ): Promise<boolean> {
    if (msg.action !== "goto") {
      if (msg.action === "back") await handle.back();
      else if (msg.action === "forward") await handle.forward();
      else await handle.reload();
      return true;
    }
    const resolved = this.deps.resolveGoto(entry.workspaceKey, msg.target);
    if (!resolved.ok) {
      this.error(conn, resolved.error);
      return false;
    }
    const res = await handle.goto(resolved.url);
    if (res.deny === null) return true;
    // deny 是这次导航被拒的原因：回给发起的人，其余窗口靠地址变化看到结果。
    this.error(conn, denyText(res.deny));
    return false;
  }

  // —— 发送 ——

  private error(conn: Conn, message: string): void {
    if (!conn.live) return;
    conn.viewer.event({ type: "error", message });
  }

  private broadcast(entry: Entry, e: StreamEvent): void {
    for (const conn of entry.conns) if (conn.live) conn.viewer.event(e);
  }

  private emitStates(entry: Entry): void {
    for (const conn of entry.conns) this.emitState(conn, entry);
  }

  private emitState(conn: Conn, entry: Entry): void {
    if (!conn.live) return;
    const page = this.deps.registry.get(entry.pageId);
    // 页面刚被关：closed 由 removed 事件负责，这里没有可发的状态。
    if (!page) return;
    const operator = entry.conns[0] === conn;
    const sent = JSON.stringify({ page, operator });
    if (sent === conn.sent) return;
    conn.sent = sent;
    conn.viewer.event({ type: "state", page, operator });
  }
}

/** 这次输入有没有可能让页面自己写剪贴板：只有鼠标抬起与按键抬起；移动、滚轮、按下、文字插入都不会。 */
function mayCopy(ev: InputEvent): boolean {
  if (ev.type === "mouse" || ev.type === "key") return ev.action === "up";
  return false;
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0] ?? msg;
}
