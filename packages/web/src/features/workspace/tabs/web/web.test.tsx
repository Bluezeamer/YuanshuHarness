import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserEvent, PageView } from "../../../../api/browser";
import * as ui from "../../../../ui";
import { clearToasts, ToastHost } from "../../../../ui";
import {
  engineState,
  FakeSocket,
  limitsView,
  pageView,
} from "../../browser/testkit";
import { mount, paneByHost, q } from "../../layout/harness";
import type { RunState } from "../../layoutContext";
import { panesOf } from "../../model/l2";
import type { LayoutStore } from "../../store/layoutStore";
import { getTabDef, registerTab } from "../registry";
import { registerWebTab } from "./register";

// 网络层换掉：两条 WebSocket 用测试替身，请求类接口记录调用并给定返回。
const api = vi.hoisted(() => ({
  openPage: vi.fn(),
  wakePage: vi.fn(),
  closePage: vi.fn(),
  setControl: vi.fn(),
  ensureEngine: vi.fn(),
  answerHandoff: vi.fn(),
  fetchPendingDownload: vi.fn(),
  putPendingDownload: vi.fn(),
  discardPendingDownload: vi.fn(),
  uploadPageFiles: vi.fn(),
  cancelPageUpload: vi.fn(),
  answerPageDialog: vi.fn(),
  getLoginOffer: vi.fn(),
  saveLogin: vi.fn(),
  getPorts: vi.fn(),
  getForwards: vi.fn(),
  openForward: vi.fn(),
  closeForward: vi.fn(),
  getConsole: vi.fn(),
  getThumb: vi.fn(),
  getReplaySessions: vi.fn(),
  getReplaySteps: vi.fn(),
  getReplayFrame: vi.fn(),
}));
vi.mock("../../../../api/browser", async (orig) => {
  const real = await orig<typeof import("../../../../api/browser")>();
  const { FakeSocket } = await import("../../browser/testkit");
  return {
    ...real,
    ...api,
    openBrowserEvents: (wid: string) =>
      new FakeSocket(`events:${wid}`) as unknown as WebSocket,
    openPageStream: (wid: string, pid: string) =>
      new FakeSocket(`stream:${wid}/${pid}`) as unknown as WebSocket,
  };
});

const original = getTabDef("web");
const TITLES = new Map([["a", "修登录"]]);

const sock = (prefix: string) =>
  [...FakeSocket.all].reverse().find((s) => s.id.startsWith(prefix));
const events = () => sock("events:") as FakeSocket;
const stream = (pid: string) => sock(`stream:ws1/${pid}`) as FakeSocket;

const snapshot = (...pages: PageView[]): BrowserEvent => ({
  type: "snapshot",
  engine: engineState(),
  pages,
  limits: limitsView,
});

/** 事件流连上并给出首份快照。 */
function seed(...pages: PageView[]): void {
  act(() => events().open());
  act(() => events().serve(snapshot(...pages)));
}
const emit = (e: BrowserEvent) => act(() => events().serve(e));
/** 页面画面流连上，服务端报了 state（本窗口是不是操作窗口）。 */
function connect(page: PageView, operator = true): void {
  const s = stream(page.id);
  act(() => s.open());
  act(() => s.serve({ type: "state", page, operator }));
}

let store: LayoutStore;
const webTabs = () =>
  panesOf(store.getState().doc.windows.list[0] as never)
    .flatMap((p) => p.tabs)
    .filter((t) => t.type === "web");

/** 挂载并在 server 窗格里打开一个浏览器标签；page 是标签记着的页面。 */
async function open(
  page?: string,
  runStates?: ReadonlyMap<string, RunState>,
): Promise<void> {
  const m = await mount(undefined, TITLES, runStates);
  store = m.store;
  const pid = paneByHost("server").dataset.pid as string;
  act(() => {
    store.openTab(pid, "web", page ? { page } : {});
  });
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  FakeSocket.reset();
  clearToasts();
  for (const fn of Object.values(api)) fn.mockReset();
  api.getLoginOffer.mockResolvedValue({
    ok: true,
    data: { site: null, saved: false, offer: false },
  });
  api.getPorts.mockResolvedValue({ ok: true, data: [] });
  api.getForwards.mockResolvedValue({ ok: true, data: [] });
  api.getConsole.mockResolvedValue({ ok: true, data: [] });
  api.getThumb.mockResolvedValue(null);
  api.getReplaySessions.mockResolvedValue({ ok: true, data: [] });
  api.getReplaySteps.mockResolvedValue({ ok: true, data: [] });
  api.getReplayFrame.mockResolvedValue(null);
  registerWebTab();
});
afterEach(() => {
  cleanup();
  registerTab("web", original as never);
});

test("引擎报告机器上没有彩色 emoji 字体：标签顶部提示怎么装；有字体时没有这条提示", async () => {
  await open();
  act(() => events().open());
  const snap = (emojiFont: boolean | null): BrowserEvent => ({
    ...(snapshot() as Extract<BrowserEvent, { type: "snapshot" }>),
    engine: { ...engineState(), emojiFont },
  });
  act(() => events().serve(snap(true)));
  expect(screen.queryByText(/没有彩色 emoji 字体/)).toBeNull();
  act(() => events().serve(snap(false)));
  expect(screen.getByText(/没有彩色 emoji 字体/).textContent).toContain(
    "fonts-noto-color-emoji",
  );
  act(() => events().serve(snap(null)));
  expect(screen.queryByText(/没有彩色 emoji 字体/)).toBeNull();
});

test("没有页面：说明卡片里的「打开地址」打开页面列表；列表里开地址后标签显示新页面", async () => {
  await open();
  seed();
  expect(
    screen.getByText("还没有页面", { selector: ".t-entry, .u-empty *" }),
  ).toBeTruthy();
  fireEvent.click(button("打开地址"));
  const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });

  const fresh = pageView({ id: "pg1", userOpened: true, controller: "user" });
  api.openPage.mockImplementation(async () => {
    emit({ type: "page", event: { type: "added", page: fresh } });
    return { ok: true, data: { page: fresh, status: 200, deny: null } };
  });
  fireEvent.change(within(dialog).getByLabelText("打开地址"), {
    target: { value: "server:3000" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "打开" }));

  await waitFor(() => expect(webTabs()[0]?.page).toBe("pg1"));
  expect(api.openPage).toHaveBeenCalledWith(null, "ws1", "server:3000");
  // 列表收起；你自己的页面直接是手动态
  expect(screen.queryByRole("dialog", { name: "浏览器页面" })).toBeNull();
  expect(button("交给 agent")).toBeTruthy();
});

test("打开地址失败：原因留在列表里，不切页面", async () => {
  await open();
  seed();
  fireEvent.click(button("打开地址"));
  const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  api.openPage.mockResolvedValue({
    ok: false,
    status: 409,
    message: "激活的页面已达上限，先关掉一个",
  });
  fireEvent.change(within(dialog).getByLabelText("打开地址"), {
    target: { value: "server:3000" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "打开" }));
  expect(
    await within(dialog).findByText("激活的页面已达上限，先关掉一个"),
  ).toBeTruthy();
  expect(webTabs()[0]?.page).toBeUndefined();
});

test("观察态：agent 的页面地址只读，点「手动操作」请求接管", async () => {
  const p = pageView({
    id: "pg1",
    url: "http://server.localhost:3000/a",
    inUseBy: "a",
  });
  await open("pg1");
  seed(p);
  connect(p);
  const addr = screen.getByLabelText("页面地址") as HTMLInputElement;
  expect(addr.value).toBe("Server:3000/a");
  expect(addr.readOnly).toBe(true);
  expect(screen.queryByRole("button", { name: "后退" })).toBeNull();
  // 左下角小标：谁在用
  expect(screen.getByText("修登录 · 操作中")).toBeTruthy();

  api.setControl.mockResolvedValue({
    ok: true,
    data: { ...p, controller: "user" },
  });
  fireEvent.click(button("手动操作"));
  await waitFor(() =>
    expect(api.setControl).toHaveBeenCalledWith(null, "ws1", "pg1", "user"),
  );
});

test("手动态：后退 / 前进 / 刷新可用，回车导航走画面流，「交还 agent」还回去", async () => {
  const p = pageView({
    id: "pg1",
    url: "http://server.localhost:3000/",
    controller: "user",
  });
  await open("pg1");
  seed(p);
  connect(p);
  const addr = screen.getByLabelText("页面地址") as HTMLInputElement;
  expect(addr.readOnly).toBe(false);
  expect(screen.queryByText("另一个窗口正在操作这个页面")).toBeNull();
  fireEvent.click(button("刷新"));
  fireEvent.click(button("后退"));
  fireEvent.focus(addr);
  fireEvent.change(addr, { target: { value: "server:4000/x" } });
  fireEvent.keyDown(addr, { key: "Enter" });
  expect(stream("pg1").sent).toEqual([
    { type: "nav", action: "reload" },
    { type: "nav", action: "back" },
    { type: "nav", action: "goto", target: "server:4000/x" },
  ]);

  api.setControl.mockResolvedValue({
    ok: true,
    data: { ...p, controller: "agent" },
  });
  fireEvent.click(button("交还 agent"));
  await waitFor(() =>
    expect(api.setControl).toHaveBeenCalledWith(null, "ws1", "pg1", "agent"),
  );
});

test("手动态复制：按复制键请页面给出选中的文字，回来的文字写进本机剪贴板；没选中就什么都不做", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<ToastHost />);
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p);
  const sink = screen.getByLabelText("向页面输入文字");
  fireEvent.copy(sink);
  expect(stream("pg1").sent).toEqual([{ type: "copy" }]);

  act(() => stream("pg1").serve({ type: "copied", text: "页面里划选的字" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("页面里划选的字"));
  await screen.findByText("已复制");

  act(() => stream("pg1").serve({ type: "copied", text: "" }));
  await sleep(30);
  expect(writeText).toHaveBeenCalledTimes(1);
});

test("手动态复制：剪贴板写不进去时如实提示，不说已复制", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<ToastHost />);
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p);
  act(() => stream("pg1").serve({ type: "copied", text: "页面里划选的字" }));
  await screen.findByText("无法写入剪贴板");
  expect(screen.queryByText("已复制")).toBeNull();
});

test("页面自己写了剪贴板：写进本机剪贴板并提示复制了什么；写不进去如实说", async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<ToastHost />);
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p);
  act(() => stream("pg1").serve({ type: "clipboard", text: "分享链接  /s/1" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("分享链接  /s/1"));
  await screen.findByText("页面复制了：分享链接 /s/1");

  writeText.mockRejectedValueOnce(new Error("denied"));
  act(() => stream("pg1").serve({ type: "clipboard", text: "另一段" }));
  await screen.findByText("页面复制了内容，但无法写入本机剪贴板");
});

test("本窗口不是操作窗口：导航按钮禁用，「接管操作」发 take", async () => {
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p, false);
  expect((button("刷新") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("页面地址") as HTMLInputElement).readOnly).toBe(
    true,
  );
  expect(screen.getByText("另一个窗口正在操作这个页面")).toBeTruthy();
  fireEvent.click(button("接管操作"));
  expect(stream("pg1").sent).toEqual([{ type: "take" }]);
});

test("休眠页：盖「页面休眠中」，「唤醒」请求唤醒", async () => {
  const p = pageView({ id: "pg1", state: "sleeping" });
  await open("pg1");
  seed(p);
  expect(screen.getByText("页面休眠中")).toBeTruthy();
  api.wakePage.mockResolvedValue({ ok: true, data: { ...p, state: "active" } });
  fireEvent.click(button("唤醒"));
  await waitFor(() =>
    expect(api.wakePage).toHaveBeenCalledWith(null, "ws1", "pg1"),
  );
});

test("操作失败：服务端的原因显示在顶部提示里，可关闭", async () => {
  const p = pageView({ id: "pg1" });
  await open("pg1");
  seed(p);
  connect(p);
  api.setControl.mockResolvedValue({
    ok: false,
    status: 409,
    message: "页面正被另一个会话使用",
  });
  fireEvent.click(button("手动操作"));
  expect(await screen.findByText("页面正被另一个会话使用")).toBeTruthy();
  fireEvent.click(button("关闭提示"));
  expect(screen.queryByText("页面正被另一个会话使用")).toBeNull();
});

test("接管请求横幅：显示原因；「我已操作完成」答复 done", async () => {
  const p = pageView({
    id: "pg1",
    inUseBy: "a",
    handoffPending: true,
    handoffReason: "请完成登录验证码",
  });
  await open("pg1");
  seed(p);
  expect(screen.getByText("agent 请你接管：请完成登录验证码")).toBeTruthy();
  api.answerHandoff.mockResolvedValue({ ok: true, data: undefined });
  fireEvent.click(button("我已操作完成"));
  await waitFor(() =>
    expect(api.answerHandoff).toHaveBeenCalledWith(null, "ws1", "pg1", {
      outcome: "done",
    }),
  );
  // 服务端把标记清掉后横幅消失
  emit({
    type: "page",
    event: {
      type: "updated",
      page: { ...p, handoffPending: false, handoffReason: null },
    },
  });
  expect(screen.queryByText(/agent 请你接管/)).toBeNull();
});

test("接管请求横幅：页面本来就在用户手里时是「请求使用」，按钮换成「交给 agent」，答复仍是 done", async () => {
  const p = pageView({
    id: "pg1",
    controller: "user",
    inUseBy: "a",
    handoffPending: true,
    handoffReason: "要核对这个页面里的订单",
  });
  await open("pg1");
  seed(p);
  expect(
    screen.getByText("agent 请求使用这个页面：要核对这个页面里的订单"),
  ).toBeTruthy();
  api.answerHandoff.mockResolvedValue({ ok: true, data: undefined });
  fireEvent.click(button("交给 agent"));
  await waitFor(() =>
    expect(api.answerHandoff).toHaveBeenCalledWith(null, "ws1", "pg1", {
      outcome: "done",
    }),
  );
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OFFER = {
  ok: true,
  data: { site: "github.com", saved: false, offer: true },
};

/** 服务端报：这个页面的操作者从用户变回了 agent（点「交还」、点横幅、在聊天里答复，都是这个结果）。 */
const handBack = (p: PageView) =>
  emit({
    type: "page",
    event: { type: "updated", page: { ...p, controller: "agent" } },
  });

test("登录状态：页面交还 agent 后站点状态有变就问；「保存」存下来并收起，「忽略」只收起", async () => {
  const p = pageView({
    id: "pg1",
    url: "https://github.com/login",
    controller: "user",
  });
  await open("pg1");
  seed(p);
  connect(p);
  api.getLoginOffer.mockResolvedValue(OFFER);
  handBack(p);
  expect(await screen.findByText(/保存 github\.com 的登录状态/)).toBeTruthy();
  expect(api.getLoginOffer).toHaveBeenCalledWith(null, "ws1", "pg1");

  fireEvent.click(button("忽略"));
  expect(screen.queryByText(/保存 github\.com 的登录状态/)).toBeNull();
  expect(api.saveLogin).not.toHaveBeenCalled();

  // 再接管、再交还：又会问
  emit({
    type: "page",
    event: { type: "updated", page: { ...p, controller: "user" } },
  });
  handBack(p);
  await screen.findByText(/保存 github\.com 的登录状态/);
  api.saveLogin.mockResolvedValue({
    ok: true,
    data: { site: "github.com", enabled: true },
  });
  fireEvent.click(button("保存"));
  await waitFor(() =>
    expect(api.saveLogin).toHaveBeenCalledWith(null, "ws1", "pg1"),
  );
  await waitFor(() =>
    expect(screen.queryByText(/保存 github\.com 的登录状态/)).toBeNull(),
  );
});

test("登录状态：不管是点「交还」、点接管横幅还是别处答复，只要操作者变回 agent 就问，且每次交还只问一次", async () => {
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p);
  api.getLoginOffer.mockResolvedValue(OFFER);
  handBack(p);
  await screen.findByText(/保存 github\.com 的登录状态/);
  // 同一次交还之后页面又更新了几次（加载中、标题变了）：不重复查询
  handBack({ ...p, title: "新标题" });
  handBack({ ...p, loading: true });
  await sleep(50);
  expect(api.getLoginOffer).toHaveBeenCalledTimes(1);
});

test("登录状态：这个标签没显示的页面被交还了，不会在别的页面上弹；切过去时才问", async () => {
  const a = pageView({ id: "pg1", title: "页面甲", controller: "user" });
  const b = pageView({
    id: "pg2",
    title: "页面乙",
    url: "https://github.com/login",
    controller: "user",
  });
  await open("pg1");
  seed(a, b);
  connect(a);
  api.getLoginOffer.mockResolvedValue(OFFER);
  handBack(b); // pg2 在后台被交还，这个标签显示的是 pg1
  await sleep(50);
  expect(api.getLoginOffer).not.toHaveBeenCalled();
  expect(screen.queryByText(/的登录状态/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /页面 2/ }));
  const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  fireEvent.click(within(dialog).getByText("页面乙"));
  expect(await screen.findByText(/保存 github\.com 的登录状态/)).toBeTruthy();
  expect(api.getLoginOffer).toHaveBeenCalledWith(null, "ws1", "pg2");
});

test("登录状态：已保存且没有变化、或页面不属于任何站点，都不打扰", async () => {
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p);
  api.getLoginOffer.mockResolvedValue({
    ok: true,
    data: { site: "github.com", saved: true, offer: false },
  });
  handBack(p);
  await waitFor(() => expect(api.getLoginOffer).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/的登录状态/)).toBeNull();

  // 本机地址、IP 这类页面：site 为 null
  api.getLoginOffer.mockResolvedValue({
    ok: true,
    data: { site: null, saved: false, offer: false },
  });
  emit({
    type: "page",
    event: { type: "updated", page: { ...p, controller: "user" } },
  });
  handBack(p);
  await waitFor(() => expect(api.getLoginOffer).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/的登录状态/)).toBeNull();
});

test("登录状态：接管横幅上点「拒绝」不问（操作者没有变回 agent）", async () => {
  const p = pageView({
    id: "pg1",
    handoffPending: true,
    handoffReason: "请登录",
  });
  await open("pg1");
  seed(p);
  api.answerHandoff.mockResolvedValue({ ok: true, data: undefined });
  api.getLoginOffer.mockResolvedValue(OFFER);
  fireEvent.click(button("拒绝"));
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  await waitFor(() => expect(api.answerHandoff).toHaveBeenCalledTimes(1));
  await sleep(50);
  expect(api.getLoginOffer).not.toHaveBeenCalled();
});

test("登录状态：保存失败时原因留在这一行里，不收起", async () => {
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p);
  api.getLoginOffer.mockResolvedValue(OFFER);
  handBack(p);
  await screen.findByText(/保存 github\.com 的登录状态/);
  api.saveLogin.mockResolvedValue({
    ok: false,
    status: 409,
    message: "浏览器当前没在运行，没有可保存的登录状态。",
  });
  fireEvent.click(button("保存"));
  expect(
    await screen.findByText("浏览器当前没在运行，没有可保存的登录状态。"),
  ).toBeTruthy();
  expect(button("保存")).toBeTruthy();
});

test("登录状态：手动态工具条上有「保存登录状态」按钮，观察态没有；点了直接保存", async () => {
  const p = pageView({ id: "pg1", controller: "agent", inUseBy: "a" });
  await open("pg1");
  seed(p);
  connect(p);
  expect(screen.queryByRole("button", { name: "保存登录状态" })).toBeNull();

  cleanup();
  FakeSocket.reset();
  const mine = pageView({ id: "pg2", controller: "user", userOpened: true });
  await open("pg2");
  seed(mine);
  connect(mine);
  api.saveLogin.mockResolvedValue({
    ok: true,
    data: { site: "github.com", enabled: true },
  });
  fireEvent.click(button("保存登录状态"));
  await waitFor(() =>
    expect(api.saveLogin).toHaveBeenCalledWith(null, "ws1", "pg2"),
  );
});

test("窄窗格的「…」菜单：手动态有后退 / 前进 / 刷新 / 保存登录 / 回放 / 控制台，选中与点工具条按钮效果一样；开着的标「已开」", async () => {
  const p = pageView({ id: "pg1", controller: "user", userOpened: true });
  await open("pg1");
  seed(p);
  connect(p);
  const more = () => button("更多操作");
  const pick = (name: string) => {
    fireEvent.click(more());
    fireEvent.click(screen.getByRole("menuitem", { name }));
  };
  const items = () => screen.getAllByRole("menuitem").map((m) => m.textContent);

  fireEvent.click(more());
  expect(items()).toEqual([
    "后退",
    "前进",
    "刷新",
    "保存登录",
    "回放",
    "控制台",
  ]);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

  // 导航项走画面流，和工具条上的按钮一样
  pick("刷新");
  pick("后退");
  expect(stream("pg1").sent).toEqual([
    { type: "nav", action: "reload" },
    { type: "nav", action: "back" },
  ]);

  api.saveLogin.mockResolvedValue({
    ok: true,
    data: { site: "github.com", enabled: true },
  });
  pick("保存登录");
  await waitFor(() =>
    expect(api.saveLogin).toHaveBeenCalledWith(null, "ws1", "pg1"),
  );

  pick("控制台");
  expect(await screen.findByRole("region", { name: "控制台" })).toBeTruthy();
  pick("回放");
  expect(screen.getByRole("region", { name: "回放" })).toBeTruthy();

  // 两个都开着：菜单里各标「已开」，再选一次就关
  fireEvent.click(more());
  expect(items()).toEqual([
    "后退",
    "前进",
    "刷新",
    "保存登录",
    "回放已开",
    "控制台已开",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: /^回放/ }));
  expect(screen.queryByRole("region", { name: "回放" })).toBeNull();
});

test("窄窗格的「…」菜单：观察态只有回放 / 控制台；agent 在别处新开了页面时第一项是它，点了切过去", async () => {
  const p = pageView({ id: "pg1", controller: "agent", inUseBy: "a" });
  await open("pg1");
  seed(p);
  connect(p);
  fireEvent.click(button("更多操作"));
  expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
    "回放",
    "控制台",
  ]);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

  const fresh = pageView({
    id: "pg2",
    title: "新开的",
    controller: "agent",
    inUseBy: "a",
  });
  emit({ type: "page", event: { type: "added", page: fresh } });
  fireEvent.click(button("更多操作"));
  const items = screen.getAllByRole("menuitem").map((m) => m.textContent);
  expect(items[0]).toMatch(/^有新页面/);
  expect(items.slice(1)).toEqual(["回放", "控制台"]);
  fireEvent.click(screen.getByRole("menuitem", { name: /有新页面/ }));
  await waitFor(() => expect(webTabs()[0]?.page).toBe("pg2"));
});

test("窄窗格的「…」菜单：保存登录进行中，菜单里的「保存登录」是灰的，不会连点保存两次", async () => {
  const p = pageView({ id: "pg1", controller: "user", userOpened: true });
  await open("pg1");
  seed(p);
  connect(p);
  let done: (v: unknown) => void = () => {};
  api.saveLogin.mockReturnValue(new Promise((r) => (done = r)));
  fireEvent.click(button("更多操作"));
  fireEvent.click(screen.getByRole("menuitem", { name: "保存登录" }));
  await waitFor(() => expect(api.saveLogin).toHaveBeenCalledTimes(1));

  fireEvent.click(button("更多操作"));
  expect(
    (screen.getByRole("menuitem", { name: "保存登录" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await act(async () => {
    done({ ok: true, data: { site: "github.com", enabled: true } });
  });
});

test("窄窗格的「…」菜单：不是操作窗口时后退 / 前进 / 刷新是灰的，别的照常", async () => {
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p, false);
  fireEvent.click(button("更多操作"));
  for (const name of ["后退", "前进", "刷新"])
    expect(
      (screen.getByRole("menuitem", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
  expect(
    (screen.getByRole("menuitem", { name: "回放" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("接管请求横幅：拒绝可以写理由；答复失败时横幅里给出原因", async () => {
  const p = pageView({
    id: "pg1",
    handoffPending: true,
    handoffReason: "请登录",
  });
  await open("pg1");
  seed(p);
  fireEvent.click(button("拒绝"));
  fireEvent.change(screen.getByLabelText("拒绝的理由"), {
    target: { value: "  我不方便  " },
  });
  api.answerHandoff.mockResolvedValueOnce({
    ok: false,
    status: 409,
    message: "agent 当前没有在等这个页面的接管",
  });
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  await waitFor(() =>
    expect(api.answerHandoff).toHaveBeenCalledWith(null, "ws1", "pg1", {
      outcome: "refused",
      reason: "我不方便",
    }),
  );
  // 失败原因显示在主横幅上，不静默吞掉；写好的理由重新点「拒绝」还在
  expect(
    await screen.findByText("agent 当前没有在等这个页面的接管"),
  ).toBeTruthy();
  expect(api.answerHandoff).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  expect((screen.getByLabelText("拒绝的理由") as HTMLInputElement).value).toBe(
    "  我不方便  ",
  );
});

test("有新页面小条：agent 新开了别的页面才出现，点了才切；当前页上的动作不出", async () => {
  const cur = pageView({ id: "pg1", inUseBy: "a" });
  await open("pg1");
  seed(cur);
  // 在用当前页：不提示
  emit({
    type: "page",
    event: { type: "updated", page: { ...cur, inUseBy: null } },
  });
  emit({
    type: "page",
    event: { type: "updated", page: { ...cur, inUseBy: "a" } },
  });
  expect(screen.queryByText(/有新页面/)).toBeNull();

  // agent 接手一个早就有的别的页面：不算新页面，不提示
  const old = pageView({ id: "pg0", inUseBy: null });
  emit({
    type: "page",
    event: { type: "added", page: { ...old, userOpened: true } },
  });
  emit({
    type: "page",
    event: {
      type: "updated",
      page: { ...old, userOpened: true, controller: "agent", inUseBy: "a" },
    },
  });
  expect(screen.queryByText(/有新页面/)).toBeNull();

  const other = pageView({
    id: "pg2",
    title: "文档站",
    url: "http://server.localhost:5000/",
    inUseBy: "a",
  });
  emit({ type: "page", event: { type: "added", page: other } });
  const hint = await screen.findByRole("button", { name: /有新页面/ });
  expect(webTabs()[0]?.page).toBe("pg1");
  fireEvent.click(hint);
  await waitFor(() => expect(webTabs()[0]?.page).toBe("pg2"));
  expect(screen.queryByText(/有新页面/)).toBeNull();
});

test("页面列表：「我的」置顶、会话一组；关闭页面与在新标签打开", async () => {
  const mine = pageView({
    id: "m1",
    title: "我的页面",
    userOpened: true,
    controller: "user",
  });
  const theirs = pageView({
    id: "t1",
    title: "agent 的页面",
    usedBy: ["a"],
    inUseBy: "a",
  });
  await open("m1");
  seed(mine, theirs);
  fireEvent.click(screen.getByRole("button", { name: /页面 2/ }));
  const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  const heads = within(dialog)
    .getAllByRole("button")
    .map((b) => b.textContent)
    .filter((t) => t === "我的1" || t === "修登录1");
  expect(heads).toEqual(["我的1", "修登录1"]);
  // 当前会话（锚点 a）那组默认展开
  expect(within(dialog).getByText("agent 的页面")).toBeTruthy();

  api.closePage.mockResolvedValue({ ok: true, data: undefined });
  const row = within(dialog)
    .getByText("agent 的页面")
    .closest(".u-lrow") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "关闭页面" }));
  await waitFor(() =>
    expect(api.closePage).toHaveBeenCalledWith(null, "ws1", "t1"),
  );

  fireEvent.click(within(row).getByRole("button", { name: "在新标签打开" }));
  await waitFor(() => expect(webTabs()).toHaveLength(2));
  expect(webTabs().map((t) => t.page)).toEqual(["m1", "t1"]);
});

test("页面列表：「端口」一栏列出此刻在监听的端口，点一下就打开；每次打开列表都重新取，没有端口时只剩「添加转发端口」", async () => {
  await open();
  seed();
  fireEvent.click(button("打开地址"));
  let dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  await waitFor(() => expect(api.getPorts).toHaveBeenCalledWith(null, "ws1"));
  expect(within(dialog).getByText("端口")).toBeTruthy();
  expect(within(dialog).getByLabelText("添加转发端口")).toBeTruthy();
  expect(within(dialog).queryByText("Server:3000")).toBeNull();

  // 关掉再打开：重新取，这回有两个端口
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "浏览器页面" })).toBeNull(),
  );
  api.getPorts.mockResolvedValue({
    ok: true,
    data: [
      { envId: "local", port: 3000, target: "server:3000" },
      { envId: "box", port: 8080, target: "box:8080" },
    ],
  });
  fireEvent.click(button("打开地址"));
  dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  expect(api.getPorts).toHaveBeenCalledTimes(2);
  expect(await within(dialog).findByText("Server:3000")).toBeTruthy();

  const fresh = pageView({ id: "pg9", userOpened: true, controller: "user" });
  api.openPage.mockImplementation(async () => {
    emit({ type: "page", event: { type: "added", page: fresh } });
    return { ok: true, data: { page: fresh, status: 200, deny: null } };
  });
  fireEvent.click(within(dialog).getByText("box:8080"));
  await waitFor(() =>
    expect(api.openPage).toHaveBeenCalledWith(null, "ws1", "box:8080"),
  );
  await waitFor(() => expect(webTabs()[0]?.page).toBe("pg9"));
});

test("页面列表：端口取不到时只是没有这些行（不留着上一次的旧端口），不影响别的", async () => {
  api.getPorts.mockResolvedValue({
    ok: true,
    data: [{ envId: "local", port: 3000, target: "server:3000" }],
  });
  await open();
  seed();
  fireEvent.click(button("打开地址"));
  let dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  expect(await within(dialog).findByText("Server:3000")).toBeTruthy();

  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "浏览器页面" })).toBeNull(),
  );
  api.getPorts.mockResolvedValue({ ok: false, status: 500, message: "boom" });
  fireEvent.click(button("打开地址"));
  dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  await waitFor(() => expect(api.getPorts).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(within(dialog).queryByText("Server:3000")).toBeNull(),
  );
  expect(within(dialog).getByLabelText("添加转发端口")).toBeTruthy();
  expect(within(dialog).getByLabelText("打开地址")).toBeTruthy();
});

const FWD = {
  id: "f1",
  envId: "local",
  port: 3000,
  target: "server:3000",
  localPort: 7501,
  listening: true,
};
const PORT3000 = { envId: "local", port: 3000, target: "server:3000" };
const YOURS = `http://${window.location.hostname}:7501/`;

/** 开页面列表，返回弹层。 */
async function openPanel() {
  await open();
  seed();
  fireEvent.click(button("打开地址"));
  return screen.findByRole("dialog", { name: "浏览器页面" });
}
const rowOf = (dialog: HTMLElement, label: string) =>
  within(dialog).getByText(label).closest(".u-lrow") as HTMLElement;
const fakePopup = () => ({
  opener: {} as unknown,
  location: { href: "" },
  close: vi.fn(),
});

test("端口行的「在本机浏览器打开」：转发出来并在新窗口打开，行上变成「转发中」", async () => {
  api.getPorts.mockResolvedValue({ ok: true, data: [PORT3000] });
  api.openForward.mockResolvedValue({ ok: true, data: FWD });
  const popup = fakePopup();
  const spy = vi.spyOn(window, "open").mockReturnValue(popup as never);
  try {
    const dialog = await openPanel();
    const row = rowOf(dialog, "Server:3000");
    expect(within(row).getByRole("img", { name: "未转发" })).toBeTruthy();

    api.getForwards.mockResolvedValue({ ok: true, data: [FWD] });
    fireEvent.click(
      within(row).getByRole("button", { name: "在本机浏览器打开" }),
    );
    // 目标用地址栏写法交给服务端
    await waitFor(() =>
      expect(api.openForward).toHaveBeenCalledWith(null, "ws1", "server:3000"),
    );
    // 窗口在点击的同一刻开（免被拦截），拿到转发端口后再导航，且切断 opener
    expect(spy).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(popup.location.href).toBe(YOURS));
    expect(popup.opener).toBeNull();
    await waitFor(() =>
      expect(
        within(rowOf(dialog, "Server:3000")).getByText("转发端口 7501"),
      ).toBeTruthy(),
    );
    expect(
      within(rowOf(dialog, "Server:3000")).getByRole("img", { name: "转发中" }),
    ).toBeTruthy();
  } finally {
    spy.mockRestore();
  }
});

test("转发失败：关掉预先开的窗口，原因用提示条给出", async () => {
  api.getPorts.mockResolvedValue({ ok: true, data: [PORT3000] });
  api.openForward.mockResolvedValue({
    ok: false,
    status: 409,
    message: "转发端口用完了（7500-7599），先关掉不用的转发",
  });
  const popup = fakePopup();
  const spy = vi.spyOn(window, "open").mockReturnValue(popup as never);
  try {
    await open();
    render(<ToastHost />);
    seed();
    fireEvent.click(button("打开地址"));
    const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
    const row = await waitFor(() => rowOf(dialog, "Server:3000"));
    fireEvent.click(
      within(row).getByRole("button", { name: "在本机浏览器打开" }),
    );
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(popup.location.href).toBe("");
    await waitFor(() =>
      expect(document.querySelector(".u-toast")?.textContent).toContain(
        "转发端口用完了",
      ),
    );
  } finally {
    spy.mockRestore();
  }
});

test("已转发的行：「在本机浏览器打开」直接开窗口（不再请求转发）；「复制转发地址」复制出口地址", async () => {
  api.getPorts.mockResolvedValue({ ok: true, data: [PORT3000] });
  api.getForwards.mockResolvedValue({ ok: true, data: [FWD] });
  const popup = fakePopup();
  const spy = vi.spyOn(window, "open").mockReturnValue(popup as never);
  const copy = vi.spyOn(ui, "copyText").mockResolvedValue(true);
  try {
    await open();
    render(<ToastHost />);
    seed();
    fireEvent.click(button("打开地址"));
    const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
    const row = await waitFor(() => {
      const r = rowOf(dialog, "Server:3000");
      within(r).getByText("转发端口 7501");
      return r;
    });
    fireEvent.click(
      within(row).getByRole("button", { name: "在本机浏览器打开" }),
    );
    await waitFor(() => expect(popup.location.href).toBe(YOURS));
    expect(api.openForward).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: "复制转发地址" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(YOURS));
    await waitFor(() =>
      expect(document.querySelector(".u-toast")?.textContent).toContain(
        "已复制",
      ),
    );
  } finally {
    spy.mockRestore();
    copy.mockRestore();
  }
});

test("「停止转发」：请求停掉并重新取列表，行上回到「未转发」（还在监听）或消失（没有检测到）", async () => {
  api.getPorts.mockResolvedValue({ ok: true, data: [PORT3000] });
  api.getForwards.mockResolvedValue({
    ok: true,
    data: [
      FWD,
      { ...FWD, id: "f2", port: 9000, target: "server:9000", localPort: 7502 },
    ],
  });
  api.closeForward.mockResolvedValue({ ok: true, data: undefined });
  const dialog = await openPanel();
  const row = await waitFor(() => {
    const r = rowOf(dialog, "Server:3000");
    within(r).getByText("转发端口 7501");
    return r;
  });
  api.getForwards.mockResolvedValue({
    ok: true,
    data: [
      { ...FWD, id: "f2", port: 9000, target: "server:9000", localPort: 7502 },
    ],
  });
  fireEvent.click(within(row).getByRole("button", { name: "停止转发" }));
  await waitFor(() =>
    expect(api.closeForward).toHaveBeenCalledWith(null, "ws1", "f1"),
  );
  // 3000 还在监听：行留着，回到未转发
  await waitFor(() =>
    expect(
      within(rowOf(dialog, "Server:3000")).getByRole("img", { name: "未转发" }),
    ).toBeTruthy(),
  );

  // 9000 是手动加的、没被检测到：停掉后这一行就没了
  api.getForwards.mockResolvedValue({ ok: true, data: [] });
  fireEvent.click(
    within(rowOf(dialog, "Server:9000")).getByRole("button", {
      name: "停止转发",
    }),
  );
  await waitFor(() =>
    expect(api.closeForward).toHaveBeenCalledWith(null, "ws1", "f2"),
  );
  await waitFor(() =>
    expect(within(dialog).queryByText("Server:9000")).toBeNull(),
  );
});

test("手动添加转发：输入 3000 回车，不要求被检测到，不自动开窗口；行出现在「端口」里并清空输入框", async () => {
  api.openForward.mockImplementation(async () => {
    api.getForwards.mockResolvedValue({ ok: true, data: [FWD] });
    return { ok: true, data: FWD };
  });
  const spy = vi.spyOn(window, "open");
  try {
    const dialog = await openPanel();
    expect(within(dialog).queryByText("Server:3000")).toBeNull();
    const input = within(dialog).getByLabelText(
      "添加转发端口",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: " 3000 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.openForward).toHaveBeenCalledWith(null, "ws1", "3000"),
    );
    // 没被检测到（端口列表是空的），但手动转发的这一行在
    expect(await within(dialog).findByText("转发端口 7501")).toBeTruthy();
    expect(within(dialog).getByText("Server:3000")).toBeTruthy();
    expect(input.value).toBe("");
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("手动添加转发失败：原因留在输入框下面，输入保留；空输入不请求", async () => {
  api.openForward.mockResolvedValue({
    ok: false,
    status: 400,
    message: "找不到主机 nope；公网地址要带 http:// 或 https:// 前缀",
  });
  const dialog = await openPanel();
  const input = within(dialog).getByLabelText(
    "添加转发端口",
  ) as HTMLInputElement;
  fireEvent.keyDown(input, { key: "Enter" });
  expect(api.openForward).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: "nope:3000" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "转发" }));
  expect(await within(dialog).findByText(/找不到主机 nope/)).toBeTruthy();
  expect(input.value).toBe("nope:3000");
});

test("控制台是 https 访问时：添加、打开、复制都不做，原因写明；停止转发照常", async () => {
  api.getPorts.mockResolvedValue({ ok: true, data: [PORT3000] });
  api.getForwards.mockResolvedValue({ ok: true, data: [FWD] });
  api.closeForward.mockResolvedValue({ ok: true, data: undefined });
  vi.stubGlobal("location", {
    ...window.location,
    protocol: "https:",
    hostname: "ys.example.com",
  });
  const spy = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    await open();
    render(<ToastHost />);
    seed();
    fireEvent.click(button("打开地址"));
    const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
    const row = await waitFor(() => {
      const r = rowOf(dialog, "Server:3000");
      within(r).getByText("转发端口 7501");
      return r;
    });

    const input = within(dialog).getByLabelText("添加转发端口");
    fireEvent.change(input, { target: { value: "4000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await within(dialog).findByText(/明文 http/)).toBeTruthy();
    expect(api.openForward).not.toHaveBeenCalled();

    fireEvent.click(
      within(row).getByRole("button", { name: "在本机浏览器打开" }),
    );
    await waitFor(() =>
      expect(document.querySelector(".u-toast")?.textContent).toContain(
        "明文 http",
      ),
    );
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: "停止转发" }));
    await waitFor(() =>
      expect(api.closeForward).toHaveBeenCalledWith(null, "ws1", "f1"),
    );
  } finally {
    spy.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("页面列表：点端口打开失败时，原因留在列表里", async () => {
  api.getPorts.mockResolvedValue({
    ok: true,
    data: [{ envId: "local", port: 3000, target: "server:3000" }],
  });
  await open();
  seed();
  fireEvent.click(button("打开地址"));
  const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  api.openPage.mockResolvedValue({
    ok: false,
    status: 409,
    message: "激活的页面已达上限，先关掉一个",
  });
  fireEvent.click(await within(dialog).findByText("Server:3000"));
  expect(
    await within(dialog).findByText("激活的页面已达上限，先关掉一个"),
  ).toBeTruthy();
});

test("页面列表：点休眠页的行会切过去并唤醒它", async () => {
  const awake = pageView({
    id: "a1",
    title: "醒着的",
    userOpened: true,
    controller: "user",
  });
  const asleep = pageView({
    id: "s1",
    title: "睡着的",
    userOpened: true,
    controller: "user",
    state: "sleeping",
  });
  await open("a1");
  seed(awake, asleep);
  fireEvent.click(screen.getByRole("button", { name: /页面 2/ }));
  const dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  api.wakePage.mockResolvedValue({
    ok: true,
    data: { ...asleep, state: "active" },
  });
  fireEvent.click(within(dialog).getByText("睡着的"));
  await waitFor(() => expect(webTabs()[0]?.page).toBe("s1"));
  expect(api.wakePage).toHaveBeenCalledWith(null, "ws1", "s1");
});

test("画面流用尽重连：盖「连接已断开」，「重试」重新建连", async () => {
  vi.useFakeTimers();
  try {
    const p = pageView({ id: "pg1" });
    await open("pg1");
    seed(p);
    for (let i = 0; i < 6; i++) {
      const s = stream("pg1");
      act(() => s.drop());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
    }
    expect(screen.getByText("连接已断开")).toBeTruthy();
    expect((q(".ws-wb-canvas") as HTMLCanvasElement).hidden).toBe(true);
    const before = FakeSocket.all.length;
    const retry = within(q(".ws-wb-veil") as HTMLElement).getByRole("button", {
      name: "重试",
    });
    fireEvent.click(retry);
    expect(FakeSocket.all.length).toBe(before + 1);
  } finally {
    vi.useRealTimers();
  }
});

test("控制台抽屉：打开时取历史并接上画面流里的新消息；状态随标签保存", async () => {
  const p = pageView({ id: "pg1" });
  api.getConsole.mockResolvedValue({
    ok: true,
    data: [{ ts: 1, kind: "console", level: "log", text: "历史一条" }],
  });
  await open("pg1");
  seed(p);
  connect(p);
  fireEvent.click(screen.getByRole("button", { name: "控制台" }));
  expect(await screen.findByText("历史一条")).toBeTruthy();
  expect(api.getConsole).toHaveBeenCalledWith(null, "ws1", "pg1");
  act(() =>
    stream("pg1").serve({
      type: "console",
      entry: { ts: 2, kind: "error", level: "error", text: "新来的报错" },
    }),
  );
  expect(screen.getByText("新来的报错")).toBeTruthy();
  fireEvent.click(button("收起控制台"));
  expect(screen.queryByRole("region", { name: "控制台" })).toBeNull();
});

test("回放：工具条按钮开关播放器，开着时实时画面藏起来、页面流断开，关掉后接回", async () => {
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p);
  const stage = () => q(".ws-wb-stage") as HTMLElement;
  expect(stage().hidden).toBe(false);
  expect(screen.queryByRole("region", { name: "回放" })).toBeNull();

  fireEvent.click(button("回放"));
  expect(screen.getByRole("region", { name: "回放" })).toBeTruthy();
  expect(button("回放").getAttribute("aria-pressed")).toBe("true");
  // 实时画面只是藏起来（画布仍挂着），页面流断开不再占带宽
  expect(stage().hidden).toBe(true);
  expect(stream("pg1").closed).toBe(true);

  fireEvent.click(button("回放"));
  expect(screen.queryByRole("region", { name: "回放" })).toBeNull();
  expect(stage().hidden).toBe(false);
  expect(stream("pg1").closed).toBe(false);
});

test("回放与控制台的开关随标签保存：切走再切回（组件重建）后恢复，改一个不冲掉另一个", async () => {
  const p = pageView({ id: "pg1", controller: "user" });
  await open("pg1");
  seed(p);
  connect(p);
  const drawer = () => screen.queryByRole("region", { name: "控制台" });
  const replay = () => screen.queryByRole("region", { name: "回放" });

  // 窗格只渲染当前标签：切到同窗格的别的标签，再切回来，WebTab 是新实例
  const pid = paneByHost("server").dataset.pid as string;
  const web = webTabs()[0]?.id as string;
  const other = panesOf(store.getState().doc.windows.list[0] as never)
    .find((x) => x.pid === pid)
    ?.tabs.find((t) => t.id !== web)?.id as string;
  expect(other).toBeTruthy();
  const awayAndBack = () => {
    act(() => store.activateTab(pid, other));
    act(() => store.activateTab(pid, web));
    seed(p);
  };

  // 先开控制台，最后一次保存的是回放自己的开关
  fireEvent.click(button("控制台"));
  fireEvent.click(button("回放"));
  expect(drawer()).toBeNull(); // 回放开着时控制台抽屉让位
  awayAndBack();
  expect(replay()).toBeTruthy();
  expect(button("回放").getAttribute("aria-pressed")).toBe("true");
  expect(button("控制台").getAttribute("aria-pressed")).toBe("true");
  expect(drawer()).toBeNull();

  // 回放开着时关掉控制台：回放的开关不被冲掉
  fireEvent.click(button("控制台"));
  awayAndBack();
  expect(replay()).toBeTruthy();
  expect(button("控制台").getAttribute("aria-pressed")).toBe("false");

  // 关回放后，之前开着的控制台抽屉回来
  fireEvent.click(button("控制台"));
  fireEvent.click(button("回放"));
  expect(drawer()).toBeTruthy();
});

test("回放不依赖当前有没有页面：没有页面也能打开", async () => {
  await open();
  seed();
  fireEvent.click(button("回放"));
  expect(screen.getByRole("region", { name: "回放" })).toBeTruthy();
});

test("引擎起不来：说明卡片给出原因与修法，「重试」重新安装", async () => {
  await open();
  act(() => events().open());
  act(() =>
    events().serve({
      type: "snapshot",
      engine: {
        ...engineState("failed"),
        problem: {
          code: "missing_libs",
          message: "缺少系统库",
          fix: "apt install libnss3",
        },
      },
      pages: [],
      limits: limitsView,
    }),
  );
  expect(screen.getByText("浏览器不可用")).toBeTruthy();
  expect(screen.getByText(/缺少系统库/)).toBeTruthy();
  expect(screen.getByText("apt install libnss3")).toBeTruthy();
  api.ensureEngine.mockResolvedValue({ ok: true, data: engineState() });
  fireEvent.click(button("重试"));
  await waitFor(() => expect(api.ensureEngine).toHaveBeenCalledWith(null));
});

// —— 用户页上的下载弹窗 ——

const withDownloads = (...names: string[]) =>
  pageView({
    id: "pg1",
    controller: "user",
    userOpened: true,
    pendingDownloads: names.map((filename, i) => ({
      id: `dl${i + 1}`,
      filename,
    })),
  });

test("下载弹窗：写着文件名，没有排队时不提示；保存到本机把内容交给浏览器另存", async () => {
  const p = withDownloads("报告.pdf");
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "保存下载的文件" });
  expect(within(dialog).getByText("报告.pdf")).toBeTruthy();
  expect(within(dialog).queryByText(/还有 \d+ 个下载/)).toBeNull();
  const blob = new Blob(["x"]);
  api.fetchPendingDownload.mockResolvedValue({ ok: true, data: blob });
  const save = vi.spyOn(ui, "saveBlob").mockImplementation(() => {});
  fireEvent.click(within(dialog).getByRole("button", { name: "保存到本机" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(blob, "报告.pdf"));
  expect(api.fetchPendingDownload).toHaveBeenCalledWith(
    null,
    "ws1",
    "pg1",
    "dl1",
  );
  save.mockRestore();
});

test("下载弹窗：放进工作区目录（两个目录时可选），成功后提示最终文件名", async () => {
  const p = withDownloads("a.zip");
  render(<ToastHost />);
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "保存下载的文件" });
  api.putPendingDownload.mockResolvedValue({
    ok: true,
    data: { name: "a (1).zip", path: "/g/a (1).zip", directory: "g" },
  });
  fireEvent.click(within(dialog).getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "g" }));
  fireEvent.click(
    within(dialog).getByRole("button", { name: "放进工作区目录" }),
  );
  await waitFor(() =>
    expect(api.putPendingDownload).toHaveBeenCalledWith(
      null,
      "ws1",
      "pg1",
      "dl1",
      "d-gpu",
    ),
  );
  expect(await screen.findByText("已放进「g」：a (1).zip")).toBeTruthy();
});

test("下载弹窗：失败原因用提示条弹出、弹窗不动；丢弃与关闭都等于丢弃", async () => {
  const p = withDownloads("a.zip");
  render(<ToastHost />);
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "保存下载的文件" });
  api.putPendingDownload.mockResolvedValue({
    ok: false,
    status: 502,
    message: "目录所在的环境现在不可用",
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "放进工作区目录" }),
  );
  expect(await screen.findByText("目录所在的环境现在不可用")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "保存下载的文件" })).toBeTruthy();
  expect(api.discardPendingDownload).not.toHaveBeenCalled();

  api.discardPendingDownload.mockResolvedValue({ ok: true, data: undefined });
  fireEvent.click(within(dialog).getByRole("button", { name: "丢弃" }));
  await waitFor(() =>
    expect(api.discardPendingDownload).toHaveBeenCalledWith(
      null,
      "ws1",
      "pg1",
      "dl1",
    ),
  );
  // Esc 关闭同样是丢弃，否则待处理项还在，弹窗会立刻又出来
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(api.discardPendingDownload).toHaveBeenCalledTimes(2),
  );
});

test("下载弹窗：一次问一个，处理掉后服务端清单更新，下一个接着问", async () => {
  const p = withDownloads("一.pdf", "二.pdf");
  await open("pg1");
  seed(p);
  let dialog = screen.getByRole("dialog", { name: "保存下载的文件" });
  expect(within(dialog).getByText("一.pdf")).toBeTruthy();
  expect(within(dialog).getByText("还有 1 个下载在等你处理")).toBeTruthy();
  emit({
    type: "page",
    event: {
      type: "updated",
      page: { ...p, pendingDownloads: [{ id: "dl2", filename: "二.pdf" }] },
    },
  });
  dialog = screen.getByRole("dialog", { name: "保存下载的文件" });
  expect(within(dialog).getByText("二.pdf")).toBeTruthy();
  emit({
    type: "page",
    event: { type: "updated", page: { ...p, pendingDownloads: [] } },
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

// —— 用户页上的文件选择弹窗 ——

const withUpload = (multiple: boolean) =>
  pageView({
    id: "pg1",
    controller: "user",
    userOpened: true,
    pendingUpload: { id: "up1", multiple },
  });
const file = (name: string, size = 3) =>
  new File([new Uint8Array(size)], name, { type: "text/plain" });
/** 在弹窗里「选」了本机文件（隐藏的 input 触发 change）。 */
const pick = (dialog: HTMLElement, ...files: File[]) =>
  fireEvent.change(dialog.querySelector("[data-file-input]") as HTMLElement, {
    target: { files },
  });

test("上传弹窗：没选文件时「上传」不可点；选了之后列出名字与大小，上传把文件交给接口", async () => {
  const p = withUpload(true);
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "选择要上传的文件" });
  expect(
    within(dialog)
      .getByRole("button", { name: "上传" })
      .hasAttribute("disabled"),
  ).toBe(true);
  const a = file("简历.pdf", 2048);
  const b = file("b.txt");
  pick(dialog, a, b);
  expect(within(dialog).getByText("简历.pdf")).toBeTruthy();
  expect(within(dialog).getByText("2.0 KB")).toBeTruthy();
  api.uploadPageFiles.mockResolvedValue({ ok: true, data: undefined });
  fireEvent.click(within(dialog).getByRole("button", { name: "上传" }));
  await waitFor(() =>
    expect(api.uploadPageFiles).toHaveBeenCalledWith(
      null,
      "ws1",
      "pg1",
      "up1",
      [a, b],
    ),
  );
  // 服务端把选择器清掉后弹窗消失
  emit({
    type: "page",
    event: { type: "updated", page: { ...p, pendingUpload: null } },
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("上传弹窗：只收一个文件的入口，再选会替换，input 没有 multiple", async () => {
  const p = withUpload(false);
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "选择要上传的文件" });
  pick(dialog, file("a.txt"));
  pick(dialog, file("b.txt"));
  expect(within(dialog).queryByText("a.txt")).toBeNull();
  expect(within(dialog).getByText("b.txt")).toBeTruthy();
  expect(dialog.querySelector("input")?.hasAttribute("multiple")).toBe(false);
});

test("上传弹窗：多选入口累加、同一个文件不重复、可以移除；合计超过 50 MB 不让上传", async () => {
  const p = withUpload(true);
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "选择要上传的文件" });
  const a = file("a.txt");
  pick(dialog, a);
  pick(dialog, a, file("b.txt"));
  expect(within(dialog).getAllByText(/\.txt$/).length).toBe(2);
  fireEvent.click(within(dialog).getByRole("button", { name: "移除 a.txt" }));
  expect(within(dialog).queryByText("a.txt")).toBeNull();
  // 50 MB 的文件：合计达到上限，提示并禁用「上传」
  pick(dialog, file("big.bin", 50 * 1024 * 1024));
  expect(within(dialog).getByText(/超过浏览器一次能接收的 50 MB/)).toBeTruthy();
  expect(
    within(dialog)
      .getByRole("button", { name: "上传" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("上传弹窗：失败用提示条给、弹窗不动、已选的文件还在；取消与关闭都调用取消", async () => {
  const p = withUpload(true);
  render(<ToastHost />);
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "选择要上传的文件" });
  pick(dialog, file("a.txt"));
  api.uploadPageFiles.mockResolvedValue({
    ok: false,
    status: 413,
    message: "文件太大（2.0 MB，上限 1 MB）：a.txt",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "上传" }));
  expect(await screen.findByText(/文件太大（2.0 MB，上限 1 MB）/)).toBeTruthy();
  expect(within(dialog).getByText("a.txt")).toBeTruthy();
  expect(api.cancelPageUpload).not.toHaveBeenCalled();

  api.cancelPageUpload.mockResolvedValue({ ok: true, data: undefined });
  // 提示条先出来，弹窗的忙碌态随后才解除；每次操作前等「取消」恢复可用，否则点击与 Esc 会被忙碌态吞掉
  const cancel = within(dialog).getByRole("button", {
    name: "取消",
  }) as HTMLButtonElement;
  const idle = () => waitFor(() => expect(cancel.disabled).toBe(false));
  await idle();
  fireEvent.click(cancel);
  await waitFor(() =>
    expect(api.cancelPageUpload).toHaveBeenCalledWith(
      null,
      "ws1",
      "pg1",
      "up1",
    ),
  );
  // Esc 关闭同样是取消，否则待处理项还在，弹窗会立刻又出来
  await idle();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(api.cancelPageUpload).toHaveBeenCalledTimes(2));
});

test("上传弹窗与下载弹窗同时有时先问上传（页面在等你选文件）", async () => {
  const p = pageView({
    id: "pg1",
    controller: "user",
    userOpened: true,
    pendingUpload: { id: "up1", multiple: false },
    pendingDownloads: [{ id: "dl1", filename: "a.zip" }],
  });
  await open("pg1");
  seed(p);
  expect(screen.getByRole("dialog", { name: "选择要上传的文件" })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "保存下载的文件" })).toBeNull();
  emit({
    type: "page",
    event: { type: "updated", page: { ...p, pendingUpload: null } },
  });
  expect(screen.getByRole("dialog", { name: "保存下载的文件" })).toBeTruthy();
});

// —— 页面挂着的 JS 对话框 ——

const withDialog = (dialog: PageView["dialog"]) =>
  pageView({
    id: "pg1",
    url: "https://shop.test/cart",
    controller: "user",
    userOpened: true,
    dialog,
  });

test("对话框：confirm 写明来源站点与原文，确定 / 取消各发一次回答；别处答了页面一更新就消失", async () => {
  const p = withDialog({
    type: "confirm",
    message: "确定删除这一项吗？\n删除后不能恢复",
    defaultValue: "",
  });
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "页面请求确认" });
  expect(within(dialog).getByText(/shop\.test 的页面弹出了它/)).toBeTruthy();
  expect(within(dialog).getByText(/确定删除这一项吗？/)).toBeTruthy();
  api.answerPageDialog.mockResolvedValue({ ok: true, data: undefined });
  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  await waitFor(() =>
    expect(api.answerPageDialog).toHaveBeenCalledWith(null, "ws1", "pg1", {
      accept: true,
    }),
  );
  // 回答期间按钮是禁用的：等上一次回答落定再点下一个
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "取消" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(api.answerPageDialog).toHaveBeenLastCalledWith(null, "ws1", "pg1", {
      accept: false,
    }),
  );
  emit({
    type: "page",
    event: { type: "updated", page: { ...p, dialog: null } },
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("对话框：prompt 带默认值，确定把输入带上，取消不带；回车等于确定", async () => {
  const p = withDialog({
    type: "prompt",
    message: "你的名字？",
    defaultValue: "小明",
  });
  await open("pg1");
  seed(p);
  const dialog = screen.getByRole("dialog", { name: "页面请求输入" });
  const input = within(dialog).getByLabelText("回答") as HTMLInputElement;
  expect(input.value).toBe("小明");
  api.answerPageDialog.mockResolvedValue({ ok: true, data: undefined });
  fireEvent.change(input, { target: { value: "小红" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(api.answerPageDialog).toHaveBeenCalledWith(null, "ws1", "pg1", {
      accept: true,
      text: "小红",
    }),
  );
  // 回答期间按钮是禁用的：等上一次回答落定再点下一个
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "取消" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(api.answerPageDialog).toHaveBeenLastCalledWith(null, "ws1", "pg1", {
      accept: false,
    }),
  );
});

test("对话框：alert 只有「知道了」；beforeunload 的按钮是「离开 / 留在页面」；Esc 等同取消", async () => {
  const p = withDialog({
    type: "alert",
    message: "保存成功",
    defaultValue: "",
  });
  await open("pg1");
  seed(p);
  const alert = screen.getByRole("dialog", { name: "页面提示" });
  expect(within(alert).queryByRole("button", { name: "取消" })).toBeNull();
  api.answerPageDialog.mockResolvedValue({ ok: true, data: undefined });
  fireEvent.click(within(alert).getByRole("button", { name: "知道了" }));
  await waitFor(() =>
    expect(api.answerPageDialog).toHaveBeenCalledWith(null, "ws1", "pg1", {
      accept: true,
    }),
  );
  emit({
    type: "page",
    event: {
      type: "updated",
      page: {
        ...p,
        dialog: { type: "beforeunload", message: "", defaultValue: "" },
      },
    },
  });
  const leave = screen.getByRole("dialog", { name: "要离开这个页面吗？" });
  expect(within(leave).getByRole("button", { name: "离开" })).toBeTruthy();
  fireEvent.keyDown(leave, { key: "Escape" });
  await waitFor(() =>
    expect(api.answerPageDialog).toHaveBeenLastCalledWith(null, "ws1", "pg1", {
      accept: false,
    }),
  );
});

test("对话框：回答失败（比如已被 agent 答了）用提示条给；有对话框时先问它，再问文件选择", async () => {
  const p = pageView({
    id: "pg1",
    controller: "user",
    userOpened: true,
    dialog: { type: "confirm", message: "sure?", defaultValue: "" },
    pendingUpload: { id: "up1", multiple: false },
  });
  render(<ToastHost />);
  await open("pg1");
  seed(p);
  expect(screen.queryByRole("dialog", { name: "选择要上传的文件" })).toBeNull();
  const dialog = screen.getByRole("dialog", { name: "页面请求确认" });
  api.answerPageDialog.mockResolvedValue({
    ok: false,
    status: 409,
    message: "这个页面现在没有等待回答的对话框",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  expect(await screen.findByText(/现在没有等待回答的对话框/)).toBeTruthy();
  emit({
    type: "page",
    event: { type: "updated", page: { ...p, dialog: null } },
  });
  expect(screen.getByRole("dialog", { name: "选择要上传的文件" })).toBeTruthy();
});

test("页面列表：会话组头按会话状态画点（执行中 / 待处理），待命的与「我的」不画", async () => {
  const mine = pageView({
    id: "m1",
    title: "我的页面",
    userOpened: true,
    controller: "user",
  });
  const theirs = pageView({ id: "t1", title: "agent 的页面", usedBy: ["a"] });
  const headOf = (dialog: HTMLElement, name: string) =>
    within(dialog).getByText(name).closest(".u-lrow") as HTMLElement;
  const dots = (row: HTMLElement) =>
    within(row)
      .queryAllByRole("img")
      .map((d) => d.getAttribute("aria-label"));

  // 执行中：脉动点
  await open("m1", new Map([["a", "running" as const]]));
  seed(mine, theirs);
  fireEvent.click(screen.getByRole("button", { name: /页面 2/ }));
  let dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  expect(dots(headOf(dialog, "修登录"))).toEqual(["执行中"]);
  expect(dots(headOf(dialog, "我的"))).toEqual([]);
  cleanup();

  // 待处理
  FakeSocket.reset();
  await open("m1", new Map([["a", "blocked" as const]]));
  seed(mine, theirs);
  fireEvent.click(screen.getByRole("button", { name: /页面 2/ }));
  dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  expect(dots(headOf(dialog, "修登录"))).toEqual(["待处理"]);
  cleanup();

  // 待命（表里没有它）：不画点
  FakeSocket.reset();
  await open("m1");
  seed(mine, theirs);
  fireEvent.click(screen.getByRole("button", { name: /页面 2/ }));
  dialog = await screen.findByRole("dialog", { name: "浏览器页面" });
  expect(dots(headOf(dialog, "修登录"))).toEqual([]);
});
