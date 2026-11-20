import { attachmentPaths } from "../input/attachments";
import { parseInput } from "../model/commands";
import {
  type Attachment,
  type Draft,
  emptyDraft,
  type Quote,
  type Restore,
  withQuotes,
} from "../model/draft";
import {
  draftTextOf,
  idOfDraftKey,
  loadDraftText,
  saveDraftText,
} from "./draftStorage";
import { SessionStore } from "./sessionStore";

export type SubmitResult = { ok: true } | { ok: false; message: string };

export interface HubOptions {
  token(): string | null;
  onUnauthorized(): void;
}

// 按会话的 store 注册表（引用计数）和草稿。草稿不随连接释放，切走再回来仍在；
// 同一会话的多个对话标签共用一份草稿（文本、引用 chip、附件），一边打字另一边立刻出现。
// 草稿文本另落 localStorage（draftStorage），刷新后第一次读取时取回；引用与附件只在内存。
export class ChatHub {
  private stores = new Map<string, { store: SessionStore; refs: number }>();
  private drafts = new Map<string, Draft>();
  // 文件监听：会话 → 订阅者 id → {env, paths}。发命令时按 env 取并集，
  // 因为服务端的 watch 是「整体替换」语义，两个组件各发各的会互相覆盖。
  private watches = new Map<
    string,
    Map<string, { env: string; paths: string[] }>
  >();
  // 上次真正发给服务端的并集，避免重复发同样的订阅
  private sentWatch = new Map<string, Map<string, string[]>>();
  private unwatch = new Map<string, () => void>();
  private draftListeners = new Set<() => void>();
  private seq = 0;

  constructor(private opts: HubOptions) {}

  // Provider 在令牌或回调变化时更新。
  configure(opts: HubOptions) {
    this.opts = opts;
  }

  acquire(id: string): SessionStore {
    let e = this.stores.get(id);
    if (!e) {
      const store = new SessionStore(id, {
        token: () => this.opts.token(),
        restore: (sid, back) => this.restore(sid, back),
        unauthorized: () => this.opts.onUnauthorized(),
      });
      e = { store, refs: 0 };
      this.stores.set(id, e);
      store.start();
      // 重连后服务端那边的订阅已经没了：连上就把当前并集重发一次（flushWatch 内部去重）。
      const off = store.subscribe(() => {
        if (store.getSnapshot().conn === "open") this.flushWatch(id);
      });
      this.unwatch.set(id, off);
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
    this.unwatch.get(id)?.();
    this.unwatch.delete(id);
    this.watches.delete(id);
    this.sentWatch.delete(id);
    e.store.dispose();
  }

  // 文件监听订阅：owner 是组件实例的自定义 id，paths 为空表示这个 owner 退订。
  // 内部按 env 求并集后发给服务端（服务端语义是整体替换）。
  setWatch(
    id: string,
    owner: string,
    env: string,
    paths: readonly string[],
  ): void {
    let mine = this.watches.get(id);
    if (!mine) {
      mine = new Map();
      this.watches.set(id, mine);
    }
    if (paths.length === 0) mine.delete(owner);
    else mine.set(owner, { env, paths: [...paths] });
    this.flushWatch(id);
  }

  // 底层 fs.watch 在目录被 rename / 文件被「临时文件 + rename」替换后会静默失效，
  // 数据每次刷新后重发一次订阅，等于把监听重新挂上。
  refreshWatch(id: string): void {
    this.sentWatch.delete(id);
    this.flushWatch(id);
  }

  private flushWatch(id: string): void {
    const store = this.peek(id);
    if (store?.getSnapshot().conn !== "open") return;
    const mine = this.watches.get(id);
    const union = new Map<string, string[]>();
    for (const w of mine?.values() ?? []) {
      const set = union.get(w.env) ?? [];
      for (const p of w.paths) if (!set.includes(p)) set.push(p);
      union.set(w.env, set.sort());
    }
    const sent = this.sentWatch.get(id) ?? new Map<string, string[]>();
    this.sentWatch.set(id, sent);
    // 退订：之前发过、现在没人订阅的环境要显式发空数组
    for (const env of [...sent.keys()])
      if (!union.has(env)) {
        store.watch(env, []);
        sent.delete(env);
      }
    for (const [env, paths] of union) {
      const prev = sent.get(env);
      if (
        prev &&
        prev.length === paths.length &&
        prev.every((p, i) => p === paths[i])
      )
        continue;
      if (store.watch(env, paths)) sent.set(env, paths);
      else sent.delete(env); // 发失败（连接刚断）就等下次重发
    }
  }

  // 取已有的 store（不增加引用）；没有人持有连接时为 undefined。
  peek(id: string): SessionStore | undefined {
    return this.stores.get(id)?.store;
  }

  // 测试与诊断用：某会话当前持有的连接引用数。
  refs(id: string): number {
    return this.stores.get(id)?.refs ?? 0;
  }

  // 有订阅者期间监听 storage 事件：同源的另一个浏览器标签改了草稿，这边立刻跟上。
  subscribeDrafts = (fn: () => void) => {
    if (this.draftListeners.size === 0)
      window.addEventListener("storage", this.onStorage);
    this.draftListeners.add(fn);
    return () => {
      this.draftListeners.delete(fn);
      if (this.draftListeners.size === 0)
        window.removeEventListener("storage", this.onStorage);
    };
  };

  private onStorage = (e: StorageEvent) => {
    const id = idOfDraftKey(e.key);
    if (id === null || e.storageArea !== localStorage) return;
    const cur = this.draftOf(id);
    const text = draftTextOf(e.newValue);
    if (text === cur.text) return;
    this.drafts.set(id, { ...cur, text, restored: false });
    for (const l of [...this.draftListeners]) l();
  };

  // 返回值引用稳定（只在变更时换新对象），供 useSyncExternalStore 比较。
  // 会话第一次被读取时从 localStorage 取回文本，之后以内存为准。
  draftOf = (id: string): Draft => {
    let d = this.drafts.get(id);
    if (!d) {
      const text = loadDraftText(id);
      d = text === "" ? emptyDraft : { ...emptyDraft, text };
      this.drafts.set(id, d);
    }
    return d;
  };

  private update(id: string, patch: Partial<Draft>) {
    this.drafts.set(id, { ...this.draftOf(id), ...patch });
    if (patch.text !== undefined) saveDraftText(id, patch.text);
    for (const l of [...this.draftListeners]) l();
  }

  // 会话被删除：连内存带本地存储的草稿一并丢掉。
  discardDraft(id: string) {
    this.drafts.delete(id);
    saveDraftText(id, "");
    for (const l of [...this.draftListeners]) l();
  }

  setDraft(id: string, text: string) {
    this.update(id, { text, restored: false });
  }

  // 文本：草稿为空，或仍是上次放回的原样时才写入，用户动过的草稿不覆盖；引用与附件按 id 去重补回。
  private restore(id: string, back: Restore) {
    const cur = this.draftOf(id);
    const fresh = <T extends { id: string }>(
      have: readonly T[],
      more: readonly T[],
    ) => more.filter((m) => !have.some((h) => h.id === m.id));
    const patch: Partial<Draft> = {
      quotes: [...cur.quotes, ...fresh(cur.quotes, back.quotes)],
      attachments: [
        ...cur.attachments,
        ...fresh(cur.attachments, back.attachments),
      ],
    };
    if (back.text !== "" && cur.text === "")
      Object.assign(patch, { text: back.text, restored: true });
    else if (back.text !== "" && cur.restored)
      patch.text = `${cur.text}\n${back.text}`;
    this.update(id, patch);
  }

  addQuote(id: string, quote: Quote) {
    const chip = { id: `q${++this.seq}`, quote };
    this.update(id, { quotes: [...this.draftOf(id).quotes, chip] });
  }

  removeQuote(id: string, chipId: string) {
    this.update(id, {
      quotes: this.draftOf(id).quotes.filter((c) => c.id !== chipId),
    });
  }

  // 返回新建的附件：上传链路拿 id 回写进度与结果。
  addAttachment(id: string, file: Omit<Attachment, "id">): Attachment {
    const att = { ...file, id: `a${++this.seq}` };
    this.update(id, { attachments: [...this.draftOf(id).attachments, att] });
    return att;
  }

  updateAttachment(id: string, attId: string, patch: Partial<Attachment>) {
    const list = this.draftOf(id).attachments;
    if (!list.some((a) => a.id === attId)) return;
    this.update(id, {
      attachments: list.map((a) => (a.id === attId ? { ...a, ...patch } : a)),
    });
  }

  removeAttachment(id: string, attId: string) {
    this.update(id, {
      attachments: this.draftOf(id).attachments.filter((a) => a.id !== attId),
    });
  }

  // 把文本按 parseInput 分流：/goal（设定 / edit / pause / resume / clear）、/compact 走各自命令，其余发送消息（/mcp、/reload 在输入框里先处理掉）。
  // 缺省发送草稿（连同引用与附件，发出后清空）；传 text 则只发这段文字，不动草稿。
  // 命令发出才清草稿；连接没就绪或内容不合法时原样保留。
  submit(id: string, text?: string): SubmitResult {
    const store = this.peek(id);
    if (!store) return { ok: false, message: "会话未连接" };
    const d = this.draftOf(id);
    const own = text === undefined;
    const cmd = parseInput(text ?? d.text);
    if (cmd.kind === "error") return { ok: false, message: cmd.message };
    // 界面自己的动作，由输入框处理，不该走到这里
    if (cmd.kind === "mcp" || cmd.kind === "reload")
      return { ok: false, message: `/${cmd.kind} 只能在输入框里用` };
    // 带附件的：消息，以及设置 / 修改目标（目标和消息一样可以附文件）
    const carries =
      own &&
      (cmd.kind === "message" ||
        cmd.kind === "goal" ||
        cmd.kind === "goal-edit");
    // 附件必须全部就绪才能发：上传中/失败时停下，给出可直接操作的提示。
    if (carries) {
      const bad = d.attachments.find((a) => a.status !== "ready");
      if (bad)
        return {
          ok: false,
          message:
            bad.status === "uploading"
              ? "附件还在上传，请稍候再发送"
              : `附件「${bad.name}」上传失败，请重试或移除`,
        };
    }
    const files = carries ? d.attachments : [];
    if (cmd.kind === "message" && cmd.text === "" && files.length === 0)
      return { ok: false, message: "内容为空" };
    // 失败或断线时放回草稿的内容。
    const back: Restore = {
      text: text ?? d.text,
      quotes: own && cmd.kind === "message" ? d.quotes : [],
      attachments: files,
    };
    const sent = (() => {
      switch (cmd.kind) {
        case "goal":
          return store.setGoal(cmd.text, attachmentPaths(files), back);
        case "goal-edit":
          return store.editGoal({
            text: cmd.text,
            ...(files.length ? { attachments: attachmentPaths(files) } : {}),
          });
        case "goal-control":
          return cmd.action === "pause"
            ? store.pauseGoal()
            : cmd.action === "resume"
              ? store.resumeGoal()
              : store.clearGoal();
        case "compact":
          return store.compact(back);
        default:
          return store.send(withQuotes(back.quotes, cmd.text), files, back);
      }
    })();
    if (!sent) return { ok: false, message: "连接未就绪，稍后再试" };
    // 其余斜杠命令不带引用与附件，留给下一条消息；目标命令用掉了附件，引用仍留着。
    if (own)
      this.update(
        id,
        cmd.kind === "message"
          ? emptyDraft
          : {
              text: "",
              restored: false,
              ...(carries ? { attachments: [] } : {}),
            },
      );
    return { ok: true };
  }
}
