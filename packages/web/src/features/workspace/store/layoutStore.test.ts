// 按工作区的布局 store：载入、默认窗口、上下文晚到、收敛、去抖保存与冲突、切换工作区。
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Result as ApiResult, Failure } from "../../../api/http";
import type { PutResult, Workbench } from "../../../api/layout";
import { panesOf } from "../model/l2";
import {
  emptyLayout,
  LAYOUT_VERSION,
  serializeLayout,
} from "../model/layoutDoc";
import type { Pane, Window, WindowState } from "../model/types";
import {
  createLayoutStore,
  type LayoutApi,
  type SessionBrief,
} from "./layoutStore";

const DIRS = [{ host: "server", path: "/w" }];
const SESSIONS: SessionBrief[] = [
  { id: "a", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
  { id: "b", updatedAt: "2026-01-02T00:00:00.000Z", archived: false },
  { id: "old", updatedAt: "2026-03-01T00:00:00.000Z", archived: true },
];

/** 一个可手动 resolve 的 promise，用来控制载入 / 保存的先后 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const putOk = (revision: number): PutResult => ({ ok: true, revision });

function setup(
  initial: Record<string, Workbench> = {
    ws1: { revision: 0, document: null },
    ws2: { revision: 0, document: null },
  },
) {
  const puts: {
    id: string;
    rev: number;
    doc: unknown;
    keepalive?: boolean;
  }[] = [];
  const notes: [string, string][] = [];
  const gets: string[] = [];
  let putImpl: (id: string, rev: number) => PutResult = (_, rev) =>
    putOk(rev + 1);
  const api: LayoutApi = {
    get: async (id) => {
      gets.push(id);
      return { ok: true, data: initial[id] ?? { revision: 0, document: null } };
    },
    put: async (id, rev, doc, keepalive) => {
      puts.push({ id, rev, doc, keepalive });
      return putImpl(id, rev);
    },
  };
  const store = createLayoutStore({
    api,
    debounceMs: 100,
    hostName: (id) => (id === "gpu" ? "GPU 机" : id),
    notify: (m, t) => notes.push([m, t]),
  });
  return {
    store,
    puts,
    notes,
    gets,
    onPut: (fn: (id: string, rev: number) => PutResult) => {
      putImpl = fn;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** 第 win 个窗口里所有窗格的对话标签 */
const chatTabs = (st: WindowState | undefined, win = 0) =>
  panesOf(st?.list[win] as Window)
    .flatMap((p) => p.tabs)
    .filter((t) => t.type === "chat");

const layoutOf = (windows: WindowState) => ({
  version: LAYOUT_VERSION,
  windows,
});

/** 一个窗口、一个对话窗格 + 一个终端窗格；对话标签显示 sid */
function docWith(sid: string | undefined): {
  version: number;
  windows: WindowState;
} {
  return layoutOf({
    list: [
      {
        id: "w1",
        focus: "p1",
        root: {
          dir: "row",
          sizes: [1, 1],
          children: [
            {
              pid: "p1",
              host: null,
              tabs: [
                sid === undefined
                  ? { id: "t1", type: "chat", ctab: "chat" }
                  : { id: "t1", type: "chat", ctab: "chat", sid },
              ],
              active: "t1",
            },
            {
              pid: "p2",
              host: "server",
              tabs: [{ id: "t2", type: "term", host: "server" }],
              active: "t2",
            },
          ],
        },
      },
    ],
    active: 0,
  });
}

test("载入空文档 + 给了目录与会话：补默认窗口（对话标签绑最新会话）并保存", async () => {
  const { store, puts } = setup();
  await store.setWorkspace("ws1");
  // 上下文没到齐：停在 loading，也不算有窗口
  expect(store.getState().status).toBe("loading");
  store.setDirectories("ws1", DIRS);
  expect(store.getState().status).toBe("loading");
  store.setSessions("ws1", SESSIONS);
  const st = store.getState();
  expect(st.status).toBe("ready");
  expect(st.dirty).toBe(true);
  // 默认窗口的对话标签绑最新会话，且是临时标签：单击别的会话直接替换它
  expect(chatTabs(st.doc.windows)[0]?.sid).toBe("b");
  expect(chatTabs(st.doc.windows)[0]?.temp).toBe(true);
  // 目录窗格在：本机 server
  expect(panesOf(st.doc.windows.list[0] as Window).map((p) => p.host)).toEqual([
    null,
    "server",
  ]);
  await vi.advanceTimersByTimeAsync(150);
  expect(puts).toHaveLength(1);
  expect(puts[0]?.id).toBe("ws1");
  expect(store.getState().dirty).toBe(false);
});

test("载入已有文档：第一次收敛把空对话标签绑到最新会话，之后用户新开的空对话标签不再被顶掉", async () => {
  const { store } = setup({
    ws1: {
      revision: 3,
      document: {
        version: LAYOUT_VERSION,
        windows: {
          list: [
            {
              id: "w1",
              focus: "p1",
              root: {
                pid: "p1",
                host: null,
                active: "t1",
                tabs: [{ id: "t1", type: "chat", ctab: "chat" }],
              },
            },
          ],
          active: 0,
        },
      },
    },
  });
  store.setDirectories("ws1", DIRS);
  await store.setWorkspace("ws1");
  store.setSessions("ws1", SESSIONS);
  expect(chatTabs(store.getState().doc.windows)[0]).toMatchObject({
    sid: "b",
    temp: true,
  });

  // 用户再点「+」开一个空对话标签；之后列表推送再来，它不能被绑走
  const pid = store.getState().doc.windows.list[0]?.focus as string;
  expect(store.addTab(pid, "chat")).toBe(true);
  store.setSessions("ws1", [
    ...SESSIONS,
    { id: "c", updatedAt: "2026-02-01T00:00:00.000Z", archived: false },
  ]);
  const tabs = chatTabs(store.getState().doc.windows);
  expect(tabs).toHaveLength(2);
  expect(tabs[1]?.sid).toBeUndefined();
});

test("上下文晚到：先载入，后给目录与会话才 ready", async () => {
  const { store, gets } = setup();
  await store.setWorkspace("ws1");
  expect(gets).toEqual(["ws1"]);
  expect(store.getState().status).toBe("loading");
  expect(store.getState().doc.windows.list).toHaveLength(0);
  store.setSessions("ws1", SESSIONS);
  expect(store.getState().status).toBe("loading");
  store.setDirectories("ws1", DIRS);
  expect(store.getState().status).toBe("ready");
  expect(store.getState().doc.windows.list).toHaveLength(1);
});

test("载入已有文档：直接 ready，不补默认窗口，也不保存", async () => {
  const { store, puts } = setup({
    ws1: { revision: 5, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  const st = store.getState();
  expect(st.status).toBe("ready");
  expect(st.revision).toBe(5);
  expect(st.dirty).toBe(false);
  expect(chatTabs(st.doc.windows)[0]?.sid).toBe("a");
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);
  await vi.advanceTimersByTimeAsync(300);
  expect(puts).toHaveLength(0);
});

test("setSessions 收敛：删掉的会话的对话标签被关", async () => {
  const { store } = setup({
    ws1: { revision: 1, document: docWith("gone") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  store.setSessions("ws1", SESSIONS);
  // 对话窗格随之消失，剩下的终端窗格不动
  const st = store.getState().doc.windows;
  expect(chatTabs(st)).toHaveLength(0);
  expect(panesOf(st.list[0] as Window).map((p) => p.pid)).toEqual(["p2"]);
  expect(store.getState().dirty).toBe(true);
});

test("setSessions(null) 不收敛", async () => {
  const { store } = setup({
    ws1: { revision: 1, document: docWith("gone") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  store.setSessions("ws1", null);
  expect(chatTabs(store.getState().doc.windows)[0]?.sid).toBe("gone");
  expect(store.getState().dirty).toBe(false);
});

test("去抖保存：连续变更只 PUT 一次，带 baseRevision；flush(true) 走 keepalive", async () => {
  const { store, puts } = setup({
    ws1: { revision: 7, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  store.setSessions("ws1", SESSIONS);
  store.setDirectories("ws1", DIRS);
  await vi.advanceTimersByTimeAsync(200);
  puts.length = 0;

  store.patchAfx("t1", { w: 300 });
  await vi.advanceTimersByTimeAsync(60);
  store.patchAfx("t1", { w: 320 });
  expect(puts).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(150);
  expect(puts).toHaveLength(1);
  expect(puts[0]?.rev).toBe(store.getState().revision - 1);

  store.patchAfx("t1", { w: 340 });
  await store.flush(true);
  expect(puts).toHaveLength(2);
  expect(puts[1]?.keepalive).toBe(true);
});

test("409：采用服务端文档并提示", async () => {
  const { store, notes, onPut } = setup();
  await store.setWorkspace("ws1");
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);
  await vi.advanceTimersByTimeAsync(200);
  onPut(() => ({
    ok: false,
    kind: "conflict",
    current: { revision: 9, document: docWith("a") },
  }));
  store.patchAfx("t1", { w: 300 });
  await vi.advanceTimersByTimeAsync(150);
  const st = store.getState();
  expect(st.revision).toBe(9);
  expect(chatTabs(st.doc.windows)[0]?.sid).toBe("a");
  expect(st.dirty).toBe(false);
  expect(notes.some(([m, t]) => m.includes("最新版本") && t === "warn")).toBe(
    true,
  );
});

test("保存失败只提示一次，下次变更重试", async () => {
  const { store, notes, puts, onPut } = setup({
    ws1: { revision: 1, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  store.setSessions("ws1", SESSIONS);
  store.setDirectories("ws1", DIRS);
  await vi.advanceTimersByTimeAsync(200);
  puts.length = 0;
  onPut(() => ({ ok: false, kind: "network" }));
  store.patchAfx("t1", { w: 300 });
  await vi.advanceTimersByTimeAsync(150);
  store.patchAfx("t1", { w: 320 });
  await vi.advanceTimersByTimeAsync(150);
  expect(puts).toHaveLength(2);
  expect(notes.filter(([m]) => m.includes("保存失败"))).toHaveLength(1);
  expect(store.getState().dirty).toBe(true);
});

test("版本比客户端新：blocked，不保存", async () => {
  const { store, puts } = setup({
    ws1: { revision: 3, document: { version: LAYOUT_VERSION + 1 } },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  expect(store.getState().status).toBe("blocked");
  expect(store.addWindow()).toBe(false);
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);
  await vi.advanceTimersByTimeAsync(300);
  expect(puts).toHaveLength(0);
});

test("超过预算不发请求并提示", async () => {
  const notes: [string, string][] = [];
  const store = createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: null } }),
      put: async (_id, rev) => putOk(rev + 1),
    },
    debounceMs: 100,
    maxBytes: 50,
    notify: (m, t) => notes.push([m, t]),
  });
  await store.setWorkspace("ws1");
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);
  await vi.advanceTimersByTimeAsync(150);
  expect(notes.some(([m, t]) => m.includes("256KB") && t === "danger")).toBe(
    true,
  );
  expect(store.getState().dirty).toBe(true);
});

test("切换工作区：旧文档先存到旧 id，再载入新文档", async () => {
  const { store, puts, gets } = setup({
    ws1: { revision: 2, document: docWith("a") },
    ws2: { revision: 6, document: docWith("b") },
  });
  await store.setWorkspace("ws1");
  store.setSessions("ws1", SESSIONS);
  store.patchAfx("t1", { w: 300 });
  await store.setWorkspace("ws2");
  expect(puts).toHaveLength(1);
  expect(puts[0]?.id).toBe("ws1");
  expect(puts[0]?.rev).toBe(2);
  expect(gets).toEqual(["ws1", "ws2"]);
  const st = store.getState();
  expect(st.workspaceId).toBe("ws2");
  expect(st.status).toBe("ready");
  expect(st.revision).toBe(6);
  expect(chatTabs(st.doc.windows)[0]?.sid).toBe("b");
  expect(st.dirty).toBe(false);
});

test("切换工作区：新工作区的会话列表先到，也不会收敛旧文档，旧文档原样存回旧 id", async () => {
  const { store, puts } = setup({
    ws1: { revision: 2, document: docWith("a") },
    ws2: { revision: 6, document: docWith("b") },
  });
  await store.setWorkspace("ws1");
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);
  store.patchAfx("t1", { w: 300 });
  // 与 LayoutProvider 的 effect 顺序一致：先 setWorkspace，同一轮里新工作区的上下文紧跟着到
  const switching = store.setWorkspace("ws2");
  store.setDirectories("ws2", DIRS);
  store.setSessions("ws2", [SESSIONS[1] as SessionBrief]);
  await switching;
  expect(puts).toHaveLength(1);
  const [first] = puts as unknown as [
    { id: string; doc: { windows: WindowState } },
  ];
  expect(first.id).toBe("ws1");
  const saved = first.doc.windows;
  expect(chatTabs(saved).map((t) => t.sid)).toEqual(["a"]);
  // 新工作区自己的文档按它自己的会话列表收敛
  expect(chatTabs(store.getState().doc.windows).map((t) => t.sid)).toEqual([
    "b",
  ]);
});

test("hasSession：只认当前工作区的会话（含刚新建、列表还没带上的）", async () => {
  const { store } = setup();
  await store.setWorkspace("ws1");
  store.setSessions("ws1", SESSIONS);
  expect(store.hasSession("a")).toBe(true);
  expect(store.hasSession("elsewhere")).toBe(false);
  store.adoptSession("fresh");
  expect(store.hasSession("fresh")).toBe(true);
  await store.setWorkspace("ws2");
  expect(store.hasSession("a")).toBe(false);
});

test("切换途中的过期载入结果被丢弃（后到的旧结果不覆盖）", async () => {
  const first = deferred<ApiResult<Workbench>>();
  const second = deferred<ApiResult<Workbench>>();
  let calls = 0;
  const store = createLayoutStore({
    api: {
      get: () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
      put: async () => ({ ok: false, kind: "network" }),
    },
    notify: () => {},
  });
  const toFirst = store.setWorkspace("ws1");
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toBe(1);
  const toSecond = store.setWorkspace("ws2");
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toBe(2);
  second.resolve({ ok: true, data: { revision: 4, document: docWith("b") } });
  await toSecond;
  // 先切走、后落地的旧载入结果被丢弃
  first.resolve({ ok: true, data: { revision: 1, document: docWith("a") } });
  await toFirst;
  const st = store.getState();
  expect(st.workspaceId).toBe("ws2");
  expect(st.revision).toBe(4);
  expect(chatTabs(st.doc.windows)[0]?.sid).toBe("b");
});

test("setWorkspace(null)：回到 idle 空文档", async () => {
  const { store } = setup({
    ws1: { revision: 1, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  await store.setWorkspace(null);
  const st = store.getState();
  expect(st.workspaceId).toBeNull();
  expect(st.status).toBe("idle");
  expect(st.doc).toEqual(emptyLayout());
});

test("同一个 id 重复 setWorkspace 是空操作", async () => {
  const { store, gets } = setup({
    ws1: { revision: 1, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  await store.setWorkspace("ws1");
  expect(gets).toEqual(["ws1"]);
});

test("载入失败：status=error 并带上原因", async () => {
  const failure: Failure = { kind: "network" };
  const store = createLayoutStore({
    api: {
      get: async () => ({ ok: false, ...failure }),
      put: async (_id, rev) => putOk(rev + 1),
    },
    notify: () => {},
  });
  await store.setWorkspace("ws1");
  expect(store.getState().status).toBe("error");
  expect(store.getState().error).toBe("network");
});

test("showSession / pinSession / viewing 经 store 走通", async () => {
  const { store } = setup({
    ws1: { revision: 1, document: docWith(undefined) },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  store.setSessions("ws1", SESSIONS);
  store.setDirectories("ws1", DIRS);
  await vi.advanceTimersByTimeAsync(200);
  expect(store.viewing()).toEqual(["b"]);

  expect(store.showSession("a")).toBe(true);
  expect(store.viewing()).toEqual(["a"]);
  const temp = chatTabs(store.getState().doc.windows)[0];
  expect(temp).toMatchObject({ sid: "a", temp: true });

  expect(store.pinSession("a")).toBe(true);
  const pinned = chatTabs(store.getState().doc.windows)[0];
  expect(pinned?.sid).toBe("a");
  expect(pinned?.temp).toBeUndefined();
});

test("anchorSession：正在显示的 → 窗口里任一对话标签的会话 → 最近的未归档会话 → null", async () => {
  const { store } = setup({
    ws1: { revision: 1, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  expect(store.anchorSession()).toBeNull();
  await store.setWorkspace("ws1");
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);
  expect(store.anchorSession()).toBe("a");

  // 当前标签换成空对话标签后，不再有「正在显示」的会话，但窗口里仍有对话标签引用的会话
  const pid = store.getState().doc.windows.list[0]?.focus as string;
  expect(store.addTab(pid, "chat")).toBe(true);
  const tabs = chatTabs(store.getState().doc.windows);
  expect(store.anchorSession()).toBe("a");

  // 所有对话标签都空了：落到最近的未归档会话（b，不是已归档的 old）
  expect(store.closeTab(pid, tabs[0]?.id as string)).toBe(true);
  expect(chatTabs(store.getState().doc.windows).map((t) => t.sid)).toEqual([
    undefined,
  ]);
  expect(store.anchorSession()).toBe("b");
});

test("adoptSession：新会话的标签在列表带上它之前不会被收敛关掉；列表带上后恢复正常收敛", async () => {
  const { store } = setup({
    ws1: { revision: 1, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);

  store.adoptSession("fresh");
  expect(store.showSession("fresh")).toBe(true);
  // 列表还没带上 fresh（比如推送稍慢）：再来一次列表更新，它的标签还在
  store.setSessions("ws1", [...SESSIONS]);
  expect(chatTabs(store.getState().doc.windows).map((t) => t.sid)).toContain(
    "fresh",
  );

  // 列表带上它之后，它就是普通会话了
  const withFresh = [
    ...SESSIONS,
    { id: "fresh", updatedAt: "2026-02-01T00:00:00.000Z", archived: false },
  ];
  store.setSessions("ws1", withFresh);
  expect(chatTabs(store.getState().doc.windows).map((t) => t.sid)).toContain(
    "fresh",
  );
  // 之后它被删：列表里没了，标签被关（不再被「登记」兜着）
  store.setSessions("ws1", SESSIONS);
  expect(
    chatTabs(store.getState().doc.windows).map((t) => t.sid),
  ).not.toContain("fresh");
});

test("viewing() 在 ready 之前是空数组", async () => {
  const { store } = setup({
    ws1: { revision: 1, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  expect(store.viewing()).toEqual([]);
});

test("addWindow：directories 为 null 时返回 false，有目录时新建默认窗口（空对话标签）", async () => {
  const { store } = setup({
    ws1: { revision: 1, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  expect(store.addWindow()).toBe(false);
  await store.setWorkspace("ws1");
  expect(store.addWindow()).toBe(false);
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);
  expect(store.addWindow()).toBe(true);
  const st = store.getState().doc.windows;
  expect(st.list).toHaveLength(2);
  expect(st.active).toBe(1);
  const [chat] = panesOf(st.list[1] as Window) as [Pane];
  expect(chat.tabs[0]?.sid).toBeUndefined();
});

test("窗口级动作失败转 toast：最后一个窗口不能关", async () => {
  const { store, notes } = setup({
    ws1: { revision: 1, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  expect(store.closeWindow(0)).toBe(false);
  expect(notes.at(-1)).toEqual(["这是最后一个窗口", "warn"]);
});

test("serialize 稳定：载入后收敛没有变化则不脏", async () => {
  const { store } = setup({
    ws1: { revision: 2, document: docWith("a") },
    ws2: { revision: 0, document: null },
  });
  await store.setWorkspace("ws1");
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", [
    { id: "a", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
  ]);
  expect(store.getState().dirty).toBe(false);
  expect(JSON.parse(serializeLayout(store.getState().doc))).toEqual(
    docWith("a"),
  );
});

test("切换工作区会等上一次保存落盘，响应不写进新工作区", async () => {
  const slow = deferred<PutResult>();
  const puts: { id: string; rev: number }[] = [];
  const store = createLayoutStore({
    api: {
      get: async (id) => ({
        ok: true,
        data: { revision: 0, document: id === "ws2" ? docWith("b") : null },
      }),
      put: async (id, rev) => {
        puts.push({ id, rev });
        return slow.promise;
      },
    },
    debounceMs: 100,
    notify: () => {},
  });
  await store.setWorkspace("ws1");
  store.setDirectories("ws1", DIRS);
  store.setSessions("ws1", SESSIONS);
  await vi.advanceTimersByTimeAsync(200);
  store.patchAfx("t1", { w: 300 });
  await vi.advanceTimersByTimeAsync(200);
  expect(puts).toHaveLength(1);
  const switching = store.setWorkspace("ws2");
  await vi.advanceTimersByTimeAsync(0);
  slow.resolve(putOk(11));
  await switching;
  const st = store.getState();
  // 旧工作区的 revision 没有灌进新工作区
  expect(st.workspaceId).toBe("ws2");
  expect(st.revision).toBe(0);
  expect(chatTabs(st.doc.windows)[0]?.sid).toBe("b");
});
