import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Block, Known } from "../../../api";
import {
  FakeWS,
  frame,
  installChatApi,
  msgs,
  snapshot,
} from "../../../test/chatFakes";
import { ToastHost } from "../../../ui";
import { LayoutProvider } from "../../workspace/layoutContext";
import { LAYOUT_VERSION } from "../../workspace/model/layoutDoc";
import { createLayoutStore } from "../../workspace/store/layoutStore";
import { ChatProvider } from "../context";
import { useChatSession } from "../hooks";
import { ChatView } from "./ChatView";
import { ChatTabContext } from "./context";
import { TurnMessage } from "./TurnMessage";
import { mount } from "./testkit";
import { installWorld } from "./testkit.world";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const assistant = (over: Partial<Known> = {}): Known => ({
  role: "assistant",
  text: "答复",
  ...over,
});

test("操作行只出现在轮末消息：非轮末的 assistant 没有切换与时间", () => {
  render(<TurnMessage m={assistant()} sessionId="s1" turnEnd={false} />);
  expect(screen.queryByRole("button", { name: "原文" })).toBeNull();
  expect(document.querySelector(".ch-turn")).toBeNull();
});

test("轮末操作行：原文 / 渲染只切换文字块，思考与工具链保持原样", () => {
  const blocks: Block[] = [
    { type: "text", text: "**粗**" },
    { type: "thinking", text: "想一想" },
    { type: "tool", id: "c1", name: "bash", args: "{}", result: "ok" },
  ];
  render(
    <TurnMessage
      m={assistant({ text: "**粗**", blocks })}
      sessionId="s1"
      turnEnd
    />,
  );
  const agent = document.querySelector(".ch-agent") as HTMLElement;
  // 渲染态：Markdown 生效，思考与工具链都在
  expect(agent.querySelector(":scope > .ch-md strong")?.textContent).toBe("粗");
  expect(agent.querySelector(".ch-raw")).toBeNull();
  expect(agent.querySelector(".ch-think")).toBeTruthy();
  expect(agent.querySelector(".ch-group")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "原文" }));
  // 原文态：同一段文字变纯文本 pre，思考卡片与工具链不受影响
  expect(document.querySelector(".ch-raw")?.textContent).toBe("**粗**");
  expect(agent.querySelector(":scope > .ch-md")).toBeNull();
  expect(agent.querySelector(".ch-think")).toBeTruthy();
  expect(agent.querySelector(".ch-group")).toBeTruthy();
  expect(screen.getByRole("button", { name: "渲染" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "渲染" }));
  expect(document.querySelector(".ch-raw")).toBeNull();
  expect(agent.querySelector(":scope > .ch-md strong")?.textContent).toBe("粗");
});

test("消息时间：有 ts 显示日期时间，缺 ts 不显示", () => {
  const ts = "2026-10-28T01:23:00.000Z";
  render(<TurnMessage m={assistant({ ts })} sessionId="s1" turnEnd />);
  const el = document.querySelector("time.ch-turn-time") as HTMLTimeElement;
  expect(el).toBeTruthy();
  expect(el.dateTime).toBe(ts);
  // 本地时区格式化，断言与展示层同一套规则
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  expect(el.textContent).toBe(
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
  );

  cleanup();
  render(<TurnMessage m={assistant()} sessionId="s1" turnEnd />);
  expect(document.querySelector("time.ch-turn-time")).toBeNull();
});

test("跨更早历史边界判断轮末：连续 assistant 只在最后一条带操作行", () => {
  // 历史最后一条 assistant 后面紧接窗口里的 assistant：这一轮还没结束，历史那条不带操作行
  mount({
    loaded: {
      older: [
        { index: 0, role: "user", text: "问一" },
        { index: 1, role: "assistant", text: "答一" },
      ],
      nextBefore: null,
      compactions: [],
      notices: [],
    },
    messages: [
      { role: "assistant", text: "答一续" },
      { role: "assistant", text: "答二" },
    ],
  });
  const rows = document.querySelectorAll(".ch-turn");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.parentElement?.textContent).toContain("答二");

  // 历史最后一条 assistant 后面紧跟窗口里的 user：它在历史里就是轮末，带操作行
  cleanup();
  mount({
    loaded: {
      older: [
        { index: 0, role: "user", text: "问一" },
        { index: 1, role: "assistant", text: "答一" },
      ],
      nextBefore: null,
      compactions: [],
      notices: [],
    },
    messages: [
      { role: "user", text: "问二" },
      { role: "assistant", text: "答二" },
    ],
  });
  const rows2 = document.querySelectorAll(".ch-turn");
  expect(rows2).toHaveLength(2);
  expect(rows2[0]?.parentElement?.textContent).toContain("答一");
});

// ── 与真实数据层 / 目录串起来：分叉按钮、禁用、entryId 与自动切换 ──

const TREE = {
  leafId: "a1",
  activePath: ["a1", "u1"],
  nodes: [
    {
      id: "u1",
      parentId: null,
      type: "message",
      role: "user",
      preview: "q",
      timestamp: "",
      children: [
        {
          id: "a1",
          parentId: "u1",
          type: "message",
          role: "assistant",
          preview: "a",
          timestamp: "",
          children: [],
        },
      ],
    },
  ],
};

interface ForkCall {
  url: string;
  body: unknown;
}

function installForkApi() {
  const chatFetch = globalThis.fetch;
  installWorld();
  const worldFetch = globalThis.fetch;
  const calls: ForkCall[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input === "/api/v1/sessions/s1/tree")
      return new Response(JSON.stringify(TREE), { status: 200 });
    if (input === "/api/v1/sessions/s1/fork" && init?.method === "POST") {
      calls.push({ url: input, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ id: "s2", title: "会话 s1 · 分支1" }),
        { status: 201 },
      );
    }
    // 对话数据层的 REST 继续走 chatFakes，其余走假世界
    return /^\/api\/v1\/sessions(\/s1\/(messages|usage|calls)(\?|$)|$|\?)/.test(
      input,
    )
      ? chatFetch(input, init)
      : worldFetch(input, init);
  });
  return { calls };
}

const tab = { id: "t1", type: "chat" as const, sid: "s1" };

function Body() {
  const session = useChatSession("s1");
  return (
    <ChatView sessionId="s1" tab={tab} patchAfx={() => {}} session={session} />
  );
}

const BRIEFS = [
  { id: "s1", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
];
const DIRS = [{ host: "server", path: "/w" }];
const NO_HOSTS: never[] = [];

function App({
  store,
  sessions = BRIEFS,
}: {
  store: ReturnType<typeof createLayoutStore>;
  sessions?: typeof BRIEFS;
}) {
  return (
    <ChatProvider token="tok" onUnauthorized={() => {}}>
      <LayoutProvider
        store={store}
        workspaceId="w1"
        directories={DIRS}
        sessions={sessions}
        hosts={NO_HOSTS}
      >
        <ChatTabContext.Provider
          value={{
            meta: () => ({ title: "S1", agentName: "agent", status: "idle" }),
          }}
        >
          <Body />
          <ToastHost />
        </ChatTabContext.Provider>
      </LayoutProvider>
    </ChatProvider>
  );
}

/** 一个窗口、一个窗格、一个固定的 s1 对话标签 */
const WITH_S1 = {
  version: LAYOUT_VERSION,
  windows: {
    list: [
      {
        id: "w1",
        focus: "p1",
        root: {
          pid: "p1",
          host: null,
          tabs: [{ id: "t1", type: "chat", ctab: "chat", sid: "s1" }],
          active: "t1",
        },
      },
    ],
    active: 0,
  },
};

function layoutStore() {
  return createLayoutStore({
    api: {
      get: async () => ({
        ok: true,
        data: { revision: 0, document: WITH_S1 },
      }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 1,
    notify: () => {},
  });
}

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  installChatApi(msgs(0, 2));
});

test("轮末操作行：分叉按钮在，运行中禁用并提示，空闲后恢复", async () => {
  installForkApi();
  render(<App store={layoutStore()} />);
  act(() => FakeWS.last.serve(snapshot(1, msgs(0, 2))));
  await screen.findByRole("button", { name: "分叉会话" });

  // 运行中：按钮禁用，悬停/点击提示原因
  act(() => FakeWS.last.serve(frame(2, "run.started", {})));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "分叉会话" }).getAttribute("title"),
    ).toBe("运行中不能分叉"),
  );
  expect(
    screen
      .getByRole("button", { name: "分叉会话" })
      .getAttribute("aria-disabled"),
  ).toBe("true");

  act(() => FakeWS.last.serve(frame(3, "run.ended", { aborted: false })));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "分叉会话" })
        .getAttribute("aria-disabled"),
    ).toBeNull(),
  );
});

test("点分叉：拉树映射到轮末 assistant 的 entryId，成功后在当前窗口里打开新会话", async () => {
  const fork = installForkApi();
  const store = layoutStore();
  render(<App store={store} />);
  act(() => FakeWS.last.serve(snapshot(1, msgs(0, 2))));
  await screen.findByRole("button", { name: "分叉会话" });
  await waitFor(() => expect(store.getState().status).toBe("ready"));

  fireEvent.click(screen.getByRole("button", { name: "分叉会话" }));

  await waitFor(() => expect(fork.calls).toHaveLength(1));
  // 目标 = 轮末那条 assistant（树里唯一的 assistant 节点 a1）
  expect(fork.calls[0]?.url).toBe("/api/v1/sessions/s1/fork");
  expect(fork.calls[0]?.body).toEqual({ entryId: "a1" });
  await waitFor(() => expect(store.viewing()).toEqual(["s2"]));
  await screen.findByText("已分叉：会话 s1 · 分支1");
});

test("分叉出的新会话：会话列表还没带上它时，标签不会被收敛关掉", async () => {
  installForkApi();
  const store = layoutStore();
  const { rerender } = render(<App store={store} />);
  act(() => FakeWS.last.serve(snapshot(1, msgs(0, 2))));
  await screen.findByRole("button", { name: "分叉会话" });
  await waitFor(() => expect(store.getState().status).toBe("ready"));
  fireEvent.click(screen.getByRole("button", { name: "分叉会话" }));
  await waitFor(() => expect(store.viewing()).toEqual(["s2"]));

  // 会话列表更新了，但推送还没带上 s2
  rerender(<App store={store} sessions={[...BRIEFS]} />);
  expect(store.viewing()).toEqual(["s2"]);
});
