import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeWS, snapshot } from "../../../test/chatFakes";
import {
  LayoutProvider,
  useLayoutState,
  useLayoutStore,
} from "../../workspace/layoutContext";
import { panesOf } from "../../workspace/model/l2";
import {
  LAYOUT_VERSION,
  type LayoutDoc,
} from "../../workspace/model/layoutDoc";
import { createLayoutStore } from "../../workspace/store/layoutStore";
import { getTabDef } from "../../workspace/tabs/registry";
import { ChatProvider } from "../context";
import { registerSubTab } from "./ExecTab";
import { forgetExecutions } from "./names";
import { FLOWS, installFlowsApi, exec as makeExec } from "./testkit";
import { useOpenExecution } from "./useOpenExecution";

// 注册之前的占位图标：注册后图标应保持不变
const PLACEHOLDER_ICON = getTabDef("sub").icon;

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  forgetExecutions();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DIRS = [{ host: "server", path: "/w" }];
const sessions = [
  { id: "s1", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
];

/** 一个窗口、一个窗格、一个 s1 对话标签 */
const DOC: LayoutDoc = {
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

function Probe() {
  const store = useLayoutStore();
  const win = useLayoutState((s) => s.doc.windows).list[0];
  const first = win ? panesOf(win)[0] : undefined;
  const open = useOpenExecution("s1", first?.pid ?? "");
  const subs = win
    ? panesOf(win).flatMap((p) =>
        p.tabs.filter((t) => t.type === "sub").map((t) => `${p.pid}:${t.sub}`),
      )
    : [];
  return (
    <div>
      <output aria-label="pid">{first?.pid}</output>
      <output aria-label="subs">{subs.join(",")}</output>
      <output aria-label="active">
        {first?.tabs.find((t) => t.id === first.active)?.type}
      </output>
      <button type="button" onClick={() => open("x1")}>
        开x1
      </button>
      <button type="button" onClick={() => open("x2")}>
        开x2
      </button>
      <button
        type="button"
        onClick={() =>
          first && store.activateTab(first.pid, first.tabs[0]?.id ?? "")
        }
      >
        回首个
      </button>
    </div>
  );
}

const newStore = () =>
  createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: DOC } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });

// 标签内容里的 useOpenJob 要布局环境
const inLayout = (children: ReactNode, store = newStore()) => (
  <LayoutProvider
    store={store}
    workspaceId="ws1"
    directories={DIRS}
    sessions={sessions}
    hosts={[{ id: "server", name: "Server" }]}
  >
    {children}
  </LayoutProvider>
);

async function mount() {
  const store = newStore();
  render(inLayout(<Probe />, store));
  await act(async () => {
    await store.setWorkspace("ws1");
  });
  return { store, pid: screen.getByLabelText("pid").textContent ?? "" };
}
const subs = () => screen.getByLabelText("subs").textContent;

test("点执行体：在当前窗格新开 sub 标签；同一执行体只开一个，再点只激活它", async () => {
  const { pid } = await mount();
  expect(subs()).toBe("");
  fireEvent.click(screen.getByText("开x1"));
  expect(subs()).toBe(`${pid}:x1`);
  expect(screen.getByLabelText("active").textContent).toBe("sub");
  fireEvent.click(screen.getByText("回首个"));
  expect(screen.getByLabelText("active").textContent).not.toBe("sub");
  fireEvent.click(screen.getByText("开x1"));
  expect(subs()).toBe(`${pid}:x1`);
  expect(screen.getByLabelText("active").textContent).toBe("sub");
  fireEvent.click(screen.getByText("开x2"));
  expect(subs()).toBe(`${pid}:x1,${pid}:x2`);
});

test("sub 标签不绑定主机，带所属会话与执行体 id", async () => {
  const { store } = await mount();
  fireEvent.click(screen.getByText("开x1"));
  const win = store.getState().doc.windows.list[0];
  const tab =
    win &&
    panesOf(win)
      .flatMap((p) => p.tabs)
      .find((t) => t.type === "sub");
  expect(tab).toMatchObject({ type: "sub", sid: "s1", sub: "x1" });
  expect(tab?.host).toBeUndefined();
});

test("registerSubTab：标题取执行体名称，取不到退回「执行体」；渲染执行体视图", async () => {
  registerSubTab();
  const def = getTabDef("sub");
  expect(def.title({ id: "t", type: "sub", sid: "s1", sub: "x1" })).toBe(
    "执行体",
  );
  expect(def.title({ id: "t", type: "sub" })).toBe("执行体");

  installFlowsApi({
    flows: { ...FLOWS, executions: [makeExec({ name: "回归审阅" })] },
  });
  const tab = { id: "t1", type: "sub" as const, sid: "s1", sub: "x1" };
  render(
    <ChatProvider token="tok" onUnauthorized={() => {}}>
      {inLayout(
        def.render({
          tab,
          pane: { pid: "p1", host: null, tabs: [tab], active: "t1" },
          sessionId: "s1",
          active: true,
          patchTab: () => {},
          patchAfx: () => {},
          close: () => {},
        }),
      )}
    </ChatProvider>,
  );
  await act(async () => {
    FakeWS.all[0]?.serve(snapshot(1, []));
  });
  await waitFor(() => screen.getByText("回归审阅"));
  // 拿到清单后名称进缓存，标签标题随之变成执行体名称
  expect(def.title(tab)).toBe("回归审阅");
  expect(def.icon).toBe(PLACEHOLDER_ICON);
});

test("sub 标签没有所属会话（tab.sid 与 sessionId 都空）：显示找不到所属会话", () => {
  registerSubTab();
  const def = getTabDef("sub");
  const tab = { id: "t1", type: "sub" as const, sub: "x1" };
  render(
    <ChatProvider token="tok" onUnauthorized={() => {}}>
      {inLayout(
        def.render({
          tab,
          pane: { pid: "p1", host: null, tabs: [tab], active: "t1" },
          sessionId: null,
          active: true,
          patchTab: () => {},
          patchAfx: () => {},
          close: () => {},
        }),
      )}
    </ChatProvider>,
  );
  expect(screen.getByText("找不到所属会话")).toBeTruthy();
});
