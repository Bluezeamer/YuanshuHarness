import type { SessionView } from "./library.js";

export type FeedEvent =
  | { type: "session.added"; data: { session: SessionView } }
  | { type: "session.updated"; data: { session: SessionView } }
  | { type: "session.removed"; data: { id: string } };

export interface FeedDeps {
  // 列表里的全部顶层会话（与 GET /sessions 同一份）。
  list: () => SessionView[];
  view: (id: string) => SessionView | null;
  // 子代理 / 团队成员 / 工作流 agent 都映射到所在树的根会话：列表里只有根会话一行。
  topOf: (id: string) => string;
  // 列表里是否真有这一行（子代理会话不进列表）。
  isListed: (id: string) => boolean;
  clearMarks: (id: string) => void;
}

// 列表级事件的唯一来源：谁改了会话（池、会话库、子代理表）都只报告「这个 id 可能变了」。
// 去重靠上一次推送的 JSON，调用方不必操心重复。
export class SessionFeed {
  private readonly subscribers = new Set<(e: FeedEvent) => void>();
  // 每个顶层会话上一次推送出去的内容（有表以来一次都没推过的会话没有键）。
  private readonly sent = new Map<string, string>();
  private readonly viewers = new Map<string, Set<string>>();
  /** 全部连接「在看」的并集：判 watched 用。 */
  private readonly watchedIds = new Set<string>();

  constructor(private readonly deps: FeedDeps) {}

  subscribe(fn: (e: FeedEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  // 全量快照：顺便把这些行登记为「已推送」，之后它们的变化才按 updated / removed 发。
  snapshot(): SessionView[] {
    const views = this.deps.list();
    for (const v of views) this.sent.set(v.id, JSON.stringify(v));
    return views;
  }

  touch(id: string): void {
    const top = this.deps.topOf(id);
    if (!this.deps.isListed(top)) return;
    const view = this.deps.view(top);
    // 顶层会话已不存在：当作删除（首次见到就当作没这一行）。
    if (!view) {
      this.removed(top);
      return;
    }
    const json = JSON.stringify(view);
    const prev = this.sent.get(top);
    if (prev === json) return;
    this.sent.set(top, json);
    this.emit({
      type: prev === undefined ? "session.added" : "session.updated",
      data: { session: view },
    });
  }

  removed(id: string): void {
    const top = this.deps.topOf(id);
    // 子代理会话被删：它自己本来就没有行，列表里的根会话还在，只当那一行可能变了。
    if (top !== id) {
      this.touch(top);
      return;
    }
    if (!this.sent.delete(top)) return;
    this.emit({ type: "session.removed", data: { id: top } });
  }

  // 整份替换一条连接的「在看」集合；新进入的会话看过即清标记，视图随之变化要推出去。
  setViewing(connectionId: string, sessionIds: readonly string[]): void {
    this.viewers.set(connectionId, new Set(sessionIds));
    this.recomputeWatched();
  }

  dropViewer(connectionId: string): void {
    if (this.viewers.delete(connectionId)) this.recomputeWatched();
  }

  watched(id: string): boolean {
    return this.watchedIds.has(id);
  }

  private recomputeWatched(): void {
    const next = new Set<string>();
    for (const ids of this.viewers.values()) for (const id of ids) next.add(id);
    const entered = [...next].filter((id) => !this.watchedIds.has(id));
    this.watchedIds.clear();
    for (const id of next) this.watchedIds.add(id);
    for (const id of entered) {
      this.deps.clearMarks(id);
      this.touch(id);
    }
  }

  private emit(e: FeedEvent): void {
    for (const fn of this.subscribers)
      try {
        fn(e);
      } catch {
        // 单个订阅者（一条连接）不可用不影响别的连接。
      }
  }
}
