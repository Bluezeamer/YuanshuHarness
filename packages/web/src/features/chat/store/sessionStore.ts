import {
  afterEarlier,
  afterTail,
  type CallTokens,
  createProbe,
  type EditableContent,
  type Failure,
  getUsage,
  type Loaded,
  listCalls,
  listMessages,
  listSessions,
  loadOlder,
  onForeground,
  parseEditable,
  Stream,
  streamUrl,
} from "../../../api";
import { toast } from "../../../ui";
import {
  type AnswerBody,
  type ConvState,
  type Frame,
  initial,
  reduce,
  USAGE_LOADED,
} from "../model/conversation";
import type { Attachment, Restore } from "../model/draft";
import { toastOf } from "../model/extensionUi";

/** 改目标：文本、轮数上限（null = 不限）、附件至少给一项 */
export interface GoalPatch {
  text?: string;
  maxRounds?: number | null;
  attachments?: { path: string }[];
}

export type Conn = "connecting" | "open" | "reconnecting" | "closed";

const RETRY_MS = 3000;
const MAX_FAILURES = 5;
const none: Loaded = {
  older: [],
  nextBefore: null,
  compactions: [],
  notices: [],
};

// 命令被服务端拒绝（ack 非 ok）时的错误；command 是 WS 命令名，message 是可直接展示的中文说明。
export interface ChatError {
  command: string;
  code: string;
  message: string;
}

export interface SessionSnapshot extends ConvState {
  conn: Conn;
  loaded: Loaded;
  historyLoading: boolean;
  historyFailed: boolean;
  loadingEarlier: boolean;
  earlierFailed: boolean;
  // 连接层提示（来源不被允许、限流、协议错误）；命令失败走 lastError。
  notice: string | null;
  stopPending: boolean;
  // compact 已被受理、结果（context.compacted / compact_failed）还没到。
  compacting: boolean;
  lastError: ChatError | null;
  // 正在等回执的弹窗答复，及最近一次失败的提示（按弹窗）。
  answering: string | null;
  promptError: { promptId: string; message: string } | null;
  // 最近一次模型调用的 token 拆分，供上下文构成按比例摊算。
  lastCall: CallTokens | null;
}

export const initialSnapshot: SessionSnapshot = {
  ...initial,
  conn: "connecting",
  loaded: none,
  historyLoading: false,
  historyFailed: false,
  loadingEarlier: false,
  earlierFailed: false,
  notice: null,
  stopPending: false,
  compacting: false,
  lastError: null,
  answering: null,
  promptError: null,
  lastCall: null,
};

const PROMPT_ERRORS: Record<string, string> = {
  prompt_resolved: "已被其他端答复、超时或撤销",
  prompt_unknown: "这个提问已不存在",
  bad_request: "答复无效，请检查后重试",
};

// 服务端没带 message 时的兜底说明。
const ERROR_TEXT: Record<string, string> = {
  bad_request: "请求无效，请检查后重试",
  no_goal: "当前没有长期目标",
  session_running: "会话正在运行或压缩中，稍后再试",
};

// 这两种探测结果说明继续握手没有意义，要停下来等人处理。
const stopReason = (f: Failure): string | null =>
  f.kind === "forbidden"
    ? "当前来源不被允许"
    : f.kind === "rate_limited"
      ? f.retryAfter
        ? `尝试过多，请 ${f.retryAfter} 秒后再试`
        : "尝试过多，请稍后再试"
      : null;

export interface Host {
  token(): string | null;
  restore(sessionId: string, back: Restore): void;
  unauthorized(): void;
}

interface Pending {
  command: string;
  // send_message：失败或断线时放回草稿的内容。
  back?: Restore;
  promptId?: string;
  // get_queue：ack 里带回完整排队内容（文字与附件）；失败或断线时收到 null。
  resolve?: (queue: EditableContent[] | null) => void;
}

// 一个会话一份：一条连接、一份对话状态与历史。开几个标签都订阅同一个实例，goal 等广播大家看到同一份。
export class SessionStore {
  private snap: SessionSnapshot = initialSnapshot;
  private listeners = new Set<() => void>();
  private stream: Stream | null = null;
  private pending = new Map<string, Pending>();
  private alive = false;
  private failures = 0;
  private syncs = 0;
  private usageRuns = 0;
  private callRuns = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Stream | null = null;
  // attempt 的世代：回前台与手动重连可能撞上一次还在等 REST 的重试，只认最新的一次。
  private attempts = 0;
  private offForeground: (() => void) | undefined;
  private readonly probe = createProbe(
    () => this.stream?.command("ping") != null,
    () => this.onDead(),
  );
  // 流式增量按帧合并：每个 token 都 set 会让整棵对话流重渲染并反复解析 Markdown。
  private pendingDeltas: Frame[] = [];
  private deltaRaf: number | null = null;

  constructor(
    readonly id: string,
    private host: Host,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): SessionSnapshot => this.snap;

  private set(p: Partial<SessionSnapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }

  private dispatch(frame: Frame) {
    const next = reduce(this.snap, frame);
    if (next !== this.snap) this.set(next);
  }

  // 只有 live 增量可以合并；结构事件（结束/工具/快照等）先冲掉待发增量再立即处理，保证顺序。
  private isLiveDelta(frame: Frame): boolean {
    if (frame.type !== "message.delta") return false;
    const kind = frame.data.kind;
    return kind === "text" || kind === "thinking" || kind === "toolarg";
  }

  private scheduleFlush() {
    if (this.deltaRaf !== null) return;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
    this.deltaRaf = raf(() => this.flushDeltas());
  }

  private flushDeltas() {
    if (this.deltaRaf !== null) {
      if (typeof cancelAnimationFrame === "function")
        cancelAnimationFrame(this.deltaRaf);
      this.deltaRaf = null;
    }
    const frames = this.pendingDeltas.splice(0);
    if (frames.length === 0) return;
    let next: ConvState = this.snap;
    for (const f of frames) next = reduce(next, f);
    if (next !== this.snap) this.set(next);
  }

  private handleFrame(frame: Frame): void {
    if (this.isLiveDelta(frame)) {
      this.pendingDeltas.push(frame);
      this.scheduleFlush();
      return;
    }
    this.flushDeltas();
    // 插件的瞬时通知：不是状态，不进对话流，只弹一条 toast（服务端不重放，重连不会重复弹）
    if (frame.type === "extension.ui") {
      const t = toastOf(frame.data);
      if (t) toast(t.message, { tone: t.tone });
      return;
    }
    this.dispatch(frame);
  }

  start() {
    this.alive = true;
    this.offForeground = onForeground(this.resume);
    this.open();
  }

  dispose() {
    this.alive = false;
    this.pendingDeltas.length = 0;
    if (this.deltaRaf !== null && typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(this.deltaRaf);
    this.deltaRaf = null;
    clearTimeout(this.timer);
    this.offForeground?.();
    this.probe.cancel();
    this.settleCommands();
    this.current?.close();
    if (this.stream === this.current) this.stream = null;
    this.current = null;
  }

  // 连接断开时没拿到回执的命令不会再有回执：发送的原文放回输入框，停止与压缩恢复可点。
  private settleCommands() {
    const backs = [...this.pending.values()].flatMap((p) => p.back ?? []);
    if (backs.length)
      this.host.restore(this.id, {
        text: backs.map((b) => b.text).join("\n"),
        quotes: backs.flatMap((b) => b.quotes),
        attachments: backs.flatMap((b) => b.attachments),
      });
    for (const p of this.pending.values()) p.resolve?.(null);
    this.pending.clear();
    if (this.snap.stopPending || this.snap.answering || this.snap.compacting)
      this.set({ stopPending: false, answering: null, compacting: false });
  }

  private sync(startIndex: number) {
    const run = ++this.syncs;
    this.set({ historyLoading: true });
    void loadOlder(
      () => listMessages(this.id, this.host.token()),
      startIndex,
    ).then((r) => {
      if (!this.alive || run !== this.syncs) return;
      this.set({
        historyLoading: false,
        historyFailed: !r.ok,
        loaded: r.ok ? afterTail(this.snap.loaded, r) : none,
      });
    });
  }

  // 最近一次模型调用的 token 拆分，供上下文构成按比例摊算；取不到只是少一块，不报错。
  private refreshLastCall() {
    const run = ++this.callRuns;
    void listCalls(this.host.token(), this.id, { limit: 1 }).then((c) => {
      if (!this.alive || run !== this.callRuns || !c.ok) return;
      this.set({ lastCall: c.data.calls[0]?.tokens ?? null });
    });
  }

  // 一轮结束后重取累计用量，用精确值覆盖 reducer 里的本地累加。
  private refreshUsage() {
    const run = ++this.usageRuns;
    void getUsage(this.host.token(), this.id).then((u) => {
      if (!this.alive || run !== this.usageRuns || !u.ok) return;
      this.dispatch({
        session: this.id,
        seq: 0,
        type: USAGE_LOADED,
        data: u.data as unknown as Record<string, unknown>,
      });
    });
  }

  private wait() {
    this.set({ conn: "reconnecting" });
    this.timer = setTimeout(() => void this.attempt(), RETRY_MS);
  }

  private fail() {
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) this.set({ conn: "closed" });
    else this.wait();
  }

  // 每次重试先用 REST 探测：令牌失效时不能反复握手，那会计入限流。
  private async attempt() {
    this.timer = undefined;
    const run = ++this.attempts;
    const r = await listSessions(this.host.token());
    if (!this.alive || run !== this.attempts) return;
    if (r.ok) return this.open();
    if (r.kind === "unauthorized") {
      this.set({ conn: "closed" });
      this.host.unauthorized();
      return;
    }
    const reason = stopReason(r);
    if (reason) {
      this.set({ notice: reason, conn: "closed" });
      return;
    }
    this.fail();
  }

  private onSnapshot(frame: Frame, first: boolean) {
    this.failures = 0;
    this.set({ conn: "open", ...(first ? { notice: null } : {}) });
    const start = frame.data.startIndex;
    if (typeof start === "number" && start >= 0) this.sync(start);
    else {
      this.syncs += 1;
      this.set({ historyLoading: false, historyFailed: true, loaded: none });
    }
    if (this.snap.usage && this.snap.usage.steps > 0) this.refreshLastCall();
  }

  private open() {
    // 上一条连接可能还在握手、没等到快照：换新之前先关掉，不然它会一直占着
    this.current?.close();
    let gotSnapshot = false;
    const s: Stream = new Stream(streamUrl(this.id), this.host.token(), {
      onFrame: (frame) => {
        if (!this.alive || this.current !== s) return;
        this.probe.settle();
        this.handleFrame(frame);
        if (frame.type === "snapshot") {
          this.onSnapshot(frame, !gotSnapshot);
          gotSnapshot = true;
        }
        if (frame.type === "run.ended") {
          this.set({ stopPending: false });
          // 有 usage 字段说明服务端开着调用记录库。
          if (this.snap.usage || frame.data.usage !== undefined) {
            this.refreshUsage();
            this.refreshLastCall();
          }
        }
        if (
          frame.type === "context.compacted" ||
          frame.type === "context.compact_failed"
        )
          this.set({ compacting: false });
      },
      onAck: (ack) => {
        if (!this.alive) return;
        this.probe.settle();
        if (!ack.id) return;
        const p = this.pending.get(ack.id);
        this.pending.delete(ack.id);
        if (p?.resolve) {
          const queue = ack.ok ? ack.data?.queue : null;
          const items = Array.isArray(queue) ? queue.map(parseEditable) : null;
          p.resolve(
            items?.every((q) => q !== null)
              ? (items as EditableContent[])
              : null,
          );
          return;
        }
        if (p?.command === "stop") this.set({ stopPending: false });
        if (p?.command === "answer_prompt") {
          this.set({ answering: null });
          if (!ack.ok && p.promptId) {
            const message =
              PROMPT_ERRORS[ack.error?.code ?? ""] ??
              ack.error?.message ??
              "答复失败";
            this.set({ promptError: { promptId: p.promptId, message } });
          }
          return;
        }
        if (ack.ok) return;
        const code = ack.error?.code ?? "unknown";
        this.set({
          ...(p?.command === "compact" ? { compacting: false } : {}),
          lastError: {
            command: p?.command ?? "unknown",
            code,
            message: ack.error?.message || ERROR_TEXT[code] || "命令失败",
          },
        });
        if (p?.back) this.host.restore(this.id, p.back);
      },
      onClose: () => {
        if (!this.alive || this.current !== s) return;
        this.probe.cancel();
        this.settleCommands();
        if (gotSnapshot) this.wait();
        else this.fail();
      },
      onProtocolError: (m) => {
        if (!this.alive || this.current !== s) return;
        this.settleCommands();
        this.set({ notice: m, conn: "closed" });
      },
    });
    this.current = s;
    this.stream = s;
  }

  // 发出一条命令；连接未就绪返回 false。
  private issue(
    command: string,
    extra: Record<string, unknown> = {},
    meta: Omit<Pending, "command"> = {},
  ): boolean {
    const id = this.stream?.command(command, extra);
    if (!id) return false;
    this.pending.set(id, { command, ...meta });
    return true;
  }

  // back 是失败或断线时放回草稿的内容，缺省为原文与附件。
  send = (
    text: string,
    files: readonly Attachment[] = [],
    back: Restore = { text, quotes: [], attachments: files },
  ): boolean => {
    const body = text.trim();
    if (!body && files.length === 0) return false;
    // 只传引用：文件内容已上传到会话附件区，附件标记行由服务端注入。
    const attachments = files.map(({ name, mimeType, size, path }) => ({
      name,
      mimeType,
      size,
      path,
    }));
    const ok = this.issue(
      "send_message",
      { text: body, ...(attachments.length ? { attachments } : {}) },
      { back },
    );
    if (ok) this.set({ notice: null, lastError: null });
    return ok;
  };

  stop = () => {
    if (this.issue("stop"))
      this.set({ stopPending: true, notice: null, lastError: null });
  };

  // 选项、文字（可带附件）任意组合，至少一样。成功与否以 prompt.resolved 为准，这里只管发出与失败提示。
  answerPrompt = (promptId: string, answer: AnswerBody): boolean => {
    if (this.snap.answering) return false;
    if (!this.issue("answer_prompt", { promptId, ...answer }, { promptId }))
      return false;
    this.set({ answering: promptId, promptError: null });
    return true;
  };

  private goalCommand(
    command: string,
    extra?: Record<string, unknown>,
    back?: Restore,
  ) {
    const ok = this.issue(command, extra, { back });
    if (ok) this.set({ lastError: null });
    return ok;
  }

  // 目标的改动由 goal.updated 广播回来，这里只管发出与失败提示。
  setGoal = (
    text: string,
    attachments: { path: string }[] = [],
    back?: Restore,
  ): boolean =>
    text.trim() !== "" &&
    this.goalCommand(
      "set_goal",
      {
        text: text.trim(),
        ...(attachments.length ? { attachments } : {}),
      },
      back,
    );
  // attachments 出现就整体替换（空数组 = 清空）；不出现就不动附件。
  editGoal = (patch: GoalPatch): boolean => {
    const text = patch.text?.trim();
    if (text === "") return false;
    return this.goalCommand("edit_goal", {
      ...(text === undefined ? {} : { text }),
      ...("maxRounds" in patch ? { maxRounds: patch.maxRounds } : {}),
      ...(patch.attachments ? { attachments: patch.attachments } : {}),
    });
  };
  pauseGoal = (): boolean => this.goalCommand("pause_goal");
  resumeGoal = (): boolean => this.goalCommand("resume_goal");
  clearGoal = (): boolean => this.goalCommand("clear_goal");

  // 受理即返回，结果由 context.compacted / context.compact_failed 告知。
  compact = (back?: Restore): boolean => {
    if (this.snap.compacting || !this.goalCommand("compact", undefined, back))
      return false;
    this.set({ compacting: true });
    return true;
  };

  // 排队消息的编辑 / 删除由服务端重排后经 queue.updated 广播回来，这里只管发出与失败提示。
  // 文字与附件整体替换；两者都为空不发。
  editQueue = (
    index: number,
    text: string,
    attachments: { path: string }[],
  ): boolean => {
    const body = text.trim();
    if (body === "" && attachments.length === 0) return false;
    const ok = this.issue("edit_queue", { index, text: body, attachments });
    if (ok) this.set({ lastError: null });
    return ok;
  };

  // 文件监听：整体替换本会话的订阅集合（空数组=退订）。连不上就返回 false，调用方稍后重试。
  watch = (env: string, paths: readonly string[]): boolean =>
    this.issue("watch", { env, paths: [...paths] });

  removeQueue = (index: number): boolean => {
    const ok = this.issue("remove_queue", { index });
    if (ok) this.set({ lastError: null });
    return ok;
  };

  // 取完整排队内容；queue.updated 里的文本为显示截断过，编辑要用全文。失败返回 null。
  queueTexts = (): Promise<EditableContent[] | null> => {
    const id = this.stream?.command("get_queue");
    if (!id) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pending.set(id, { command: "get_queue", resolve });
    });
  };

  dismissError = () => {
    if (this.snap.lastError) this.set({ lastError: null });
  };

  reconnect = () => {
    if (!this.alive) return;
    clearTimeout(this.timer);
    this.failures = 0;
    this.set({ notice: null, conn: "reconnecting" });
    void this.attempt();
  };

  // 回前台：显示开着就探一下还活不活，已断的立即重连（重连就是拿新快照）；首次连接还在路上的不打断。
  private resume = () => {
    const { conn } = this.snap;
    if (conn === "open") this.probe.start();
    else if (conn !== "connecting") this.reconnect();
  };

  // 探针没有回音：连接看着开着其实已死，不等它自己报错。
  private onDead() {
    if (!this.alive) return;
    this.current?.close();
    this.settleCommands();
    this.reconnect();
  }

  loadEarlier = () => {
    const cursor = this.snap.loaded.nextBefore;
    if (cursor === null || this.snap.loadingEarlier) return;
    this.set({ loadingEarlier: true, earlierFailed: false });
    void listMessages(this.id, this.host.token(), cursor).then((r) => {
      if (!this.alive) return;
      if (!r.ok) this.set({ loadingEarlier: false, earlierFailed: true });
      else
        this.set({
          loadingEarlier: false,
          loaded: afterEarlier(this.snap.loaded, cursor, r.data),
        });
    });
  };
}
