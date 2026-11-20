import { expect, test, vi } from "vitest";
import type { CallResult, Result } from "../../../api/http";
import type { ForkedSession, SessionTree } from "../../../api/session-fork";
import { type ForkDeps, type ForkRequest, forkFromMessage } from "./flow";

const TREE: SessionTree = {
  leafId: "a1",
  activePath: ["a1", "u1"],
  nodes: [
    {
      id: "u1",
      parentId: null,
      type: "message",
      role: "user",
      preview: "你好",
      timestamp: "",
      children: [
        {
          id: "a1",
          parentId: "u1",
          type: "message",
          role: "assistant",
          preview: "在",
          timestamp: "",
          children: [],
        },
      ],
    },
  ],
};

const REQ: ForkRequest = {
  sessionId: "s1",
  target: { ordinal: 1, loadedAssistants: 1 },
};

function setup(over: Partial<ForkDeps> = {}) {
  const calls: string[] = [];
  const store = {
    adoptSession: vi.fn((sid: string) => {
      calls.push(`adopt:${sid}`);
    }),
    showSession: vi.fn((sid: string) => {
      calls.push(`show:${sid}`);
      return true;
    }),
  };
  const getTree = vi.fn(
    async (): Promise<Result<SessionTree>> => ({ ok: true, data: TREE }),
  );
  const fork = vi.fn(
    async (): Promise<CallResult<ForkedSession>> => ({
      ok: true,
      data: { id: "s2", title: "标题 · 分支1" },
    }),
  );
  const notify = vi.fn();
  const changed = vi.fn();
  const deps: ForkDeps = {
    getTree,
    fork,
    store,
    token: "tok",
    notify,
    changed,
    ...over,
  };
  return { deps, calls, store, getTree, fork, notify, changed };
}

test("拉树、按序号映射 entryId 调 fork，登记新会话后在当前窗口里打开它", async () => {
  const { deps, calls, getTree, fork, changed, notify } = setup();
  expect(await forkFromMessage(deps, REQ)).toBe(true);

  expect(getTree).toHaveBeenCalledWith("s1", "tok");
  expect(fork).toHaveBeenCalledWith("s1", "a1", "tok");
  // 先登记新会话 id（列表还没刷新），再打开
  expect(calls).toEqual(["adopt:s2", "show:s2"]);
  expect(changed).toHaveBeenCalledWith("s2");
  expect(notify).toHaveBeenCalledWith("已分叉：标题 · 分支1", "ok");
});

test("会话树读取失败：提示错误，不再调 fork", async () => {
  const { deps, fork, notify } = setup({
    getTree: vi.fn(
      async (): Promise<Result<SessionTree>> => ({
        ok: false,
        kind: "network",
      }),
    ),
  });
  expect(await forkFromMessage(deps, REQ)).toBe(false);
  expect(fork).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith("读取会话树失败，无法分叉", "danger");
});

test("映射不到 entryId：提示错误，不调 fork", async () => {
  const { deps, fork, notify, store } = setup();
  await forkFromMessage(deps, {
    ...REQ,
    target: { ordinal: 3, loadedAssistants: 5 },
  });
  expect(fork).not.toHaveBeenCalled();
  expect(store.showSession).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith("找不到这条消息对应的分叉点", "danger");
});

test("fork 被拒（运行中/压缩中）：提示错误，不登记也不切换", async () => {
  const { deps, notify, store } = setup({
    fork: vi.fn(
      async (): Promise<CallResult<ForkedSession>> => ({
        ok: false,
        kind: "conflict",
      }),
    ),
  });
  expect(await forkFromMessage(deps, REQ)).toBe(false);
  expect(store.adoptSession).not.toHaveBeenCalled();
  expect(store.showSession).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith("会话运行中或压缩中，不能分叉", "danger");
});

test("切换失败：分叉成功提示之后补一条 warn", async () => {
  const { deps, notify } = setup({
    store: {
      adoptSession: vi.fn(),
      showSession: vi.fn(() => false),
    },
  });
  expect(await forkFromMessage(deps, REQ)).toBe(true);
  expect(notify).toHaveBeenCalledWith("已分叉，但切换到新会话失败", "warn");
});
