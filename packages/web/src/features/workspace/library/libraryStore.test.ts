// 库 store：拉取目录、接推送流、未知工作区补拉、变更后重取、start / stop 的生命周期。

import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../api/http";
import type {
  LibraryEvent,
  LibraryStreamHandlers,
} from "../../../api/libraryStream";
import type { LibrarySession } from "../../../api/sessionLibrary";
import type { WorkspaceGroup } from "../../../api/workspaceGroups";
import type { Workspace } from "../../../api/workspaces";
import {
  createLibraryStore,
  errorText,
  type LibraryApi,
  type LibraryStore,
} from "./libraryStore";

afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;

function workspace(over: Partial<Workspace> = {}): Workspace {
  const n = ++seq;
  return {
    id: `w${n}`,
    name: `工作区${n}`,
    description: "",
    groupId: null,
    archived: false,
    pinned: false,
    order: n,
    defaults: {},
    reviewPolicy: { mode: "append", text: "" },
    directories: [],
    sessionCount: 0,
    createdAt: "2026-10-25T08:00:00.000Z",
    updatedAt: "2026-10-25T08:00:00.000Z",
    ...over,
  };
}

function group(over: Partial<WorkspaceGroup> = {}): WorkspaceGroup {
  const n = ++seq;
  return {
    id: `g${n}`,
    name: `分组${n}`,
    tone: 0,
    collapsed: false,
    order: n,
    ...over,
  };
}

function session(over: Partial<LibrarySession> = {}): LibrarySession {
  const n = ++seq;
  return {
    id: `s${n}`,
    title: `会话${n}`,
    no: null,
    name: null,
    status: "idle",
    lifecycle: "active",
    workspaceId: null,
    parentSessionId: null,
    forkEntryId: null,
    unreadResult: false,
    unreadError: false,
    pinned: false,
    createdAt: "2026-10-25T08:00:00.000Z",
    updatedAt: "2026-10-25T08:00:00.000Z",
    running: false,
    directoryId: null,
    promptPresetId: null,
    modePresetIds: [],
    activeModeId: null,
    ...over,
  };
}

interface FakeStream {
  handlers: LibraryStreamHandlers;
  viewingCalls: (readonly string[])[];
  closed: boolean;
  viewing(ids: readonly string[]): void;
  close(): void;
}

interface Fake {
  api: LibraryApi;
  workspaces: Workspace[];
  groups: WorkspaceGroup[];
  streams: FakeStream[];
  /** listWorkspaces 被调用的次数 */
  lists: number;
  /** 变更接口被调用的流水 */
  calls: string[];
  /** 让下一次目录拉取等着 */
  hold: { promise: Promise<void>; release(): void } | null;
  failList: unknown;
  failMutation: unknown;
}

function fakeLibrary(
  init: { workspaces?: Workspace[]; groups?: WorkspaceGroup[] } = {},
): Fake {
  const f: Fake = {
    workspaces: init.workspaces ?? [],
    groups: init.groups ?? [],
    streams: [],
    lists: 0,
    calls: [],
    hold: null,
    failList: null,
    failMutation: null,
    api: null as unknown as LibraryApi,
  };
  const failure = async (e: unknown) => {
    if (e) throw e;
  };
  f.api = {
    async listWorkspaces() {
      f.lists++;
      if (f.hold) await f.hold.promise;
      await failure(f.failList);
      return [...f.workspaces];
    },
    async listGroups() {
      await failure(f.failList);
      return [...f.groups];
    },
    async createWorkspace(input) {
      f.calls.push(`wcreate:${input.directories.length}`);
      await failure(f.failMutation);
      return workspace({ id: "w-new" });
    },
    async patchWorkspace(id, patch) {
      f.calls.push(`wpatch:${id}:${JSON.stringify(patch)}`);
      await failure(f.failMutation);
      return { ...workspace({ id }), ...patch };
    },
    async reorderWorkspaces(ids) {
      f.calls.push(`worder:${ids.join(",")}`);
      await failure(f.failMutation);
    },
    async deleteWorkspace(id) {
      f.calls.push(`wdelete:${id}`);
      await failure(f.failMutation);
    },
    async createGroup(input) {
      f.calls.push(`gcreate:${input.name}`);
      await failure(f.failMutation);
      return group({ id: "g-new", name: input.name });
    },
    async patchGroup(id, patch) {
      f.calls.push(`gpatch:${id}:${JSON.stringify(patch)}`);
      await failure(f.failMutation);
      return { ...group({ id }), ...patch };
    },
    async deleteGroup(id) {
      f.calls.push(`gdelete:${id}`);
      await failure(f.failMutation);
    },
    openStream(handlers) {
      const s: FakeStream = {
        handlers,
        viewingCalls: [],
        closed: false,
        viewing(ids: readonly string[]) {
          s.viewingCalls.push(ids);
        },
        close() {
          s.closed = true;
        },
      };
      f.streams.push(s);
      return s;
    },
  };
  return f;
}

function held(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function setup(init: Parameters<typeof fakeLibrary>[0] = {}) {
  const f = fakeLibrary(init);
  const notify = vi.fn();
  const events = { fired: 0 };
  const store = createLibraryStore({ api: f.api, notify });
  store.subscribe(() => events.fired++);
  const stream = (i = 0) => f.streams[i] as FakeStream;
  const emit = async (e: LibraryEvent, i = 0) => {
    stream(i).handlers.onEvent(e);
    await settle();
  };
  return { f, store, notify, events, stream, emit };
}

test("start：目录与推送流同时发起", async () => {
  const { f, store } = setup({ workspaces: [workspace()] });
  const stop = store.start();
  expect(f.lists).toBe(1);
  expect(f.streams).toHaveLength(1);
  await settle();
  expect(store.getState().workspaces).toHaveLength(1);
  stop();
});

test("推送事件合并进 sessions；没有变化不通知订阅者", async () => {
  const { store, events, emit } = setup();
  const stop = store.start();
  await settle();

  const a = session({ id: "a" });
  await emit({ type: "snapshot", sessions: [a] });
  expect(store.getState().sessions.map((s) => s.id)).toEqual(["a"]);

  let fired = events.fired;
  await emit({ type: "added", session: a });
  expect(events.fired).toBe(fired);

  await emit({ type: "added", session: session({ id: "b" }) });
  expect(store.getState().sessions.map((s) => s.id)).toEqual(["a", "b"]);

  const updated = { ...a, title: "改名了" };
  fired = events.fired;
  await emit({ type: "updated", session: updated });
  expect(events.fired).toBe(fired + 1);
  expect(store.getState().sessions[0]?.title).toBe("改名了");

  await emit({ type: "removed", id: "b" });
  expect(store.getState().sessions.map((s) => s.id)).toEqual(["a"]);

  fired = events.fired;
  await emit({ type: "removed", id: "没有这个" });
  expect(events.fired).toBe(fired);
  stop();
});

test("live 随流状态切换", async () => {
  const { store, stream } = setup();
  const stop = store.start();
  expect(store.getState().live).toBe(false);
  stream().handlers.onStatus?.("live");
  expect(store.getState().live).toBe(true);
  stream().handlers.onStatus?.("reconnecting");
  expect(store.getState().live).toBe(false);
  stop();
});

test("ready 要目录与快照都到；每次快照都重新拉目录", async () => {
  const { f, store, emit } = setup({ workspaces: [workspace()] });
  const stop = store.start();
  await settle();
  expect(store.getState().ready).toBe(false);

  await emit({ type: "snapshot", sessions: [] });
  expect(store.getState().ready).toBe(true);
  const afterFirst = f.lists;

  // 重连后的新快照：工作区 / 分组可能已被别处改过
  await emit({ type: "snapshot", sessions: [session()] });
  expect(f.lists).toBe(afterFirst + 1);
  expect(store.getState().ready).toBe(true);
  stop();
});

test("未知工作区：去抖补拉一次，同一个 id 不重复；null 不算", async () => {
  vi.useFakeTimers();
  const known = workspace({ id: "w1" });
  const { f, store, emit } = setup({ workspaces: [known] });
  const stop = store.start();
  await emit({ type: "snapshot", sessions: [] });
  const base = f.lists;

  await emit({ type: "added", session: session({ workspaceId: null }) });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.lists).toBe(base);

  await emit({ type: "added", session: session({ workspaceId: "w9" }) });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.lists).toBe(base + 1);

  await emit({ type: "added", session: session({ workspaceId: "w9" }) });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.lists).toBe(base + 1);

  // 期间的重复出现不会叠加：定时器到点只补拉一次
  await emit({ type: "added", session: session({ workspaceId: "w8" }) });
  await vi.advanceTimersByTimeAsync(200);
  expect(f.lists).toBe(base + 1);
  await emit({ type: "added", session: session({ workspaceId: "w8" }) });
  await vi.advanceTimersByTimeAsync(200);
  expect(f.lists).toBe(base + 2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.lists).toBe(base + 2);
  stop();
});

test("未知工作区补上之后不再重复补拉", async () => {
  vi.useFakeTimers();
  const { f, store, emit } = setup({ workspaces: [] });
  const stop = store.start();
  await emit({ type: "snapshot", sessions: [] });
  const base = f.lists;

  const w5 = workspace({ id: "w5" });
  f.workspaces = [w5];
  await emit({ type: "added", session: session({ workspaceId: "w5" }) });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.lists).toBe(base + 1);
  expect(store.getState().workspaces).toEqual([w5]);

  // 该 id 已进目录：之后同一 id 的事件不再触发补拉
  await emit({ type: "added", session: session({ workspaceId: "w5" }) });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.lists).toBe(base + 1);
  stop();
});

test("reload 并发合并：在飞时再调只补一次", async () => {
  const { f, store, emit } = setup({ workspaces: [workspace()] });
  const stop = store.start();
  await emit({ type: "snapshot", sessions: [] });
  const base = f.lists;

  f.hold = held();
  const a = store.reload();
  const b = store.reload();
  const c = store.reload();
  expect(f.lists).toBe(base + 1);
  f.hold.release();
  await Promise.all([a, b, c]);
  expect(f.lists).toBe(base + 2);

  await store.reload();
  expect(f.lists).toBe(base + 3);
  stop();
});

test("reload 失败标 failed，成功后复位", async () => {
  const { f, store } = setup({ workspaces: [workspace()] });
  const stop = store.start();
  await settle();
  expect(store.getState().failed).toBe(false);

  f.failList = new ApiError(0, null);
  await store.reload();
  expect(store.getState().failed).toBe(true);

  f.failList = null;
  await store.reload();
  expect(store.getState().failed).toBe(false);
  stop();
});

interface Case {
  name: string;
  call: (s: LibraryStore) => Promise<unknown>;
  /** 失败时的返回值 */
  failed: unknown;
}

const CASES: Case[] = [
  {
    name: "createWorkspace",
    call: (s) => s.createWorkspace({ directories: [{ path: "/n" }] }),
    failed: null,
  },
  {
    name: "patchWorkspace",
    call: (s) => s.patchWorkspace("w1", { name: "改" }),
    failed: null,
  },
  {
    name: "reorderWorkspaces",
    call: (s) => s.reorderWorkspaces(["w1"]),
    failed: false,
  },
  {
    name: "deleteWorkspace",
    call: (s) => s.deleteWorkspace("w1"),
    failed: false,
  },
  {
    name: "createGroup",
    call: (s) => s.createGroup({ name: "组" }),
    failed: null,
  },
  {
    name: "patchGroup",
    call: (s) => s.patchGroup("g1", { tone: 2 }),
    failed: null,
  },
  { name: "deleteGroup", call: (s) => s.deleteGroup("g1"), failed: false },
];

for (const c of CASES) {
  test(`变更 ${c.name}：成功返回结果并 reload`, async () => {
    const { f, store } = setup({ workspaces: [workspace()] });
    const stop = store.start();
    await settle();
    const base = f.lists;
    const r = await c.call(store);
    expect(r).not.toBeNull();
    expect(r).not.toBe(false);
    expect(f.lists).toBeGreaterThan(base);
    expect(f.calls).toHaveLength(1);
    stop();
  });

  test(`变更 ${c.name}：失败提示文案、仍 reload、返回 ${String(c.failed)}`, async () => {
    const { f, store, notify } = setup({ workspaces: [workspace()] });
    const stop = store.start();
    await settle();
    const base = f.lists;
    f.failMutation = new ApiError(409, { error: "session_running" });
    const r = await c.call(store);
    expect(r).toEqual(c.failed);
    expect(notify).toHaveBeenCalledWith(
      "有会话正在运行，先停止它再操作",
      "danger",
    );
    expect(f.lists).toBe(base + 1);
    stop();
  });
}

test("errorText：网络、已知错误码与兜底", () => {
  expect(errorText(new ApiError(0, null))).toBe("网络不通，请稍后重试");
  expect(errorText(new ApiError(404, { error: "not_found" }))).toBe(
    "已不存在，列表已刷新",
  );
  expect(
    errorText(new ApiError(404, { error: { code: "unknown_group" } })),
  ).toBe("分组不存在，列表已刷新");
  expect(errorText(new ApiError(500, { error: "boom" }))).toBe(
    "操作失败，请重试",
  );
  expect(errorText(new Error("x"))).toBe("操作失败，请重试");
});

test("stop：关流、不再写回、不再转发 viewing", async () => {
  const { f, store, events, stream, emit } = setup({
    workspaces: [workspace()],
  });
  const stop = store.start();
  await emit({ type: "snapshot", sessions: [session({ id: "a" })] });
  expect(store.getState().ready).toBe(true);
  stop();
  expect(stream().closed).toBe(true);
  const fired = events.fired;

  stream().handlers.onEvent({ type: "added", session: session({ id: "bb" }) });
  stream().handlers.onStatus?.("reconnecting");
  await settle();
  expect(store.getState().sessions.map((s) => s.id)).toEqual(["a"]);
  expect(events.fired).toBe(fired);

  store.setViewing(["a"]);
  expect(stream().viewingCalls).toEqual([]);
  expect(f.streams).toHaveLength(1);
});

test("stop：在飞的目录请求结果不写回（用不同的数据区分）", async () => {
  const old = workspace({ id: "w-old" });
  const { f, store, events } = setup({ workspaces: [old] });
  const stop = store.start();
  await settle();
  expect(store.getState().workspaces).toEqual([old]);

  f.hold = held();
  const pending = store.reload();
  stop();
  const fired = events.fired;
  f.workspaces = [workspace({ id: "w-new" })];
  f.hold.release();
  await pending;
  expect(store.getState().workspaces).toEqual([old]);
  expect(events.fired).toBe(fired);
});

test("stop：等着去抖的未知工作区补拉被取消", async () => {
  vi.useFakeTimers();
  const { f, store, emit } = setup({ workspaces: [workspace({ id: "w1" })] });
  const stop = store.start();
  await emit({ type: "snapshot", sessions: [] });
  const base = f.lists;

  await emit({ type: "added", session: session({ workspaceId: "w9" }) });
  stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.lists).toBe(base);
});

test("start → stop → start 能再次工作", async () => {
  const { f, store, emit } = setup({ workspaces: [workspace()] });
  const stop1 = store.start();
  await emit({ type: "snapshot", sessions: [session({ id: "a" })] });
  stop1();

  const stop2 = store.start();
  expect(f.streams).toHaveLength(2);
  expect(f.streams[0]?.closed).toBe(true);
  await settle();
  expect(store.getState().ready).toBe(false);

  await emit({ type: "snapshot", sessions: [session({ id: "b" })] }, 1);
  expect(store.getState().ready).toBe(true);
  expect(store.getState().sessions.map((s) => s.id)).toEqual(["b"]);

  store.setViewing(["b"]);
  expect(f.streams[1]?.viewingCalls).toEqual([["b"]]);
  stop2();
});
