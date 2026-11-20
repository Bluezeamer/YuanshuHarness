import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { EditableContent } from "../../api";
import { ChatContext, useChatHubOptional } from "./context";
import type { AnswerBody } from "./model/conversation";
import type { Attachment, Draft, Quote } from "./model/draft";
import { computeMetrics, type MetricsView } from "./model/metrics";
import type { ChatHub, SubmitResult } from "./store/hub";
import {
  type GoalPatch,
  initialSnapshot,
  type SessionSnapshot,
  type SessionStore,
} from "./store/sessionStore";

export function useChatHub(): ChatHub {
  const hub = useContext(ChatContext);
  if (!hub) throw new Error("useChatHub 需要放在 <ChatProvider> 里");
  return hub;
}

export interface ChatActions {
  /** 发送：缺省发草稿（含引用与附件，发出后清空），传 text 只发这段文字。/goal、/compact 走各自命令。 */
  send(text?: string): SubmitResult;
  stop(): void;
  answerPrompt(promptId: string, answer: AnswerBody): boolean;
  setGoal(text: string): boolean;
  editGoal(patch: GoalPatch): boolean;
  pauseGoal(): boolean;
  resumeGoal(): boolean;
  clearGoal(): boolean;
  compact(): boolean;
  loadEarlier(): void;
  /** 编辑 / 删除排队中的消息；index 是 state.queue 的顺序，结果由服务端 queue.updated 广播回来。 */
  editQueue(
    index: number,
    text: string,
    attachments: { path: string }[],
  ): boolean;
  removeQueue(index: number): boolean;
  /** 取完整排队文本（显示文本被截断过）；失败返回 null。 */
  queueTexts(): Promise<EditableContent[] | null>;
  /** 文件监听：整体替换本会话订阅的路径（空数组=退订） */
  watch(env: string, paths: readonly string[]): boolean;
  reconnect(): void;
  dismissError(): void;
  setDraft(text: string): void;
  addQuote(quote: Quote): void;
  removeQuote(chipId: string): void;
  addAttachment(file: Omit<Attachment, "id">): Attachment;
  updateAttachment(attachmentId: string, patch: Partial<Attachment>): void;
  removeAttachment(attachmentId: string): void;
}

export interface ChatSession {
  state: SessionSnapshot;
  actions: ChatActions;
  metrics: MetricsView;
  draft: Draft;
}

function makeActions(hub: ChatHub, id: string): ChatActions {
  const store = <T>(f: (s: SessionStore) => T, none: T): T => {
    const s = hub.peek(id);
    return s ? f(s) : none;
  };
  return {
    send: (text) => hub.submit(id, text),
    stop: () => store((s) => s.stop(), undefined),
    answerPrompt: (p, a) => store((s) => s.answerPrompt(p, a), false),
    setGoal: (t) => store((s) => s.setGoal(t), false),
    editGoal: (p) => store((s) => s.editGoal(p), false),
    pauseGoal: () => store((s) => s.pauseGoal(), false),
    resumeGoal: () => store((s) => s.resumeGoal(), false),
    clearGoal: () => store((s) => s.clearGoal(), false),
    compact: () => store((s) => s.compact(), false),
    loadEarlier: () => store((s) => s.loadEarlier(), undefined),
    editQueue: (i, t, a) => store((s) => s.editQueue(i, t, a), false),
    removeQueue: (i) => store((s) => s.removeQueue(i), false),
    queueTexts: () => store((s) => s.queueTexts(), Promise.resolve(null)),
    watch: (env, paths) => store((s) => s.watch(env, paths), false),
    reconnect: () => store((s) => s.reconnect(), undefined),
    dismissError: () => store((s) => s.dismissError(), undefined),
    setDraft: (t) => hub.setDraft(id, t),
    addQuote: (q) => hub.addQuote(id, q),
    removeQuote: (c) => hub.removeQuote(id, c),
    addAttachment: (f) => hub.addAttachment(id, f),
    updateAttachment: (a, patch) => hub.updateAttachment(id, a, patch),
    removeAttachment: (a) => hub.removeAttachment(id, a),
  };
}

const noSub = () => () => {};
const initial = () => initialSnapshot;

/**
 * 往某个会话的输入草稿里加一条引用（划选提问：发送时拼成「Quote 来源 + 围栏块」，agent 看得到内容与出处）。
 * 没有 ChatProvider（独立渲染）时是 null。
 */
export function useAddQuote():
  | ((sessionId: string, quote: Quote) => void)
  | null {
  const hub = useChatHubOptional();
  return useMemo(() => (hub ? (id, q) => hub.addQuote(id, q) : null), [hub]);
}

let watchSeq = 0;

/**
 * 文件变更订阅（有限感知刷新）：把「当前展开的目录 / 打开的预览文件」报给服务端，
 * 变化时服务端推 fs.changed，返回值是这台环境的版本号——变了就重取。
 * 组件卸载会退订；同一会话多个组件订阅同一环境时由 hub 取并集再发。
 */
export function useFsWatch(
  sessionId: string | undefined,
  env: string,
  paths: readonly string[],
): number {
  const hub = useChatHubOptional();
  const [store, setStore] = useState<SessionStore | null>(null);
  useEffect(() => {
    if (!hub || !sessionId) {
      setStore(null);
      return;
    }
    setStore(hub.acquire(sessionId));
    return () => {
      hub.release(sessionId);
      setStore(null);
    };
  }, [hub, sessionId]);

  const owner = useRef("");
  if (owner.current === "") owner.current = `fs${++watchSeq}`;
  // paths 每次渲染都是新数组，用拼接后的字符串做依赖
  const key = paths.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 就是 paths 的内容
  useEffect(() => {
    if (!hub || !sessionId) return;
    hub.setWatch(sessionId, owner.current, env, paths);
  }, [hub, sessionId, env, key]);
  useEffect(
    () => () => {
      if (hub && sessionId) hub.setWatch(sessionId, owner.current, env, []);
    },
    [hub, sessionId, env],
  );

  const rev = useSyncExternalStore(store ? store.subscribe : noSub, () =>
    store ? (store.getSnapshot().fsRev[env] ?? 0) : 0,
  );
  // 每次拿到新数据后重挂一次监听：fs.watch 在目录被移动后会悄悄失效。
  // biome-ignore lint/correctness/useExhaustiveDependencies: env/rev 只是「该重挂了」的触发信号
  useEffect(() => {
    if (hub && sessionId) hub.refreshWatch(sessionId);
  }, [hub, sessionId, env, rev]);
  return rev;
}

// 订阅按会话共享的 store：同一会话的所有对话标签看到同一条连接、同一份状态与草稿。
export function useChatSession(sessionId: string): ChatSession {
  const hub = useChatHub();
  const [held, setHeld] = useState<SessionStore | null>(null);
  useEffect(() => {
    setHeld(hub.acquire(sessionId));
    return () => {
      hub.release(sessionId);
      setHeld(null);
    };
  }, [hub, sessionId]);

  const store = held && held.id === sessionId ? held : null;
  const state = useSyncExternalStore(
    store ? store.subscribe : noSub,
    store ? store.getSnapshot : initial,
  );
  const draft = useSyncExternalStore(hub.subscribeDrafts, () =>
    hub.draftOf(sessionId),
  );
  const actions = useMemo(() => makeActions(hub, sessionId), [hub, sessionId]);
  const metrics = useMemo(
    () => computeMetrics(state.usage, state.lastCall),
    [state.usage, state.lastCall],
  );
  return { state, actions, metrics, draft };
}
