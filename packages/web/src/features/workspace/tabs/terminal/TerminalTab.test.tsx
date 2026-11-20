import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../../../../api/http";
import { applyFontSize } from "../../../../app/fontSize";
import { LayoutProvider } from "../../layoutContext";
import type { Tab } from "../../model/types";
import { createLayoutStore } from "../../store/layoutStore";
import { TabZoomProvider } from "../tabZoom";
import { TerminalTab } from "./TerminalTab";
import { bad, FakeSocket, ok, status } from "./testkit";

// xterm 要真实布局与 canvas，jsdom 里换成只记录调用的替身。
const xt = vi.hoisted(() => {
  class FakeTerm {
    cols = 80;
    rows = 24;
    written: Uint8Array[] = [];
    disposed = false;
    focused = false;
    // 字号热更新要能在运行时改：真实 xterm 的 options 是可写对象
    options: { fontSize?: number };
    dataCb: (d: string) => void = () => {};
    constructor(opts: { fontSize?: number } = {}) {
      this.options = { fontSize: opts.fontSize };
    }
    loadAddon() {}
    open() {}
    focus() {
      this.focused = true;
    }
    dispose() {
      this.disposed = true;
    }
    write(d: Uint8Array) {
      this.written.push(d);
    }
    reset() {}
    onData(cb: (d: string) => void) {
      this.dataCb = cb;
    }
    onResize() {}
    attachCustomKeyEventHandler() {}
    hasSelection() {
      return false;
    }
  }
  return { FakeTerm, all: [] as InstanceType<typeof FakeTerm>[] };
});
vi.mock("@xterm/xterm", () => ({
  Terminal: class extends xt.FakeTerm {
    constructor(opts: { fontSize?: number } = {}) {
      super(opts);
      xt.all.push(this);
    }
  },
}));
// fit() 的次数要能数：字号变了必须重新算列宽行高，否则新字号下 PTY 的尺寸是错的。
const fitCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fitCalls.n += 1;
    }
  },
}));

const api = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  getTerminal: vi.fn(),
  listTerminals: vi.fn(),
  openTerminalSocket: vi.fn(),
}));
vi.mock("../../../../api/terminals", () => api);

beforeEach(() => {
  xt.all = [];
  FakeSocket.all = [];
  fitCalls.n = 0;
  sessionStorage.clear();
  saveToken("tok");
  api.openTerminalSocket.mockImplementation((id: string) => new FakeSocket(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  // 字号是根元素上的全局状态，别让它漏进下一条用例
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
  for (const f of Object.values(api)) f.mockReset();
});

const tab = (over: Partial<Tab> = {}): Tab => ({
  id: "tab-1",
  type: "term",
  host: "server",
  cwd: "/work/app",
  ...over,
});

/** 终端要往创建请求里带工作区 id，所以挂在 LayoutProvider 里；setZoom 模拟 Ctrl+滚轮改了标签比例 */
function mount(t: Tab, extra: { onManage?: () => void } = {}) {
  const patchTab = vi.fn();
  const store = createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: null } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });
  const tree = (zoom: number) => (
    <LayoutProvider
      store={store}
      workspaceId="ws1"
      directories={null}
      sessions={null}
      hosts={[]}
    >
      <TabZoomProvider value={zoom}>
        <TerminalTab
          tab={t}
          pane={{ pid: "p1", host: null, tabs: [t], active: t.id }}
          sessionId="s1"
          active
          patchTab={patchTab}
          patchAfx={vi.fn()}
          close={vi.fn()}
          {...extra}
        />
      </TabZoomProvider>
    </LayoutProvider>
  );
  const view = render(tree(1));
  return { patchTab, setZoom: (z: number) => view.rerender(tree(z)) };
}

const connected = async () => {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  return FakeSocket.last;
};

test("有 termId：按 id 接回并回放最近输出，不创建新终端", async () => {
  const { patchTab } = mount(tab({ termId: "t-abcdef12" }));
  const ws = await connected();
  expect(ws.id).toBe("t-abcdef12");
  ws.serve({ type: "ready", cols: 80, rows: 24 });
  ws.serveBytes(new TextEncoder().encode("$ "));
  await waitFor(() => expect(xt.all[0]?.written).toHaveLength(1));
  // 连上之后终端占满窗格：没有任何状态条、提示或说明层
  expect(screen.queryByRole("status")).toBeNull();
  expect(document.querySelector(".ws-term-note")).toBeNull();
  expect(api.createTerminal).not.toHaveBeenCalled();
  expect(patchTab).not.toHaveBeenCalled();
});

test("键盘输入经 WebSocket 发往终端", async () => {
  mount(tab({ termId: "t-1" }));
  const ws = await connected();
  ws.serve({ type: "ready", cols: 80, rows: 24 });
  xt.all[0]?.dataCb("ls\r");
  expect(ws.sent).toContainEqual({ type: "input", data: "ls\r" });
});

test("没有 termId：首次创建并把 id 写回 tab，请求带工作区 id", async () => {
  api.createTerminal.mockResolvedValue(ok(status("t-new")));
  const { patchTab } = mount(tab());
  await waitFor(() =>
    expect(patchTab).toHaveBeenCalledWith({
      termId: "t-new",
      termEnded: false,
    }),
  );
  expect(api.createTerminal).toHaveBeenCalledTimes(1);
  expect(api.createTerminal.mock.calls[0]?.[1]).toMatchObject({
    environmentId: "local",
    cwd: "/work/app",
    sessionId: "s1",
    workspaceId: "ws1",
  });
});

test("接回遇到 404：显示已结束（含 id、cwd、原因），且没有创建新终端", async () => {
  api.getTerminal.mockResolvedValue(bad("not_found"));
  const { patchTab } = mount(tab({ termId: "t-gone0001" }));
  (await connected()).drop();

  await screen.findByText("终端已结束");
  expect(patchTab).toHaveBeenCalledWith({ termEnded: true });
  expect(screen.getByText(/服务端重启或终端已被关闭/)).toBeTruthy();
  // 说明卡片里要有 id 末段和 cwd（头部也各有一份，所以限定在卡片内查）
  const card = within(screen.getByRole("status"));
  expect(card.getByText(/#gone0001/)).toBeTruthy();
  expect(card.getByText(/\/work\/app/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新打开" })).toBeTruthy();
  expect(api.createTerminal).not.toHaveBeenCalled();
});

test("已标记结束的 tab（刷新后）：直接展示已结束态，不接回也不创建", async () => {
  mount(tab({ termId: "t-old", termEnded: true }));
  await screen.findByText("终端已结束");
  await new Promise((r) => setTimeout(r, 20));
  expect(api.createTerminal).not.toHaveBeenCalled();
  expect(FakeSocket.all).toHaveLength(0);
});

test("点「重新打开」：创建新终端、替换 termId、清除 termEnded", async () => {
  api.createTerminal.mockResolvedValue(ok(status("t-2")));
  const { patchTab } = mount(tab({ termId: "t-old", termEnded: true }));
  fireEvent.click(await screen.findByRole("button", { name: "重新打开" }));
  await waitFor(() =>
    expect(patchTab).toHaveBeenCalledWith({ termId: "t-2", termEnded: false }),
  );
  expect(api.createTerminal).toHaveBeenCalledTimes(1);
  expect((await connected()).id).toBe("t-2");
});

test("创建返回 429：提示「终端数量已达上限（N）」并提供终端管理入口", async () => {
  api.createTerminal.mockResolvedValue(
    bad("rate_limited", { retryAfter: null }),
  );
  api.listTerminals.mockResolvedValue(
    ok(Array.from({ length: 32 }, (_, i) => status(`t-${i}`))),
  );
  const onManage = vi.fn();
  mount(tab(), { onManage });
  await screen.findByText("终端数量已达上限（32）");
  fireEvent.click(screen.getByRole("button", { name: "终端管理" }));
  expect(onManage).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});

test("断线后详情仍在：重连的是同一个 id，没有创建新终端", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1")));
  mount(tab({ termId: "t-1" }));
  const ws = await connected();
  ws.serve({ type: "ready", cols: 80, rows: 24 });
  ws.drop();
  await screen.findByText(/连接中断，重连 1\//);
  await waitFor(() => expect(FakeSocket.all).toHaveLength(2), {
    timeout: 3000,
  });
  expect(FakeSocket.last.id).toBe("t-1");
  expect(api.createTerminal).not.toHaveBeenCalled();
});

test("卸载只断开连接，不杀服务端终端", async () => {
  mount(tab({ termId: "t-1" }));
  const ws = await connected();
  cleanup();
  expect(ws.closed).toBe(true);
  expect(api.closeTerminal).not.toHaveBeenCalled();
  expect(xt.all[0]?.disposed).toBe(true);
});

test("字号：新建终端取代码档（兜底 14px）", async () => {
  applyFontSize({ base: 20, read: null, code: null });
  mount(tab({ termId: "t-1" }));
  await connected();
  await waitFor(() => expect(xt.all[0]?.options.fontSize).toBe(17.5));
});

test("字号：设置变了，已开的终端同步 options.fontSize 并重新 fit", async () => {
  mount(tab({ termId: "t-1" }));
  await connected();
  await waitFor(() => expect(xt.all[0]?.options.fontSize).toBe(14));

  // doFit 在 0 尺寸时会跳过（后台标签），jsdom 默认没有布局，这里给个尺寸让 fit 真的跑
  const box = document.querySelector(".ws-term-screen") as HTMLElement;
  Object.defineProperty(box, "clientWidth", { value: 800 });
  Object.defineProperty(box, "clientHeight", { value: 400 });
  const before = fitCalls.n;

  applyFontSize({ base: 22, read: null, code: null });
  expect(xt.all[0]?.options.fontSize).toBe(19.5);
  expect(fitCalls.n).toBe(before + 1);
});

test("标签缩放：字号 = 代码档 × 比例（取到半像素），比例变了同步 options.fontSize 并重新 fit；回到 100% 还原", async () => {
  const { setZoom } = mount(tab({ termId: "t-1" }));
  await connected();
  await waitFor(() => expect(xt.all[0]?.options.fontSize).toBe(14));
  const box = document.querySelector(".ws-term-screen") as HTMLElement;
  Object.defineProperty(box, "clientWidth", { value: 800 });
  Object.defineProperty(box, "clientHeight", { value: 400 });

  const before = fitCalls.n;
  setZoom(1.5);
  expect(xt.all[0]?.options.fontSize).toBe(21);
  expect(fitCalls.n).toBe(before + 1);
  setZoom(1.1);
  expect(xt.all[0]?.options.fontSize).toBe(15.5);
  setZoom(1);
  expect(xt.all[0]?.options.fontSize).toBe(14);
});

test("标签缩放：设置里的字号变了，新字号也要乘上当前比例", async () => {
  const { setZoom } = mount(tab({ termId: "t-1" }));
  await connected();
  await waitFor(() => expect(xt.all[0]?.options.fontSize).toBe(14));
  setZoom(1.5);
  applyFontSize({ base: 22, read: null, code: null });
  expect(xt.all[0]?.options.fontSize).toBe(29.5);
});

test("字号：卸载后不再收通知（避免改字号时碰到已销毁的实例）", async () => {
  mount(tab({ termId: "t-1" }));
  await connected();
  const term = xt.all[0];
  cleanup();
  applyFontSize({ base: 22, read: null, code: null });
  expect(term?.options.fontSize).toBe(14);
});
