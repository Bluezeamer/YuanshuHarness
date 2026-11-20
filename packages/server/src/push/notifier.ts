import type { SessionStatus, SessionView } from "../session/library.js";
import type { SessionFeed } from "../session/session-feed.js";
import type { PushStore } from "../store/push.js";
import { buildPayload, type PushKind } from "./payload.js";
import type { PushSender, SendResult } from "./sender.js";

// 通知的触发与策略都在这里：feed 只报告「这个会话可能变了」，池只报告「一轮结束了」，
// 发不发、什么时候发、要不要补一条 resolved 由本类决定。状态全在私有成员里。

/** 会带偏好的事件；resolved 是事后补发的，不看偏好。 */
type EventKind = "blocked" | "error" | "done";

export interface NotifierDeps {
  store: PushStore;
  feed: SessionFeed;
  send: PushSender;
  log?: (message: string, err?: unknown) => void;
}

/** 待发的延迟通知：只留定时器，发什么由定时器闭包带着。 */
type Pending = ReturnType<typeof setTimeout>;

const isEventKind = (kind: PushKind): kind is EventKind =>
  kind === "blocked" || kind === "error" || kind === "done";

export class PushNotifier {
  private unsub: (() => void) | null = null;
  /** 每个会话上一次看到的 status：判「刚刚变成 blocked」与延迟触发时「事件仍然成立」都用它。 */
  private readonly status = new Map<string, SessionStatus>();
  /** `${deviceId}\0${sid}` → 待发的定时器：同一设备同一会话的新触发替换旧的。 */
  private readonly pending = new Map<string, Pending>();
  /** 已发出去的通知：sid → (deviceId → 事件类型)，用来事后补 resolved。 */
  private readonly delivered = new Map<string, Map<string, EventKind>>();

  constructor(private readonly deps: NotifierDeps) {}

  start(): void {
    if (this.unsub) return;
    this.unsub = this.deps.feed.subscribe((e) => {
      try {
        if (e.type === "session.removed") this.forget(e.data.id);
        else this.onView(e.data.session);
      } catch (err) {
        this.deps.log?.("处理列表事件失败", err);
      }
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.status.clear();
    this.delivered.clear();
  }

  /** 池里一轮结束（非子代理、非用户中止）时调；error=true 是出错结束。 */
  turnEnded(sid: string, title: string, error: boolean): void {
    this.trigger(sid, error ? "error" : "done", title);
  }

  /** 给这台设备发一条 kind=test 的通知；没订阅返回 null。 */
  async test(deviceId: string): Promise<SendResult | null> {
    const row = this.deps.store.get(deviceId);
    if (!row) return null;
    const result = await this.deps
      .send(
        { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
        buildPayload("test", "", ""),
      )
      .catch(
        (err): SendResult => ({
          ok: false,
          gone: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    this.settle(deviceId, "test", result);
    return result;
  }

  private onView(view: SessionView): void {
    const { id: sid, title } = view;
    const wasBlocked = this.status.get(sid) === "blocked";
    this.status.set(sid, view.status);
    // 归档不触发新通知，但「不再是 blocked」照样算处理过。
    if (view.status === "blocked" && !wasBlocked)
      this.trigger(sid, "blocked", title);
    this.resolve(sid, title, view.status);
  }

  /** 事后处理过：把已发出的通知替换成低调文案。 */
  private resolve(sid: string, title: string, status: SessionStatus): void {
    const entries = this.delivered.get(sid);
    if (!entries) return;
    for (const [deviceId, kind] of [...entries]) {
      const handled =
        kind === "blocked"
          ? status !== "blocked"
          : this.deps.feed.watched(sid) || status === "running";
      if (!handled) continue;
      entries.delete(deviceId);
      void this.deliver(deviceId, "resolved", sid, title);
    }
    if (entries.size === 0) this.delivered.delete(sid);
  }

  private trigger(sid: string, kind: EventKind, title: string): void {
    for (const row of this.deps.store.list()) {
      if (!row.prefs[kind]) continue;
      const policy = row.prefs.policy;
      if (policy === "always") {
        void this.deliver(row.deviceId, kind, sid, title);
      } else if (policy === "unwatched") {
        if (!this.deps.feed.watched(sid))
          void this.deliver(row.deviceId, kind, sid, title);
      } else {
        this.schedule(row.deviceId, row.prefs.delaySec, kind, sid, title);
      }
    }
  }

  // 延迟触发：定时器到点时重新判事件是否仍然成立，被处理或有人看了就不发。
  private schedule(
    deviceId: string,
    delaySec: number,
    kind: EventKind,
    sid: string,
    title: string,
  ): void {
    const key = `${deviceId}\0${sid}`;
    const old = this.pending.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      // 等待期间这类通知可能被用户关掉了
      if (!this.deps.store.get(deviceId)?.prefs[kind]) return;
      if (!this.holds(sid, kind)) return;
      void this.deliver(deviceId, kind, sid, title);
    }, delaySec * 1000);
    this.pending.set(key, timer);
  }

  private holds(sid: string, kind: EventKind): boolean {
    const status = this.status.get(sid);
    if (this.deps.feed.watched(sid)) return false;
    return kind === "blocked" ? status === "blocked" : status !== "running";
  }

  /** 发一条；成功就记下来等着补 resolved。各设备的发送互不等待、互不影响。 */
  private async deliver(
    deviceId: string,
    kind: PushKind,
    sid: string,
    title: string,
  ): Promise<void> {
    const row = this.deps.store.get(deviceId);
    if (!row) return;
    let result: SendResult;
    try {
      result = await this.deps.send(
        { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
        buildPayload(kind, sid, title),
      );
    } catch (err) {
      this.deps.log?.(`推送失败（设备 ${deviceId}）`, err);
      return;
    }
    if (result.ok && isEventKind(kind)) {
      const entries = this.delivered.get(sid) ?? new Map<string, EventKind>();
      entries.set(deviceId, kind);
      this.delivered.set(sid, entries);
    }
    this.settle(deviceId, kind, result);
  }

  /** 发送结果落地：端点没了就删订阅，其它失败只记一笔，不重试。 */
  private settle(deviceId: string, kind: PushKind, result: SendResult): void {
    if (result.ok) return;
    if (result.gone) this.deps.store.remove(deviceId);
    else
      this.deps.log?.(`推送失败（设备 ${deviceId}，${kind}）：${result.error}`);
  }

  private forget(sid: string): void {
    for (const [key, timer] of [...this.pending]) {
      if (!key.endsWith(`\0${sid}`)) continue;
      clearTimeout(timer);
      this.pending.delete(key);
    }
    this.status.delete(sid);
    this.delivered.delete(sid);
  }
}
