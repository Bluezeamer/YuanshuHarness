import {
  type ChatEntry,
  type Failure,
  listMessages,
  listSessions,
  loadToken,
} from "../api";
import { type ConvState, type Frame, initial, reduce } from "../conversation";
import { afterEarlier, afterTail, type Loaded, loadOlder } from "../history";
import { Stream, streamUrl } from "../stream";

export type Conn = "connecting" | "open" | "reconnecting" | "closed";

const RETRY_MS = 3000;
const MAX_FAILURES = 5;
const none: Loaded = { older: [], nextBefore: null };

export interface SessionSnapshot {
  state: ConvState;
  conn: Conn;
  loaded: Loaded;
  historyLoading: boolean;
  historyFailed: boolean;
  loadingEarlier: boolean;
  earlierFailed: boolean;
  notice: string | null;
  stopPending: boolean;
  // 正在等回执的弹窗答复，及最近一次失败的提示（按弹窗）。
  answering: string | null;
  promptError: { promptId: string; message: string } | null;
}

export const initialSnapshot: SessionSnapshot = {
  state: initial,
  conn: "connecting",
  loaded: none,
  historyLoading: false,
  historyFailed: false,
  loadingEarlier: false,
  earlierFailed: false,
  notice: null,
  stopPending: false,
  answering: null,
  promptError: null,
};

const PROMPT_ERRORS: Record<string, string> = {
  prompt_resolved: "已被其他端答复、超时或撤销",
  prompt_unknown: "这个提问已不存在",
  bad_request: "答复无效，请检查后重试",
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
  restoreDraft(sessionId: string, text: string): void;
  unauthorized(): void;
}

// 一个会话一份：一条连接、一份对话状态与历史。开几个 pane 都订阅同一个实例（R12）。
export class SessionStore {
  private snap: SessionSnapshot = initialSnapshot;
  private listeners = new Set<() => void>();
  private stream: Stream | null = null;
  private pending = new Map<string, "send" | "stop" | "answer">();
  private answers = new Map<string, string>();
  private lastSent = new Map<string, string>();
  private alive = false;
  private failures = 0;
  private syncs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Stream | null = null;

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
    this.set({ state: reduce(this.snap.state, frame) });
  }

  start() {
    this.alive = true;
    this.open();
  }

  dispose() {
    this.alive = false;
    clearTimeout(this.timer);
    this.settleCommands();
    this.current?.close();
    if (this.stream === this.current) this.stream = null;
    this.current = null;
  }

  // 连接断开时没拿到回执的命令不会再有回执：发送的原文放回输入框，停止恢复可点。
  private settleCommands() {
    const unsent: string[] = [];
    for (const [id, kind] of this.pending) {
      const text = this.lastSent.get(id);
      if (kind === "send" && text !== undefined) unsent.push(text);
    }
    if (unsent.length) this.host.restoreDraft(this.id, unsent.join("\n"));
    this.pending.clear();
    this.lastSent.clear();
    this.answers.clear();
    if (this.snap.stopPending || this.snap.answering)
      this.set({ stopPending: false, answering: null });
  }

  private sync(startIndex: number) {
    const run = ++this.syncs;
    this.set({ historyLoading: true });
    void loadOlder(() => listMessages(this.id, loadToken()), startIndex).then(
      (r) => {
        if (!this.alive || run !== this.syncs) return;
        this.set({
          historyLoading: false,
          historyFailed: !r.ok,
          loaded: r.ok ? afterTail(this.snap.loaded, r) : none,
        });
      },
    );
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
    const r = await listSessions(loadToken());
    if (!this.alive) return;
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

  private open() {
    let gotSnapshot = false;
    const s: Stream = new Stream(streamUrl(this.id), loadToken(), {
      onFrame: (frame) => {
        if (!this.alive || this.current !== s) return;
        this.dispatch(frame);
        if (frame.type === "snapshot") {
          this.failures = 0;
          const clear = !gotSnapshot ? { notice: null } : {};
          gotSnapshot = true;
          this.set({ conn: "open", ...clear });
          const start = frame.data.startIndex;
          if (typeof start === "number" && start >= 0) this.sync(start);
          else {
            this.syncs += 1;
            this.set({
              historyLoading: false,
              historyFailed: true,
              loaded: none,
            });
          }
        }
        if (frame.type === "run.ended") this.set({ stopPending: false });
      },
      onAck: (ack) => {
        if (!this.alive || !ack.id) return;
        const kind = this.pending.get(ack.id);
        const text = this.lastSent.get(ack.id);
        const promptId = this.answers.get(ack.id);
        this.pending.delete(ack.id);
        this.lastSent.delete(ack.id);
        this.answers.delete(ack.id);
        if (kind === "stop") this.set({ stopPending: false });
        if (kind === "answer") {
          this.set({ answering: null });
          if (!ack.ok && promptId) {
            const message =
              PROMPT_ERRORS[ack.error?.code ?? ""] ??
              ack.error?.message ??
              "答复失败";
            this.set({ promptError: { promptId, message } });
          }
          return;
        }
        if (ack.ok) return;
        this.set({ notice: ack.error?.message ?? "命令失败" });
        if (kind === "send" && text !== undefined)
          this.host.restoreDraft(this.id, text);
      },
      onClose: () => {
        if (!this.alive || this.current !== s) return;
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

  send = (text: string): boolean => {
    const body = text.trim();
    if (!body) return false;
    const id = this.stream?.command("send_message", { text: body });
    if (!id) return false;
    this.pending.set(id, "send");
    this.lastSent.set(id, text);
    this.set({ notice: null });
    return true;
  };

  stop = () => {
    const id = this.stream?.command("stop");
    if (!id) return;
    this.pending.set(id, "stop");
    this.set({ stopPending: true, notice: null });
  };

  // choice 传 optionId，input 传 text。成功与否以 prompt.resolved 为准，这里只管发出与失败提示。
  answerPrompt = (
    promptId: string,
    answer: { optionId: string } | { text: string },
  ): boolean => {
    if (this.snap.answering) return false;
    const id = this.stream?.command("answer_prompt", { promptId, ...answer });
    if (!id) return false;
    this.pending.set(id, "answer");
    this.answers.set(id, promptId);
    this.set({ answering: promptId, promptError: null });
    return true;
  };

  reconnect = () => {
    if (!this.alive) return;
    clearTimeout(this.timer);
    this.failures = 0;
    this.set({ notice: null, conn: "reconnecting" });
    void this.attempt();
  };

  loadEarlier = () => {
    const cursor = this.snap.loaded.nextBefore;
    if (cursor === null || this.snap.loadingEarlier) return;
    this.set({ loadingEarlier: true, earlierFailed: false });
    void listMessages(this.id, loadToken(), cursor).then((r) => {
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

export type { ChatEntry };
