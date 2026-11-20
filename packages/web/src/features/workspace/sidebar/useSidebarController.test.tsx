// 真左轨的控制器：库数据 → 模型的映射，以及点选 / 新建 / 归档 / 删除 / 改名 / 分组这些动作怎么落到接口与布局上。

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, saveToken } from "../../../api/http";
import type { LibrarySession } from "../../../api/sessionLibrary";
import type { Workspace } from "../../../api/workspaces";
import { clearToasts, ToastHost } from "../../../ui";
import { ChatProvider } from "../../chat";
import { LayoutBridge } from "../LayoutBridge";
import { getDrag } from "../layout/drag";
import { LibraryProvider } from "../library/LibraryProvider";
import type { LibraryState, LibraryStore } from "../library/libraryStore";
import { panesOf } from "../model/l2";
import type { WindowState } from "../model/types";
import { createLayoutStore } from "../store/layoutStore";
import type { SidebarController } from "./controller";
import { SessionRows } from "./SessionRows";
import { Sidebar } from "./Sidebar";
import { useSidebarController } from "./useSidebarController";
import { WorkspaceBlock } from "./WorkspaceBlock";

const api = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  patchLibrarySession: vi.fn(),
  refreshContext: vi.fn(),
  sessionAction: vi.fn(),
  createSessionWithConfig: vi.fn(),
  workspaceRemovalPreview: vi.fn(),
}));
vi.mock("../../../api/sessionLibrary", async (orig) => ({
  ...(await orig<typeof import("../../../api/sessionLibrary")>()),
  deleteSession: api.deleteSession,
  patchLibrarySession: api.patchLibrarySession,
  refreshContext: api.refreshContext,
  sessionAction: api.sessionAction,
}));
vi.mock("../../../api/sessionConfig", async (orig) => ({
  ...(await orig<typeof import("../../../api/sessionConfig")>()),
  createSessionWithConfig: api.createSessionWithConfig,
}));
vi.mock("../../../api/workspaces", async (orig) => ({
  ...(await orig<typeof import("../../../api/workspaces")>()),
  workspaceRemovalPreview: api.workspaceRemovalPreview,
}));

const NOW = "2026-11-05T08:00:00.000Z";

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: `工作区 ${id}`,
  description: "",
  groupId: null,
  archived: false,
  pinned: false,
  order: 0,
  defaults: {},
  reviewPolicy: { mode: "append", text: "" },
  directories: [
    {
      id: `d-${id}`,
      name: id,
      path: `/w/${id}`,
      environmentId: "local",
      role: "local",
    },
  ],
  sessionCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const sess = (
  id: string,
  workspaceId: string,
  over: Partial<LibrarySession> = {},
): LibrarySession =>
  ({
    id,
    title: `会话 ${id}`,
    no: null,
    name: null,
    status: "idle",
    lifecycle: "active",
    workspaceId,
    parentSessionId: null,
    forkEntryId: null,
    unreadResult: false,
    unreadError: false,
    createdAt: NOW,
    updatedAt: NOW,
    running: false,
    directoryId: null,
    promptPresetId: null,
    modePresetIds: [],
    activeModeId: null,
    ...over,
  }) as LibrarySession;

const GROUP = { id: "g1", name: "主线", tone: 1, collapsed: false, order: 0 };
const GROUP2 = { id: "g2", name: "实验", tone: 2, collapsed: true, order: 1 };

function initialState(): LibraryState {
  return {
    workspaces: [
      ws("w1", { groupId: "g1" }),
      ws("w2"),
      ws("w3", { archived: true }),
    ],
    groups: [GROUP, GROUP2],
    sessions: [
      sess("s1", "w1", { status: "running" }),
      sess("s2", "w1", { status: "blocked", unreadResult: true }),
      sess("s3", "w1", { parentSessionId: "s2" }),
      sess("s4", "w1", { lifecycle: "archived" }),
      sess("s5", "w2", { unreadError: true }),
    ],
    ready: true,
    live: true,
    failed: false,
  };
}

function fakeLibrary() {
  let state = initialState();
  const subs = new Set<() => void>();
  const set = (patch: Partial<LibraryState>) => {
    state = { ...state, ...patch };
    for (const cb of [...subs]) cb();
  };
  const store = {
    getState: () => state,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    start: () => () => {},
    reload: vi.fn(async () => {}),
    setViewing: vi.fn(),
    patchWorkspace: vi.fn(async (id: string) => ws(id)),
    patchGroup: vi.fn(async () => GROUP),
    reorderWorkspaces: vi.fn(async () => true),
    createGroup: vi.fn(async () => ({ ...GROUP, id: "g-new", name: "新组" })),
    deleteWorkspace: vi.fn(async () => true),
    deleteGroup: vi.fn(async () => true),
  };
  return { store: store as unknown as LibraryStore, raw: store, set };
}

const fakeLayout = () =>
  createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: null } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 60_000,
    notify: () => {},
  });

/** 当前窗口里显示 sid 的对话标签 */
function findChat(windows: WindowState, sid: string) {
  const win = windows.list[windows.active];
  return win
    ? panesOf(win)
        .flatMap((p) => p.tabs)
        .find((t) => t.type === "chat" && t.sid === sid)
    : undefined;
}

let ctl: SidebarController;
let renders = 0;
const openDialog = vi.fn();
function Probe() {
  renders += 1;
  ctl = useSidebarController({
    openDialog,
    openSettings: vi.fn(),
    openOverview: vi.fn(),
    hostLabel: (id) => id,
  });
  return null;
}

const click = (init: Partial<ReactMouseEvent> = {}) =>
  ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...init,
  }) as ReactMouseEvent;

async function mount() {
  const lib = fakeLibrary();
  const layout = fakeLayout();
  const view = render(
    <ChatProvider token="tok" onUnauthorized={() => {}}>
      <LibraryProvider store={lib.store}>
        <LayoutBridge
          token="tok"
          store={layout}
          hosts={[]}
          toHostId={(e) => (e === "local" ? "server" : e)}
        >
          <Probe />
        </LayoutBridge>
      </LibraryProvider>
    </ChatProvider>,
  );
  // 当前工作区落到第一个未归档的 w1，布局载入并补好默认窗口
  await act(async () => {});
  await act(async () => {});
  return { lib, layout, view };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  saveToken("tok");
  for (const fn of Object.values(api)) fn.mockReset();
  openDialog.mockReset();
});
afterEach(() => {
  cleanup();
  clearToasts();
});

test("库数据映射成模型：分组分区、已归档工作区单列、会话按服务端顺序、fork 挂父会话、未读与聚合", async () => {
  await mount();
  expect(ctl.currentWorkspace).toBe("w1");
  expect(
    ctl.sections.map((s) => [s.group?.id ?? null, s.list.map((w) => w.id)]),
  ).toEqual([
    ["g1", ["w1"]],
    [null, ["w2"]],
  ]);
  expect(ctl.archivedWorkspaces.map((w) => w.id)).toEqual(["w3"]);
  const w1 = ctl.workspaces.find((w) => w.id === "w1");
  expect(w1?.sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  expect(w1?.sessions.find((s) => s.id === "s3")?.parent).toBe("s2");
  expect(w1?.sessions.find((s) => s.id === "s4")?.archived).toBe(true);
  expect(w1?.sessions.find((s) => s.id === "s2")?.unread).toBe("result");
  expect(ctl.aggOf(w1 as never)).toEqual({
    blocked: 1,
    running: 1,
    total: 3,
    unread: "result",
  });
  const w2 = ctl.workspaces.find((w) => w.id === "w2");
  expect(w2?.sessions[0]?.unread).toBe("error");
  expect(ctl.loading).toBe(false);
});

test("推送增量不按顺序到达：会话按更新时间倒序，同刻按 id", async () => {
  const { lib } = await mount();
  await act(async () => {
    lib.set({
      sessions: [
        ...initialState().sessions,
        sess("s0", "w1", { updatedAt: "2026-11-05T07:00:00.000Z" }),
        sess("s9", "w1", { updatedAt: "2026-11-05T09:00:00.000Z" }),
      ],
    });
  });
  const w1 = ctl.workspaces.find((w) => w.id === "w1");
  expect(w1?.sessions.map((s) => s.id)).toEqual([
    "s9",
    "s1",
    "s2",
    "s3",
    "s4",
    "s0",
  ]);
});

test("搜索只留命中的工作区与会话；分组折叠来自服务端，toggleGroup 取反写回", async () => {
  const { lib } = await mount();
  expect(ctl.groupClosed.has("g2")).toBe(true);
  expect(ctl.groupClosed.has("g1")).toBe(false);
  act(() => ctl.toggleGroup("g1"));
  expect(lib.raw.patchGroup).toHaveBeenCalledWith("g1", { collapsed: true });
  act(() => ctl.toggleGroup("g2"));
  expect(lib.raw.patchGroup).toHaveBeenLastCalledWith("g2", {
    collapsed: false,
  });

  act(() => ctl.setQuery("会话 s5"));
  expect(ctl.sections.flatMap((s) => s.list.map((w) => w.id))).toEqual(["w2"]);
  act(() => ctl.setQuery("没有这个"));
  expect(ctl.sections).toEqual([]);
});

test("单击当前工作区的会话：临时打开；双击：固定", async () => {
  const { layout } = await mount();
  const chatTab = (sid: string) => findChat(layout.getState().doc.windows, sid);

  act(() => ctl.pickSession("s2", click()));
  await act(async () => {});
  expect(layout.viewing()).toEqual(["s2"]);
  expect(ctl.currentSession).toBe("s2");
  expect(ctl.viewing.has("s2")).toBe(true);
  expect(chatTab("s2")?.temp).toBe(true);

  act(() => ctl.pinSession("s2"));
  await act(async () => {});
  expect(chatTab("s2")).toBeDefined();
  expect(chatTab("s2")?.temp).toBeUndefined();
});

test("点另一个工作区的会话：先切工作区，等那份布局载入后打开", async () => {
  const { layout } = await mount();
  act(() => ctl.pickSession("s5", click()));
  await act(async () => {});
  await act(async () => {});
  expect(ctl.currentWorkspace).toBe("w2");
  expect(layout.getState().workspaceId).toBe("w2");
  expect(layout.viewing()).toEqual(["s5"]);
});

test("点工作区：切过去并展开；ctrl 加选、shift 按显示顺序选区间", async () => {
  await mount();
  act(() => ctl.pickWorkspace("w2", click()));
  expect(ctl.currentWorkspace).toBe("w2");
  expect(ctl.open.has("w2")).toBe(true);

  // 普通点击打开的那个（w2）也算选中：第一次 ctrl 点别的，选择是「当前 + 新点的」
  act(() => ctl.pickWorkspace("w1", click({ ctrlKey: true })));
  expect(ctl.selection).toEqual({ kind: "workspace", ids: ["w2", "w1"] });
  act(() => ctl.pickWorkspace("w2", click({ shiftKey: true })));
  expect(ctl.selection).toEqual({ kind: "workspace", ids: ["w1", "w2"] });
  act(() => ctl.clearSelection());

  act(() => ctl.pickSession("s1", click({ metaKey: true })));
  act(() => ctl.pickSession("s3", click({ shiftKey: true })));
  expect(ctl.selection).toEqual({ kind: "session", ids: ["s1", "s2", "s3"] });
});

test("新对话：带工作区 id 建会话，登记后等推送带来它再打开", async () => {
  const { lib, layout } = await mount();
  api.createSessionWithConfig.mockResolvedValue({ id: "n1" });
  await act(async () => ctl.newSession("w1"));
  expect(api.createSessionWithConfig).toHaveBeenCalledWith("tok", {
    workspaceId: "w1",
  });
  // 库里还没有它：先不打开
  expect(layout.viewing()).not.toContain("n1");
  await act(async () => {
    lib.set({
      sessions: [...initialState().sessions, sess("n1", "w1")],
    });
  });
  await act(async () => {});
  expect(layout.viewing()).toEqual(["n1"]);
});

test("刷新上下文：原地，不新建也不跳转，成功给提示；运行中被拒时给提示、也不跳转", async () => {
  const { layout } = await mount();
  render(<ToastHost />);
  const before = layout.viewing();
  api.refreshContext.mockResolvedValue(sess("s1", "w1"));
  await act(async () => ctl.refreshContext("s1"));
  expect(api.refreshContext).toHaveBeenCalledWith("tok", "s1");
  expect(await screen.findByText(/已刷新上下文/)).toBeTruthy();
  expect(layout.viewing()).toEqual(before);

  api.refreshContext.mockRejectedValue(
    new ApiError(409, { error: "session_running" }),
  );
  await act(async () => ctl.refreshContext("s1"));
  expect(await screen.findByText(/有会话正在运行/)).toBeTruthy();
  expect(layout.viewing()).toEqual(before);
});

test("置顶：会话走会话接口，工作区走工作区接口，取消置顶传 false", async () => {
  const { lib } = await mount();
  api.patchLibrarySession.mockResolvedValue(sess("s1", "w1"));
  act(() => ctl.setSessionPinned("s1", true));
  expect(api.patchLibrarySession).toHaveBeenCalledWith("tok", "s1", {
    pinned: true,
  });
  act(() => ctl.setWorkspacePinned("w2", true));
  expect(lib.raw.patchWorkspace).toHaveBeenCalledWith("w2", { pinned: true });
  act(() => ctl.setWorkspacePinned("w2", false));
  expect(lib.raw.patchWorkspace).toHaveBeenLastCalledWith("w2", {
    pinned: false,
  });
});

test("归档与恢复调用对应接口；批量归档会话后清掉选择", async () => {
  await mount();
  api.sessionAction.mockResolvedValue(sess("s1", "w1"));
  act(() => ctl.archiveSessions(["s1", "s2"]));
  await act(async () => {});
  expect(api.sessionAction.mock.calls.map((c) => [c[1], c[2]])).toEqual([
    ["s1", "archive"],
    ["s2", "archive"],
  ]);
  act(() => ctl.restoreSessions(["s4"]));
  expect(api.sessionAction).toHaveBeenLastCalledWith("tok", "s4", "unarchive");

  // 恢复也清掉选择，和归档一致
  act(() => ctl.pickSession("s1", click({ ctrlKey: true })));
  expect(ctl.selection?.ids).toEqual(["s1"]);
  act(() => ctl.restoreSessions(["s1"]));
  expect(ctl.selection).toBeNull();
});

test("删除会话：确认框写明派生会话数，确认后逐个删除并关框；失败留框并给原因", async () => {
  await mount();
  act(() => ctl.askRemoveSessions(["s2"]));
  expect(ctl.confirm?.kind).toBe("session");
  expect(ctl.confirm?.kind === "session" && ctl.confirm.derived).toBe(1);

  api.deleteSession.mockResolvedValue(undefined);
  await act(async () => ctl.doConfirm());
  expect(api.deleteSession).toHaveBeenCalledWith("tok", "s2");
  expect(ctl.confirm).toBeNull();

  act(() => ctl.askRemoveSessions(["s1"]));
  api.deleteSession.mockRejectedValue(
    new ApiError(409, { error: "session_running" }),
  );
  await act(async () => ctl.doConfirm());
  expect(ctl.confirm).not.toBeNull();
  expect(ctl.confirmError).toBe("有会话正在运行，先停止它再操作");
});

test("删除工作区：先取影响预览；运行中直接提示；确认后删除，多选逐个确认", async () => {
  const { lib } = await mount();
  api.workspaceRemovalPreview.mockResolvedValue({
    running: true,
    sessions: 3,
    terminals: 0,
    directories: [],
  });
  await act(async () => ctl.askRemoveWorkspaces(["w1"]));
  expect(
    ctl.confirm?.kind === "workspace" && ctl.confirm.preview?.sessions,
  ).toBe(3);
  expect(ctl.confirmError).toBe("有会话正在运行，先停止它再删除。");
  act(() => ctl.closeConfirm());

  api.workspaceRemovalPreview.mockResolvedValue({
    running: false,
    sessions: 1,
    terminals: 0,
    directories: [],
  });
  act(() => ctl.pickWorkspace("w1", click({ ctrlKey: true })));
  act(() => ctl.pickWorkspace("w2", click({ ctrlKey: true })));
  await act(async () => ctl.askRemoveWorkspaces(ctl.selection?.ids ?? []));
  expect(ctl.confirm?.kind === "workspace" && ctl.confirm.ws.id).toBe("w1");
  await act(async () => ctl.doConfirm());
  expect(lib.raw.deleteWorkspace).toHaveBeenCalledWith("w1");
  // 紧接着问下一个
  expect(ctl.confirm?.kind === "workspace" && ctl.confirm.ws.id).toBe("w2");
  await act(async () => ctl.doConfirm());
  expect(lib.raw.deleteWorkspace).toHaveBeenLastCalledWith("w2");
  expect(ctl.confirm).toBeNull();
});

test("删除工作区失败：确认框留着（原因由库 store 的提示说明），不编造原因", async () => {
  const { lib } = await mount();
  api.workspaceRemovalPreview.mockResolvedValue({
    running: false,
    sessions: 1,
    terminals: 0,
    directories: [],
  });
  lib.raw.deleteWorkspace.mockResolvedValueOnce(false);
  await act(async () => ctl.askRemoveWorkspaces(["w2"]));
  await act(async () => ctl.doConfirm());
  expect(ctl.confirm).not.toBeNull();
  expect(ctl.confirmError).toBeNull();
  expect(ctl.confirmBusy).toBe(false);
});

test("改名：弹窗带当前名字，提交后写回；工作区同理", async () => {
  const { lib } = await mount();
  act(() => ctl.renameSession("s1"));
  expect(ctl.nameDialog?.initial).toBe("会话 s1");
  api.patchLibrarySession.mockResolvedValue(sess("s1", "w1"));
  act(() => ctl.nameDialog?.onSubmit("新名字"));
  expect(api.patchLibrarySession).toHaveBeenCalledWith("tok", "s1", {
    title: "新名字",
  });
  expect(ctl.nameDialog).toBeNull();

  act(() => ctl.renameWorkspace("w2"));
  expect(ctl.nameDialog?.initial).toBe("工作区 w2");
  act(() => ctl.nameDialog?.onSubmit("别名"));
  expect(lib.raw.patchWorkspace).toHaveBeenCalledWith("w2", { name: "别名" });
});

test("分组与归档：移入 / 移出分组、新建分组并加入、归档与恢复工作区", async () => {
  const { lib } = await mount();
  act(() => ctl.joinGroup(["w2"], "g1"));
  expect(lib.raw.patchWorkspace).toHaveBeenCalledWith("w2", { groupId: "g1" });
  act(() => ctl.joinGroup(["w2"], null));
  expect(lib.raw.patchWorkspace).toHaveBeenLastCalledWith("w2", {
    groupId: null,
  });

  act(() => ctl.newGroup(["w2"]));
  expect(ctl.nameDialog?.title).toBe("新建分组");
  await act(async () => ctl.nameDialog?.onSubmit("新组"));
  expect(lib.raw.createGroup).toHaveBeenCalledWith({ name: "新组" });
  expect(lib.raw.patchWorkspace).toHaveBeenLastCalledWith("w2", {
    groupId: "g-new",
  });

  act(() => ctl.archiveWorkspaces(["w2"], true));
  expect(lib.raw.patchWorkspace).toHaveBeenLastCalledWith("w2", {
    archived: true,
  });
  act(() => ctl.archiveWorkspaces(["w3"], false));
  expect(lib.raw.patchWorkspace).toHaveBeenLastCalledWith("w3", {
    archived: false,
  });
});

test("批量删除部分失败：框里只留下没删掉的，重试不会再碰已经删掉的", async () => {
  await mount();
  act(() => ctl.askRemoveSessions(["s1", "s2"]));
  api.deleteSession.mockImplementation(async (_t: string, id: string) => {
    if (id === "s2") throw new ApiError(409, { error: "session_running" });
  });
  await act(async () => ctl.doConfirm());
  expect(
    ctl.confirm?.kind === "session" && ctl.confirm.list.map((s) => s.id),
  ).toEqual(["s2"]);
  expect(ctl.confirmError).toBe("有会话正在运行，先停止它再操作");

  api.deleteSession.mockReset();
  api.deleteSession.mockResolvedValue(undefined);
  await act(async () => ctl.doConfirm());
  expect(api.deleteSession.mock.calls.map((c) => c[1])).toEqual(["s2"]);
  expect(ctl.confirm).toBeNull();
});

test("删除成功后清掉多选", async () => {
  await mount();
  act(() => ctl.pickSession("s1", click({ ctrlKey: true })));
  expect(ctl.selection?.ids).toEqual(["s1"]);
  act(() => ctl.askRemoveSessions(ctl.selection?.ids ?? []));
  api.deleteSession.mockResolvedValue(undefined);
  await act(async () => ctl.doConfirm());
  expect(ctl.selection).toBeNull();

  api.workspaceRemovalPreview.mockResolvedValue({
    running: false,
    sessions: 1,
    terminals: 0,
    directories: [],
  });
  act(() => ctl.pickWorkspace("w2", click({ ctrlKey: true })));
  await act(async () => ctl.askRemoveWorkspaces(ctl.selection?.ids ?? []));
  await act(async () => ctl.doConfirm());
  expect(ctl.selection).toBeNull();
});

test("拖会话行：登记会话拖拽物、视图跟着变；结束后清掉", async () => {
  await mount();
  expect(ctl.drag).toBeUndefined();
  act(() => ctl.dragSession({ dataTransfer: null } as never, "s2"));
  expect(getDrag()).toEqual({ kind: "session", sid: "s2" });
  expect(ctl.drag).toEqual({ session: "s2" });
  act(() => ctl.dragEnd());
  expect(getDrag()).toBeNull();
  expect(ctl.drag).toBeUndefined();
});

test("会话行可拖：开始拖登记拖拽物，松手清掉；已归档的行不可拖", async () => {
  await mount();
  const list = ctl.workspaces.find((w) => w.id === "w1")?.sessions ?? [];
  const { container } = render(<SessionRows list={list} c={ctl} />);
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".u-lrow"));
  const byLabel = (t: string) =>
    rows.find((r) => r.textContent?.includes(t)) as HTMLElement;

  expect(byLabel("会话 s4").getAttribute("draggable")).toBe("false");
  const row = byLabel("会话 s1");
  expect(row.getAttribute("draggable")).toBe("true");
  fireEvent.dragStart(row);
  expect(getDrag()).toEqual({ kind: "session", sid: "s1" });
  fireEvent.dragEnd(row);
  expect(getDrag()).toBeNull();
});

const dt = () => ({ dataTransfer: { setData() {}, effectAllowed: "" } });
const dragEvt = () => dt() as never;

test("工作区拖进分组：改分组，已在该组不发请求；拖到「未分组」移出；dragEnd 取消后落下无效", async () => {
  const { lib } = await mount();
  act(() => ctl.dragWorkspace(dragEvt(), "w2"));
  expect(ctl.drag).toEqual({ workspace: "w2" });
  act(() => ctl.dragOver({ group: "g1" }));
  expect(ctl.drag).toEqual({ workspace: "w2", over: { group: "g1" } });
  act(() => ctl.dropWorkspace({ group: "g1" }));
  expect(lib.raw.patchWorkspace).toHaveBeenCalledWith("w2", { groupId: "g1" });
  expect(ctl.drag).toBeUndefined();

  lib.raw.patchWorkspace.mockClear();
  act(() => ctl.dragWorkspace(dragEvt(), "w1"));
  act(() => ctl.dropWorkspace({ group: "g1" }));
  expect(lib.raw.patchWorkspace).not.toHaveBeenCalled();
  act(() => ctl.dragWorkspace(dragEvt(), "w1"));
  act(() => ctl.dropWorkspace({ group: null }));
  expect(lib.raw.patchWorkspace).toHaveBeenCalledWith("w1", { groupId: null });

  lib.raw.patchWorkspace.mockClear();
  act(() => ctl.dragWorkspace(dragEvt(), "w2"));
  act(() => ctl.dragEnd());
  act(() => ctl.dropWorkspace({ group: "g1" }));
  expect(lib.raw.patchWorkspace).not.toHaveBeenCalled();
});

test("工作区拖到另一个工作区前面：按整份显示顺序重排；跨组时顺带改成它的分组，同组不改", async () => {
  const { lib } = await mount();
  act(() => ctl.dragWorkspace(dragEvt(), "w2"));
  act(() => ctl.dropWorkspace({ before: "w1" }));
  expect(lib.raw.patchWorkspace).toHaveBeenCalledWith("w2", { groupId: "g1" });
  expect(lib.raw.reorderWorkspaces).toHaveBeenCalledWith(["w2", "w1"]);

  lib.raw.patchWorkspace.mockClear();
  lib.raw.reorderWorkspaces.mockClear();
  await act(async () =>
    lib.set({
      workspaces: initialState().workspaces.map((w) =>
        w.id === "w2" ? { ...w, groupId: "g1" } : w,
      ),
    }),
  );
  act(() => ctl.dragWorkspace(dragEvt(), "w1"));
  act(() => ctl.dropWorkspace({ before: "w2" }));
  expect(lib.raw.patchWorkspace).not.toHaveBeenCalled();
  expect(lib.raw.reorderWorkspaces).toHaveBeenCalledWith(["w1", "w2"]);

  // 落在自己身上：什么也不做
  lib.raw.reorderWorkspaces.mockClear();
  act(() => ctl.dragWorkspace(dragEvt(), "w1"));
  act(() => ctl.dropWorkspace({ before: "w1" }));
  expect(lib.raw.reorderWorkspaces).not.toHaveBeenCalled();
});

test("工作区头的拖放接线：可拖，拖起后别的头接受落点并出落点线，放下走到重排；已归档的不参与", async () => {
  const { lib } = await mount();
  const [w1, w2] = ctl.workspaces;
  const both = () => (
    <>
      <WorkspaceBlock ws={w1 as never} index={0} c={ctl} />
      <WorkspaceBlock ws={w2 as never} index={1} c={ctl} />
    </>
  );
  const view = render(both());
  const heads = () =>
    Array.from(view.container.querySelectorAll<HTMLElement>(".rl-wh"));
  expect(heads().map((h) => h.getAttribute("draggable"))).toEqual([
    "true",
    "true",
  ]);

  fireEvent.dragStart(heads()[1] as HTMLElement, dt());
  view.rerender(both());
  expect(ctl.drag).toEqual({ workspace: "w2" });
  fireEvent.dragOver(heads()[0] as HTMLElement, dt());
  view.rerender(both());
  expect(ctl.drag?.over).toEqual({ before: "w1" });
  expect(view.container.querySelectorAll(".rl-dropline")).toHaveLength(1);
  fireEvent.drop(heads()[0] as HTMLElement, dt());
  expect(lib.raw.reorderWorkspaces).toHaveBeenCalledWith(["w2", "w1"]);

  const archived = render(
    <WorkspaceBlock ws={w1 as never} index={0} c={ctl} archived />,
  );
  expect(
    archived.container.querySelector(".rl-wh")?.getAttribute("draggable"),
  ).toBe("false");
});

test("dragover 每几十毫秒就来一次：悬停在同一个落点上不重复渲染，换了落点才渲染", async () => {
  await mount();
  act(() => ctl.dragWorkspace(dragEvt(), "w2"));
  act(() => ctl.dragOver({ group: "g1" }));
  act(() => ctl.dragOver({ group: "g1" })); // React 对同值更新会多渲染一次再放弃，先让它稳定
  const before = renders;
  for (let i = 0; i < 5; i++) act(() => ctl.dragOver({ group: "g1" }));
  expect(renders).toBe(before);
  act(() => ctl.dragOver({ before: "w1" }));
  expect(renders).toBe(before + 1);
});

test("没在拖工作区时（比如拖着会话经过工作区头），工作区头不接受落点", async () => {
  await mount();
  const [w1] = ctl.workspaces;
  const view = render(<WorkspaceBlock ws={w1 as never} index={0} c={ctl} />);
  const head = view.container.querySelector(".rl-wh") as HTMLElement;
  // fireEvent 返回 false = 事件被 preventDefault（落点接受）
  expect(fireEvent.dragOver(head, dt())).toBe(true);

  act(() => ctl.dragWorkspace(dragEvt(), "w2"));
  view.rerender(<WorkspaceBlock ws={w1 as never} index={0} c={ctl} />);
  expect(fireEvent.dragOver(head, dt())).toBe(false);
});

test("工作区全都在组里时，拖着工作区才出现一个空的「未分组」落点，拖进去就移出分组", async () => {
  const { lib } = await mount();
  await act(async () =>
    lib.set({
      workspaces: initialState().workspaces.map((w) => ({
        ...w,
        groupId: "g1",
      })),
    }),
  );
  const show = () => (
    <Sidebar c={ctl} collapsed={false} onCollapsedChange={() => {}} />
  );
  const view = render(show());
  expect(view.container.querySelector(".rl-ungrouped")).toBeNull();

  act(() => ctl.dragWorkspace(dragEvt(), "w1"));
  view.rerender(show());
  const zone = view.container.querySelector(".rl-ungrouped") as HTMLElement;
  expect(zone).not.toBeNull();
  fireEvent.dragOver(zone, dt());
  fireEvent.drop(zone, dt());
  expect(lib.raw.patchWorkspace).toHaveBeenCalledWith("w1", { groupId: null });
});

test("拖到组尾的落点：排到该组最后（组内最后一个之后），本来就在最后就不动", async () => {
  const { lib } = await mount();
  await act(async () =>
    lib.set({
      workspaces: initialState().workspaces.map((w) => ({
        ...w,
        groupId: "g1",
      })),
    }),
  );
  const show = () => (
    <Sidebar c={ctl} collapsed={false} onCollapsedChange={() => {}} />
  );
  const view = render(show());
  expect(view.container.querySelector(".rl-dropend")).toBeNull();

  act(() => ctl.dragWorkspace(dragEvt(), "w1"));
  view.rerender(show());
  const end = view.container.querySelector(".rl-dropend") as HTMLElement;
  expect(end).not.toBeNull();
  fireEvent.dragOver(end, dt());
  view.rerender(show());
  expect(end.querySelector(".rl-dropline")).not.toBeNull();
  fireEvent.drop(end, dt());
  expect(lib.raw.patchWorkspace).not.toHaveBeenCalled();
  expect(lib.raw.reorderWorkspaces).toHaveBeenCalledWith(["w2", "w1"]);

  lib.raw.reorderWorkspaces.mockClear();
  act(() => ctl.dragWorkspace(dragEvt(), "w2"));
  act(() => ctl.dropWorkspace({ group: "g1" }));
  expect(lib.raw.reorderWorkspaces).not.toHaveBeenCalled();
});

test("编辑分组：弹窗带当前名称与颜色，提交后写回；分组不存在就不弹", async () => {
  const { lib } = await mount();
  act(() => ctl.editGroup("g1"));
  expect(ctl.groupDialog).toMatchObject({ name: "主线", tone: 1 });
  act(() => ctl.groupDialog?.onSubmit("主干", 4));
  expect(lib.raw.patchGroup).toHaveBeenCalledWith("g1", {
    name: "主干",
    tone: 4,
  });
  expect(ctl.groupDialog).toBeNull();

  act(() => ctl.editGroup("nope"));
  expect(ctl.groupDialog).toBeNull();
});

test("解散分组：确认框写明里面有几个工作区，确认后才删；失败留框", async () => {
  const { lib } = await mount();
  act(() => ctl.askRemoveGroup("g1"));
  expect(ctl.confirm).toMatchObject({ kind: "group", count: 1 });
  expect(lib.raw.deleteGroup).not.toHaveBeenCalled();
  lib.raw.deleteGroup.mockResolvedValueOnce(false);
  await act(async () => ctl.doConfirm());
  expect(lib.raw.deleteGroup).toHaveBeenCalledWith("g1");
  expect(ctl.confirm).not.toBeNull();
  await act(async () => ctl.doConfirm());
  expect(ctl.confirm).toBeNull();

  act(() => ctl.askRemoveGroup("g2"));
  expect(ctl.confirm).toMatchObject({ kind: "group", count: 0 });
});

test("弹窗入口：新建 / 编辑工作区、带配置新建、会话设置、以此配置新建都交给壳去开", async () => {
  await mount();
  act(() => ctl.newWorkspace());
  act(() => ctl.editWorkspace("w2"));
  act(() => ctl.newSessionWith("w1"));
  act(() => ctl.sessionSettings("s5"));
  act(() => ctl.newSessionFrom("s1"));
  act(() => ctl.sessionSettings("nope"));
  expect(openDialog.mock.calls.map((c) => c[0])).toEqual([
    { kind: "workspace", mode: "create" },
    { kind: "workspace", mode: "edit", workspaceId: "w2" },
    { kind: "session", mode: "create", workspaceId: "w1" },
    { kind: "session", mode: "edit", workspaceId: "w2", sessionId: "s5" },
    { kind: "session", mode: "from", workspaceId: "w1", sessionId: "s1" },
  ]);
});

test("右键：在选择之外的行上先清掉原来的选择；在选中的行上选择保留（菜单就是对整个选择的批量操作）", async () => {
  await mount();
  act(() => ctl.pickSession("s1", click({ ctrlKey: true })));
  act(() => ctl.pickSession("s2", click({ ctrlKey: true })));
  expect(ctl.selection?.ids).toEqual(["s1", "s2"]);

  act(() => ctl.setMenu({ kind: "session", id: "s2", x: 1, y: 1 }));
  expect(ctl.selection?.ids).toEqual(["s1", "s2"]);
  act(() => ctl.setMenu(null));
  expect(ctl.selection?.ids).toEqual(["s1", "s2"]);

  act(() => ctl.setMenu({ kind: "session", id: "s3", x: 1, y: 1 }));
  expect(ctl.selection).toBeNull();

  // 种类不同也算在选择之外
  act(() => ctl.pickSession("s1", click({ ctrlKey: true })));
  act(() => ctl.setMenu({ kind: "workspace", id: "w1", x: 1, y: 1 }));
  expect(ctl.selection).toBeNull();
});

test("批量删除工作区：askRemoveWorkspaces 先问第一个，确认后接着问下一个，全部确认完关框", async () => {
  const { lib } = await mount();
  api.workspaceRemovalPreview.mockResolvedValue({
    running: false,
    sessions: 1,
    terminals: 0,
    directories: [],
  });
  await act(async () => ctl.askRemoveWorkspaces(["w1", "w2"]));
  expect(ctl.confirm?.kind === "workspace" && ctl.confirm.ws.id).toBe("w1");
  await act(async () => ctl.doConfirm());
  expect(ctl.confirm?.kind === "workspace" && ctl.confirm.ws.id).toBe("w2");
  await act(async () => ctl.doConfirm());
  expect(
    lib.raw.deleteWorkspace.mock.calls.map((c: unknown[]) => c[0]),
  ).toEqual(["w1", "w2"]);
  expect(ctl.confirm).toBeNull();
  // 空列表什么都不做
  await act(async () => ctl.askRemoveWorkspaces([]));
  expect(ctl.confirm).toBeNull();
});

test("普通点击打开的会话也算选中：第一次 ctrl 点别的会话，选择是「当前打开的 + 新点的」；ctrl 点当前这个自己只选它；再点就是加减", async () => {
  await mount();
  act(() => ctl.pickSession("s1", click()));
  expect(ctl.currentSession).toBe("s1");
  expect(ctl.selection).toBeNull();

  act(() => ctl.pickSession("s2", click({ ctrlKey: true })));
  expect(ctl.selection).toEqual({ kind: "session", ids: ["s1", "s2"] });
  act(() => ctl.pickSession("s3", click({ metaKey: true })));
  expect(ctl.selection?.ids).toEqual(["s1", "s2", "s3"]);
  act(() => ctl.pickSession("s2", click({ ctrlKey: true })));
  expect(ctl.selection?.ids).toEqual(["s1", "s3"]);

  // 普通点击清掉选择；ctrl 点当前打开的这一个本身：只选它自己，不重复
  act(() => ctl.pickSession("s1", click()));
  expect(ctl.selection).toBeNull();
  act(() => ctl.pickSession("s1", click({ ctrlKey: true })));
  expect(ctl.selection?.ids).toEqual(["s1"]);
});

test("shift 点：没有点过别的（没有起点）时，从当前打开的会话算起", async () => {
  await mount();
  act(() => ctl.pickSession("s1", click()));
  act(() => ctl.pickSession("s3", click({ shiftKey: true })));
  expect(ctl.selection).toEqual({ kind: "session", ids: ["s1", "s2", "s3"] });
});
