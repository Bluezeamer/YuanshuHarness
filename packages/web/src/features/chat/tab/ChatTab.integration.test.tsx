// 接真数据层（ChatProvider + 假 WebSocket）：注册表里的 chat 渲染器端到端走一遍。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FakeWS,
  frame,
  installChatApi,
  msgs,
  snapshot,
} from "../../../test/chatFakes";
import { LayoutProvider } from "../../workspace/layoutContext";
import {
  LAYOUT_VERSION,
  type LayoutDoc,
} from "../../workspace/model/layoutDoc";
import type { Tab } from "../../workspace/model/types";
import { createLayoutStore } from "../../workspace/store/layoutStore";
import { getTabDef } from "../../workspace/tabs/registry";
import { ChatProvider } from "../context";
import { ChatTabContext } from "./context";
import { registerChatTab } from "./register";
import { TurnChangesCard } from "./TurnChangesCard";
import { installWorld } from "./testkit.world";

vi.mock("../audit", () => ({ AuditPane: () => <div data-testid="audit" /> }));

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  installChatApi(msgs(0, 2));
  const chatFetch = globalThis.fetch;
  installWorld();
  const worldFetch = globalThis.fetch;
  // 对话数据层的 REST 走 chatFakes，输入栏的会话配置 / 供应商等走假世界
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    /^\/api\/v1\/sessions(\/s[12]\/(messages|usage|calls)(\?|$)|$|\?)/.test(
      input,
    )
      ? chatFetch(input, init)
      : worldFetch(input, init),
  );
  registerChatTab();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tab: Tab = { id: "t1", type: "chat", sid: "s1" };

const DIRS = [{ host: "server", path: "/w" }];
const BRIEFS = [
  { id: "s1", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
];

function layoutStore() {
  return createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: null } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });
}

function setup(sessionId: string | null = "s1") {
  const patchTab = vi.fn();
  const def = getTabDef("chat");
  const tree = (sid: string | null) => (
    <LayoutProvider
      store={layoutStore()}
      workspaceId="ws1"
      directories={DIRS}
      sessions={BRIEFS}
      hosts={[]}
    >
      <ChatProvider token="tok" onUnauthorized={() => {}}>
        <ChatTabContext.Provider
          value={{
            meta: (id) => ({
              title: `会话 ${id}`,
              agentName: "编码",
              status: "running",
            }),
          }}
        >
          {def.render({
            tab,
            pane: { pid: "p1", host: null, tabs: [tab], active: "t1" },
            sessionId: sid,
            active: true,
            patchTab,
            patchAfx: vi.fn(),
            close: vi.fn(),
          })}
        </ChatTabContext.Provider>
      </ChatProvider>
    </LayoutProvider>
  );
  const view = render(tree(sessionId));
  // ws 惰性取：空对话标签不该建连接，取值本身就会报错
  return {
    get ws(): FakeWS {
      return FakeWS.last;
    },
    patchTab,
    def,
    // 同一个标签换绑到另一个会话（临时标签选了别的会话）：标签 id 不变，窗格不会重新挂载
    switchTo: (sid: string) => view.rerender(tree(sid)),
  };
}

test("空对话标签（sessionId 为 null）：显示空状态，不碰会话数据层", () => {
  setup(null);
  expect(screen.getByText("还没有对话")).toBeTruthy();
  expect(screen.getByText("在左侧选一个会话，或新建一个对话。")).toBeTruthy();
  // 没有建 WebSocket，也没渲染对话主体
  expect(FakeWS.all).toHaveLength(0);
  expect(document.querySelector(".ch-shell")).toBeNull();
});

test("registerChatTab 把 chat 类型注册进注册表（标题与图标）", () => {
  const def = getTabDef("chat");
  expect(def.title(tab)).toBe("对话");
  expect(def.icon).toBeTruthy();
});

test("快照到达后渲染历史；批准一次发 answer_prompt，prompt.resolved 后落定", () => {
  const { ws } = setup();
  act(() =>
    ws.serve(
      snapshot(1, msgs(0, 2), {
        prompts: [
          {
            promptId: "p1",
            source: "approval",
            title: "允许执行 bash？",
            input: "text",
            body: "删除 build 目录",
            options: [
              { id: "allow", label: "仅此次通过" },
              { id: "deny", label: "拒绝" },
            ],
            detail: { tool: "bash", summary: "rm -rf build" },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      }),
    ),
  );
  // 没有对话头：标题在标签与左轨里，窗格内不重复
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.getByText("m1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  expect(ws.commands("answer_prompt")).toEqual([
    { id: "c1", type: "answer_prompt", promptId: "p1", optionId: "allow" },
  ]);
  act(() => ws.serve({ type: "ack", id: "c1", ok: true }));
  act(() =>
    ws.serve(
      frame(2, "prompt.resolved", { promptId: "p1", outcome: "answered" }),
    ),
  );
  expect(screen.getByLabelText("审批").textContent).toMatch(/已批准/);
});

test("同一个标签换绑到另一个会话：上一个会话的审批落定卡与压缩回执不带过去", () => {
  const { ws: first, switchTo } = setup();
  act(() => first.serve(snapshot(1, msgs(0, 2))));
  act(() =>
    first.serve(
      frame(2, "prompt.requested", {
        promptId: "p1",
        source: "approval",
        title: "允许执行 bash？",
        options: [{ id: "allow", label: "仅此次通过" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  act(() => first.serve({ type: "ack", id: "c1", ok: true }));
  act(() =>
    first.serve(
      frame(3, "prompt.resolved", { promptId: "p1", outcome: "answered" }),
    ),
  );
  act(() =>
    first.serve(
      frame(4, "context.compacted", { summary: "摘要", savedPct: 40 }),
    ),
  );
  expect(screen.getByLabelText("审批").textContent).toMatch(/已批准/);
  expect(screen.getByText(/上下文已压缩/)).toBeTruthy();

  act(() => switchTo("s2"));
  const second = FakeWS.last;
  expect(second).not.toBe(first);
  act(() => second.serve(snapshot(1, msgs(0, 2))));
  expect(screen.queryByLabelText("审批")).toBeNull();
  expect(screen.queryByText(/上下文已压缩/)).toBeNull();
});

test("服务端的目标卡片（notice）到达后对话流里多一条 /goal 回执", () => {
  const { ws } = setup();
  act(() => ws.serve(snapshot(1, msgs(0, 2))));
  act(() =>
    ws.serve(
      frame(2, "notice", {
        kind: "goal",
        goal: {
          event: "set",
          goalId: "g1",
          revision: 1,
          by: "user",
          text: "补齐测试",
        },
        ts: "2026-10-25T10:00:00.000Z",
      }),
    ),
  );
  expect(screen.getByText("/goal")).toBeTruthy();
  expect(screen.getByText(/长期目标已设定：补齐测试/)).toBeTruthy();
});

test("/goal 空文字：给出用法提示，不产生任何命令", async () => {
  const { ws } = setup();
  act(() => ws.serve(snapshot(1, msgs(0, 2))));
  const ta = screen.getByRole("textbox", { name: /发消息/ });
  fireEvent.change(ta, { target: { value: "/goal" } });
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(screen.getByRole("alert").textContent).toContain("在 /goal 后写目标");
  expect(ws.commands("send_message")).toEqual([]);
  expect(ws.commands("set_goal")).toEqual([]);
});

test("/goal 文字与 /compact 由 parseInput 路由，不产生 send_message", () => {
  const { ws } = setup();
  act(() => ws.serve(snapshot(1, msgs(0, 2))));
  const ta = () =>
    screen.getByRole("textbox", { name: /发消息/ }) as HTMLTextAreaElement;
  fireEvent.change(ta(), { target: { value: "/goal 只做只读审计" } });
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(ws.commands("set_goal")).toEqual([
    { id: "c1", type: "set_goal", text: "只做只读审计" },
  ]);
  expect(ta().value).toBe("");
  fireEvent.change(ta(), { target: { value: "/compact" } });
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(ws.commands("compact")).toHaveLength(1);
  expect(ws.commands("send_message")).toEqual([]);
  // 压缩受理中：进度态；仍可发送（服务端排队，压缩完成后送出）
  expect(screen.getByRole("status").textContent).toContain("正在压缩上下文");
  fireEvent.change(ta(), { target: { value: "继续" } });
  expect(
    (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(ws.commands("send_message")).toEqual([
    { id: "c3", type: "send_message", text: "继续" },
  ]);
  act(() =>
    ws.serve(frame(2, "context.compacted", { summary: "摘要", savedPct: 40 })),
  );
  expect(screen.queryByRole("status")).toBeNull();
});

test("普通消息走 send_message；发送后草稿清空", () => {
  const { ws } = setup();
  act(() => ws.serve(snapshot(1, msgs(0, 2))));
  const ta = () =>
    screen.getByRole("textbox", { name: /发消息/ }) as HTMLTextAreaElement;
  fireEvent.change(ta(), { target: { value: "你好" } });
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(ws.commands("send_message")).toEqual([
    { id: "c1", type: "send_message", text: "你好" },
  ]);
  expect(ta().value).toBe("");
});

test("右侧状态挂在对话标签里：有计划 / 已加载能力就出现，宽时常驻在主栏旁，窄时是竖排标签", async () => {
  // jsdom 没有布局，元素宽度恒为 0 会落到窄形态；桩一个宽度让它走常驻
  const cw = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  const width = { v: 1000 };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width.v,
  });
  const { ws } = setup();
  act(() =>
    ws.serve(
      snapshot(1, msgs(0, 2), {
        todos: [{ content: "补测试", status: "in_progress" }],
      }),
    ),
  );
  const shell = document.querySelector(".ch-shell") as HTMLElement;
  // 内容来自会话快照（计划）与 /context（已加载能力）
  expect(await screen.findByText("已加载能力")).toBeTruthy();
  expect(
    [...shell.children].map((c) =>
      c.matches(".ch-main")
        ? "main"
        : c.matches("aside.ch-status")
          ? "status"
          : "?",
    ),
  ).toContain("status");
  const status = shell.querySelector("aside.ch-status") as HTMLElement;
  expect(within(status).getByText("计划")).toBeTruthy();
  expect(within(status).getByText("补测试")).toBeTruthy();
  expect(shell.querySelector(".ch-rail")).toBeNull();
  if (cw) Object.defineProperty(HTMLElement.prototype, "clientWidth", cw);
});

test("轮末改动卡片点文件名：带上所属会话打开那一轮的 diff", async () => {
  const doc: LayoutDoc = {
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
  const store = createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: doc } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });
  const spy = vi.spyOn(store, "openDiff");
  render(
    <LayoutProvider
      store={store}
      workspaceId="ws1"
      directories={DIRS}
      sessions={BRIEFS}
      hosts={[]}
    >
      <TurnChangesCard
        sessionId="s1"
        turn={{
          turn: 3,
          mode: "git",
          total: 1,
          createdAt: "2026-10-25T10:00:00.000Z",
          anchorTs: null,
          files: [
            { path: "src/a.ts", status: "modified", added: 2, removed: 1 },
          ],
        }}
      />
    </LayoutProvider>,
  );
  await act(async () => {
    await store.setWorkspace("ws1");
  });
  // 默认折成一行摘要，点开才是文件清单
  expect(
    screen.getByRole("button", { name: /本轮改动 1 个文件/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /本轮改动/ }));
  fireEvent.click(screen.getByTitle("打开 src/a.ts 的改动"));
  // 以当前窗口里承载该会话的窗格为参照，并把会话 id 一起带给 diff 标签
  expect(spy).toHaveBeenCalledWith("p1", "t1", 3, "src/a.ts", "s1");
});
