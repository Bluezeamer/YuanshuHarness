import { expect, test } from "vitest";
import type { ConsoleEntry } from "../../../api/browser";
import {
  agentUseOf,
  applyBrowserEvent,
  type BrowserState,
  foldConsole,
  INITIAL_BROWSER,
  settleHandback,
} from "./model";
import { pageView } from "./testkit";

const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  ...INITIAL_BROWSER,
  link: "live",
  ...over,
});

const engine = (status: "idle" | "ready" = "ready") => ({
  status,
  executable: null,
  sandbox: null,
  emojiFont: null,
  problem: null,
});

const limits = { perWorkspace: 12, global: 30, sleepingPerWorkspace: 100 };

test("快照整体替换页面与引擎，连接状态不动", () => {
  const prev = state({
    link: "reconnecting",
    pages: [pageView({ id: "old" })],
  });
  const next = applyBrowserEvent(prev, {
    type: "snapshot",
    engine: engine(),
    pages: [pageView({ id: "a" })],
    limits,
  });
  expect(next.link).toBe("reconnecting");
  expect(next.engine).toEqual(engine());
  expect(next.limits).toEqual(limits);
  expect(next.pages.map((p) => p.id)).toEqual(["a"]);
});

test("added 追加、updated 原位替换、removed 删掉，顺序跟服务端走", () => {
  const a = pageView({ id: "a" });
  const b = pageView({ id: "b" });
  let s = state({ pages: [a, b] });
  s = applyBrowserEvent(s, {
    type: "page",
    event: { type: "added", page: pageView({ id: "c" }) },
  });
  expect(s.pages.map((p) => p.id)).toEqual(["a", "b", "c"]);

  s = applyBrowserEvent(s, {
    type: "page",
    event: { type: "updated", page: pageView({ id: "a", title: "新标题" }) },
  });
  expect(s.pages.map((p) => p.id)).toEqual(["a", "b", "c"]);
  expect(s.pages[0]?.title).toBe("新标题");

  s = applyBrowserEvent(s, {
    type: "page",
    event: { type: "removed", id: "b", workspaceKey: "w" },
  });
  expect(s.pages.map((p) => p.id)).toEqual(["a", "c"]);
});

test("引擎状态单独推一条时只替换 engine", () => {
  const s = applyBrowserEvent(state({ pages: [pageView({ id: "a" })] }), {
    type: "engine",
    state: engine("idle"),
  });
  expect(s.engine?.status).toBe("idle");
  expect(s.pages).toHaveLength(1);
});

test("agentUseOf：新开的 agent 页面算 fresh", () => {
  const use = agentUseOf(state(), {
    type: "page",
    event: { type: "added", page: pageView({ id: "a" }) },
  });
  expect(use).toEqual({ page: pageView({ id: "a" }), fresh: true });
});

test("agentUseOf：用户自己开的页面不报", () => {
  expect(
    agentUseOf(state(), {
      type: "page",
      event: { type: "added", page: pageView({ id: "a", userOpened: true }) },
    }),
  ).toBeNull();
  expect(
    agentUseOf(state(), {
      type: "page",
      event: { type: "added", page: pageView({ id: "a", controller: "user" }) },
    }),
  ).toBeNull();
});

test("agentUseOf：inUseBy 从 null 变成非 null 算接管（不是新开）", () => {
  const prev = state({
    pages: [pageView({ id: "a", inUseBy: null })],
  });
  const use = agentUseOf(prev, {
    type: "page",
    event: { type: "updated", page: pageView({ id: "a", inUseBy: "s1" }) },
  });
  expect(use).toEqual({
    page: pageView({ id: "a", inUseBy: "s1" }),
    fresh: false,
  });
});

test("agentUseOf：反例——连续动作、inUseBy 变回 null、事件前没有这个页面、快照", () => {
  const prev = state({
    pages: [
      pageView({ id: "a", inUseBy: "s1" }),
      pageView({ id: "b", inUseBy: "s1" }),
    ],
  });
  // 还在用：inUseBy 不变
  expect(
    agentUseOf(prev, {
      type: "page",
      event: { type: "updated", page: pageView({ id: "a", inUseBy: "s1" }) },
    }),
  ).toBeNull();
  // 交还给用户
  expect(
    agentUseOf(prev, {
      type: "page",
      event: { type: "updated", page: pageView({ id: "b", inUseBy: null }) },
    }),
  ).toBeNull();
  // 一直没人在用，只是标题 / 网址之类变了
  expect(
    agentUseOf(state({ pages: [pageView({ id: "c", inUseBy: null })] }), {
      type: "page",
      event: {
        type: "updated",
        page: pageView({ id: "c", inUseBy: null, title: "换了标题" }),
      },
    }),
  ).toBeNull();
  // 事件前没有这个页面：不知道是不是新用，交给 added 那套
  expect(
    agentUseOf(state(), {
      type: "page",
      event: { type: "updated", page: pageView({ id: "x", inUseBy: "s1" }) },
    }),
  ).toBeNull();
  // 首份快照不报（重连时也一样）
  expect(
    agentUseOf(state(), {
      type: "snapshot",
      engine: engine(),
      pages: [pageView({ id: "a", inUseBy: "s1" })],
      limits,
    }),
  ).toBeNull();
  // 删除不报
  expect(
    agentUseOf(prev, {
      type: "page",
      event: { type: "removed", id: "a", workspaceKey: "w" },
    }),
  ).toBeNull();
  // 引擎消息不报
  expect(
    agentUseOf(prev, { type: "engine", state: engine("idle") }),
  ).toBeNull();
});

const updated = (page: ReturnType<typeof pageView>) =>
  ({ type: "page", event: { type: "updated", page } }) as const;

test("handedBack：操作者从用户变回 agent 记一次；agent 自己的后续更新、没有前态都不记", () => {
  const user = pageView({ id: "a", controller: "user" });
  const agent = { ...user, controller: "agent" as const };
  const mine = state({ pages: [user] });

  const back = applyBrowserEvent(mine, updated(agent));
  expect(back.handedBack).toEqual(["a"]);
  // agent 自己的页面又更新（加载、标题）：不是交还
  expect(
    applyBrowserEvent(
      state({ pages: [agent] }),
      updated({ ...agent, title: "x" }),
    ).handedBack,
  ).toEqual([]);
  // 事件前没有这个页面：不知道它之前是谁在操作
  expect(applyBrowserEvent(state(), updated(agent)).handedBack).toEqual([]);
});

test("handedBack：同一次交还没人处理时不重复记；处理后再交还又记一次", () => {
  const user = pageView({ id: "a", controller: "user" });
  const agent = { ...user, controller: "agent" as const };
  let s = applyBrowserEvent(state({ pages: [user] }), updated(agent));
  // 还没处理就又接管又交还：仍是一条
  s = applyBrowserEvent(s, updated(user));
  s = applyBrowserEvent(s, updated(agent));
  expect(s.handedBack).toEqual(["a"]);

  s = settleHandback(s, "a");
  expect(s.handedBack).toEqual([]);
  s = applyBrowserEvent(s, updated(user));
  s = applyBrowserEvent(s, updated(agent));
  expect(s.handedBack).toEqual(["a"]);
});

test("handedBack：页面关了、快照里没有它了就清掉，别留着等一个不存在的页面", () => {
  const user = pageView({ id: "a", controller: "user" });
  const agent = { ...user, controller: "agent" as const };
  const back = applyBrowserEvent(state({ pages: [user] }), updated(agent));
  expect(
    applyBrowserEvent(back, {
      type: "page",
      event: { type: "removed", id: "a", workspaceKey: "ws1" },
    }).handedBack,
  ).toEqual([]);
  expect(
    applyBrowserEvent(back, {
      type: "snapshot",
      engine: engine(),
      pages: [],
      limits,
    }).handedBack,
  ).toEqual([]);
});

const con = (id: number, count = 1): ConsoleEntry => ({
  id,
  ts: id,
  firstTs: id,
  count,
  kind: "console",
  level: "warn",
  text: `m${id}`,
});

test("foldConsole：新的组接在后面，同一组原地更新次数", () => {
  const a = con(1);
  const b = con(2);
  expect(foldConsole([a], b, 500)).toEqual([a, b]);
  expect(foldConsole([a, b], con(1, 4), 500)).toEqual([con(1, 4), b]);
});

test("foldConsole：只留最近 max 组", () => {
  expect(foldConsole([con(1), con(2)], con(3), 2).map((e) => e.id)).toEqual([
    2, 3,
  ]);
});
