import { SessionStore } from "./store";

export interface Draft {
  text: string;
  restored: boolean;
}

const empty: Draft = { text: "", restored: false };

// 按会话的 store 注册表（引用计数）和草稿。草稿不随连接释放，切走再回来仍在（conversation R14）。
export class SessionHub {
  private stores = new Map<string, { store: SessionStore; refs: number }>();
  private drafts = new Map<string, Draft>();
  private draftListeners = new Set<() => void>();
  onUnauthorized: () => void = () => {};

  acquire(id: string): SessionStore {
    let e = this.stores.get(id);
    if (!e) {
      const store = new SessionStore(id, {
        restoreDraft: (sid, text) => this.restoreDraft(sid, text),
        unauthorized: () => this.onUnauthorized(),
      });
      e = { store, refs: 0 };
      this.stores.set(id, e);
      store.start();
    }
    e.refs += 1;
    return e.store;
  }

  release(id: string) {
    const e = this.stores.get(id);
    if (!e) return;
    e.refs -= 1;
    if (e.refs > 0) return;
    this.stores.delete(id);
    e.store.dispose();
  }

  // 测试与诊断用：某会话当前持有的连接引用数。
  refs(id: string): number {
    return this.stores.get(id)?.refs ?? 0;
  }

  subscribeDrafts = (fn: () => void) => {
    this.draftListeners.add(fn);
    return () => this.draftListeners.delete(fn);
  };

  private emit() {
    for (const l of [...this.draftListeners]) l();
  }

  draft(id: string): string {
    return (this.drafts.get(id) ?? empty).text;
  }

  setDraft(id: string, text: string) {
    this.drafts.set(id, { text, restored: false });
    this.emit();
  }

  // 草稿为空，或仍是上次放回的原样时才写入；用户动过的草稿不覆盖。
  restoreDraft(id: string, text: string) {
    const cur = this.drafts.get(id);
    if (!cur || cur.text === "")
      this.drafts.set(id, { text, restored: true });
    else if (cur.restored)
      this.drafts.set(id, { text: `${cur.text}\n${text}`, restored: true });
    else return;
    this.emit();
  }
}
