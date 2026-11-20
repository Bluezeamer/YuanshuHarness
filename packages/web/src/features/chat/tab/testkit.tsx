// 对话标签组件测试的共用装置（只被 *.test.tsx 引用，不进产物）：
// 受控的假会话（state / draft 可随时 set，actions 是 vi.fn）、持有 tab 与 afx 的宿主（行为同 store.patchTab / patchAfx）。
import { cleanup, render } from "@testing-library/react";
import { useState, useSyncExternalStore } from "react";
import { afterEach, type Mock, vi } from "vitest";
import type { Pane, Tab, TabAfx } from "../../workspace/model/types";
import type { ChatActions, ChatSession } from "../hooks";
import type { Prompt, UsageStat } from "../model/conversation";
import { type Attachment, type Draft, emptyDraft } from "../model/draft";
import { computeMetrics } from "../model/metrics";
import { initialSnapshot, type SessionSnapshot } from "../store/sessionStore";
import { ChatView } from "./ChatView";
import { ChatTabContext, type ChatTabEnv, type SessionMeta } from "./context";

export interface FakeBox {
  session: ChatSession;
  actions: { [K in keyof ChatActions]: ReturnType<typeof vi.fn> };
  /** 浅合并会话状态并通知订阅者 */
  set(patch: Partial<SessionSnapshot>): void;
  setDraft(patch: Partial<Draft>): void;
  /** send 的下一个返回值 */
  sendResult: { ok: true } | { ok: false; message: string };
  subscribe(f: () => void): () => void;
}

export function fakeSession(
  over: Partial<SessionSnapshot> = {},
  draft: Partial<Draft> = {},
): FakeBox {
  const subs = new Set<() => void>();
  const box = {
    sendResult: { ok: true } as FakeBox["sendResult"],
  } as FakeBox;
  const state: ChatSession = {
    state: { ...initialSnapshot, conn: "open", ...over },
    draft: { ...emptyDraft, ...draft },
    metrics: computeMetrics(over.usage ?? null, over.lastCall ?? null),
    actions: {} as ChatActions,
  };
  let attSeq = 0;
  const emit = () => {
    state.metrics = computeMetrics(state.state.usage, state.state.lastCall);
    box.session = { ...state };
    for (const f of subs) f();
  };
  const a = {
    // 与 hub.submit 一致：缺省发草稿（成功后清空），传 text 只发这段、不动草稿
    send: vi.fn((text?: string) => {
      if (box.sendResult.ok && text === undefined) {
        state.draft = { ...emptyDraft };
        emit();
      }
      return box.sendResult;
    }),
    stop: vi.fn(),
    answerPrompt: vi.fn(() => true),
    setGoal: vi.fn(() => true),
    editGoal: vi.fn(() => true),
    pauseGoal: vi.fn(() => true),
    resumeGoal: vi.fn(() => true),
    clearGoal: vi.fn(() => true),
    compact: vi.fn(() => true),
    loadEarlier: vi.fn(),
    editQueue: vi.fn(() => true),
    removeQueue: vi.fn(() => true),
    queueTexts: vi.fn(async () =>
      state.state.queue.map((text) => ({ text, attachments: [] })),
    ),
    watch: vi.fn(() => true),
    reconnect: vi.fn(),
    dismissError: vi.fn(),
    setDraft: vi.fn((text: string) => {
      state.draft = { ...state.draft, text, restored: false };
      emit();
    }),
    addQuote: vi.fn(),
    removeQuote: vi.fn(),
    // 与 hub 一致：创建附件并回写草稿，上传链路拿返回的 id 更新进度。
    addAttachment: vi.fn((file: Omit<Attachment, "id">) => {
      const att: Attachment = { ...file, id: `a${++attSeq}` };
      state.draft = {
        ...state.draft,
        attachments: [...state.draft.attachments, att],
      };
      emit();
      return att;
    }),
    updateAttachment: vi.fn((attId: string, patch: Partial<Attachment>) => {
      state.draft = {
        ...state.draft,
        attachments: state.draft.attachments.map((a) =>
          a.id === attId ? { ...a, ...patch } : a,
        ),
      };
      emit();
    }),
    removeAttachment: vi.fn((attId: string) => {
      state.draft = {
        ...state.draft,
        attachments: state.draft.attachments.filter((a) => a.id !== attId),
      };
      emit();
    }),
  };
  state.actions = a as unknown as ChatActions;
  box.actions = a;
  box.session = { ...state };
  box.set = (patch) => {
    state.state = { ...state.state, ...patch };
    emit();
  };
  box.setDraft = (patch) => {
    state.draft = { ...state.draft, ...patch };
    emit();
  };
  box.subscribe = (f) => {
    subs.add(f);
    return () => subs.delete(f);
  };
  return box;
}

/** 浅合并 afx（undefined 删键），与 store.patchAfx 一致 */
export function mergeAfx(
  afx: TabAfx | undefined,
  patch: Partial<TabAfx>,
): TabAfx {
  const next: Record<string, unknown> = { ...afx, ...patch };
  for (const k of Object.keys(patch))
    if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
  return next as TabAfx;
}

export interface Harness {
  box: FakeBox;
  tab(): Tab;
  patchAfx: Mock<(p: Partial<TabAfx>) => void>;
}

export const pane: Pane = { pid: "p1", host: null, tabs: [], active: "t1" };

export function Host({
  box,
  meta,
  out,
  initial,
  env,
}: {
  box: FakeBox;
  meta?: SessionMeta | undefined;
  out: {
    tab: Tab;
    patchAfx: Harness["patchAfx"];
  };
  initial: Tab;
  env?: Partial<ChatTabEnv>;
}) {
  const session = useSyncExternalStore(box.subscribe, () => box.session);
  const [tab, setTab] = useState<Tab>(initial);
  out.tab = tab;
  const patchAfx = (p: Partial<TabAfx>) => {
    out.patchAfx(p);
    setTab((t) => ({ ...t, afx: mergeAfx(t.afx, p) }));
  };
  const view = (
    <ChatView
      sessionId="s1"
      tab={tab}
      patchAfx={patchAfx}
      session={session}
      meta={meta}
    />
  );
  return env ? (
    <ChatTabContext.Provider value={{ meta: () => meta, ...env }}>
      {view}
    </ChatTabContext.Provider>
  ) : (
    view
  );
}

export function mount(
  over: Partial<SessionSnapshot> = {},
  opts: {
    draft?: Partial<Draft>;
    tab?: Partial<Tab>;
    meta?: SessionMeta;
    env?: Partial<ChatTabEnv>;
  } = {},
): Harness {
  const box = fakeSession(over, opts.draft);
  const out = {
    tab: { id: "t1", type: "chat", sid: "s1", ...opts.tab } as Tab,
    patchAfx: vi.fn<(p: Partial<TabAfx>) => void>(),
  };
  render(
    <Host
      box={box}
      meta={opts.meta}
      out={out}
      initial={out.tab}
      {...(opts.env ? { env: opts.env } : {})}
    />,
  );
  return {
    box,
    tab: () => out.tab,
    patchAfx: out.patchAfx,
  };
}

export const approval = (id = "pa1", over: Partial<Prompt> = {}): Prompt => ({
  promptId: id,
  source: "approval",
  title: "允许执行 bash？",
  body: "该命令会重写远端提交历史",
  options: [
    { id: "allow", label: "仅此次通过" },
    { id: "deny", label: "拒绝" },
  ],
  detail: { tool: "bash", summary: "git push --force-with-lease origin main" },
  expiresAt: null,
  input: "text",
  ...over,
});

export const question = (id = "pq1", over: Partial<Prompt> = {}): Prompt => ({
  promptId: id,
  source: "question",
  title: "调研口径按哪种来做？",
  body: null,
  options: [
    { id: "brief", label: "3 家 · 深度简报" },
    { id: "sheet", label: "6 家 · 对比表" },
  ],
  detail: null,
  expiresAt: null,
  input: null,
  ...over,
});

/** 给滚动容器装上尺寸（jsdom 没有布局） */
export function sizeScroll(
  el: HTMLElement,
  m: { scrollHeight: number; clientHeight: number; scrollTop?: number },
) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => m.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => m.clientHeight,
  });
  el.scrollTop = m.scrollTop ?? 0;
}

afterEach(cleanup);

/** 指标夹具：2 轮 11 步、64.2 tok/s、累计 1.2M tok（输入 1.0M，其中缓存读取 942k）、占用 76k / 200k */
export const USAGE: UsageStat = {
  turns: 2,
  steps: 11,
  tokensPerSecond: 64.2,
  modelMs: 51_700,
  toolMs: null,
  ttftMs: null,
  tokens: {
    input: 1_000_000,
    output: 200_000,
    cacheRead: 942_000,
    cacheWrite: 0,
  },
  cacheHitRate: 0.942,
  context: { used: 76_000, window: 200_000, messages: 70_000 },
};

/** 最近一次调用的构成比例：系统 : 工具 : 消息 = 1 : 3 : 6 */
export const LAST_CALL = {
  system: 100,
  tools: 300,
  history: 400,
  current: 200,
  out: 50,
  cacheRead: 0,
  cacheWrite: 0,
  estimated: true,
};
