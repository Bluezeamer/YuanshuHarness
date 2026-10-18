import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "./api";
import { FakeWS, frame, installApi, msgs, snapshot } from "./fakes";
import { Shell } from "./Shell";

const session = (id: string, name: string) => ({
  id,
  name,
  createdAt: "t",
  updatedAt: "t",
  running: false,
});
const sessions = [session("s1", "甲"), session("s2", "乙")];

beforeEach(() => {
  FakeWS.all = [];
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 渲染外壳并选中会话，还没有任何帧到达。
function connect(history = msgs(0, 8)) {
  const api = installApi(history);
  const onUnauthorized = vi.fn();
  render(<Shell sessions={sessions} onUnauthorized={onUnauthorized} />);
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  return { api, ws: FakeWS.last, onUnauthorized };
}

const serve = (ws: FakeWS, o: unknown) => act(() => ws.serve(o));

function open(history = msgs(0, 8), extra: Record<string, unknown> = {}) {
  const c = connect(history);
  serve(c.ws, snapshot(1, history, extra));
  return c;
}

const box = () => screen.getByLabelText("输入消息") as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });
const enter = (init: object = {}) =>
  fireEvent.keyDown(box(), { key: "Enter", ...init });
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const said = (text: string) => ({ role: "assistant", text });

test("R1 用子协议带令牌连接，令牌不进 URL", () => {
  const { ws } = open();
  expect(ws.protocols).toEqual(["yuanshu.v1", "bearer.tok"]);
  expect(ws.url).toContain("/api/v1/sessions/s1/stream");
  expect(ws.url).not.toContain("tok");
});

test("R1 切换会话关闭旧连接，旧连接的帧不再改变界面", () => {
  const { ws: old } = open();
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  expect(old.closed).toBe(true);
  expect(FakeWS.all).toHaveLength(2);
  serve(old, frame(2, "message.ended", said("旧会话的话")));
  expect(screen.queryByText("旧会话的话")).toBeNull();
});

test("R2 历史加快照窗口按序显示，窗口内的消息不重复", async () => {
  open(msgs(0, 300));
  expect(await screen.findByText("m100")).toBeTruthy();
  expect(screen.queryByText("m99")).toBeNull();
  expect(screen.getAllByText("m250")).toHaveLength(1);
  const shown = screen
    .getAllByText(/^m\d+$/)
    .map((n) => Number((n.textContent ?? "").slice(1)));
  expect(shown).toEqual([...shown].sort((a, b) => a - b));
  expect(new Set(shown).size).toBe(200);
});

test("R2 resync 后新快照与已加载的历史并存：既不丢也不重复", async () => {
  const { ws, api } = open(msgs(0, 300));
  await screen.findByText("m100");
  fireEvent.click(await screen.findByRole("button", { name: "加载更早" }));
  await screen.findByText("m0");

  serve(ws, frame(5, "run.started"));
  expect(ws.sent.map((m) => m.type)).toContain("resync");
  api.history.push(...msgs(300, 302));
  serve(ws, snapshot(9, api.history));

  expect(await screen.findByText("m301")).toBeTruthy();
  for (const i of [0, 150, 299, 300, 301])
    expect(screen.getAllByText(`m${i}`)).toHaveLength(1);
});

test("R2 后续快照缺 startIndex：清掉旧历史块，只显示窗口并提示失败", async () => {
  const { ws, api } = open(msgs(0, 300));
  await screen.findByText("m100");
  serve(ws, snapshot(9, api.history, { startIndex: undefined }));
  expect(await screen.findByText(/历史加载失败/)).toBeTruthy();
  expect(screen.queryByText("m100")).toBeNull();
  expect(screen.getByText("m299")).toBeTruthy();
});

test("R2 历史取不到：提示失败，窗口里的消息仍显示", async () => {
  const c = connect(msgs(0, 8));
  c.api.messages = 500;
  serve(c.ws, snapshot(1, msgs(0, 8)));
  expect(await screen.findByText(/历史加载失败/)).toBeTruthy();
  expect(screen.getByText("m7")).toBeTruthy();
});

test("R2 快照没有 startIndex：不猜起点，提示失败，窗口里的消息仍显示", async () => {
  const c = connect(msgs(0, 8));
  serve(c.ws, snapshot(1, msgs(0, 8), { startIndex: undefined }));
  expect(await screen.findByText(/历史加载失败/)).toBeTruthy();
  expect(screen.getByText("m7")).toBeTruthy();
});

test("R2 历史响应不是合法 JSON：提示失败，窗口里的消息仍显示", async () => {
  const c = connect(msgs(0, 8));
  c.api.messages = "garbage";
  serve(c.ws, snapshot(1, msgs(0, 8)));
  expect(await screen.findByText(/历史加载失败/)).toBeTruthy();
  expect(screen.getByText("m7")).toBeTruthy();
});

test("R2 没有任何消息时显示空态", async () => {
  open([]);
  expect(await screen.findByText("还没有消息")).toBeTruthy();
});

test("R3 跳号：发 resync、丢弃其后的实时帧，新快照到达后恢复", () => {
  const { ws } = open(msgs(0, 2));
  serve(ws, frame(3, "message.ended", said("跳号帧")));
  expect(ws.sent.map((m) => m.type)).toEqual(["resync"]);
  serve(ws, frame(4, "message.ended", said("跳号后")));
  expect(screen.queryByText("跳号帧")).toBeNull();
  expect(screen.queryByText("跳号后")).toBeNull();
  serve(ws, snapshot(9, msgs(0, 3)));
  serve(ws, frame(10, "message.ended", said("恢复后")));
  expect(screen.getByText("恢复后")).toBeTruthy();
});

const feed =
  (ws: FakeWS, next = 2) =>
  (type: string, data: object = {}) =>
    serve(ws, frame(next++, type, data));

const ack = (ws: FakeWS, id: string, ok: boolean, message?: string) =>
  serve(ws, { type: "ack", id, ok, ...(ok ? {} : { error: { message } }) });

test("R4 助手消息流式追加并显示光标，ended 后以最终文本为准", () => {
  const { ws } = open([]);
  const push = feed(ws);
  push("message.started", { role: "assistant" });
  push("message.delta", { kind: "text", text: "你" });
  push("message.delta", { kind: "other", text: "忽略" });
  push("message.delta", { kind: "text", text: "好" });
  expect(screen.getByText("你好")).toBeTruthy();
  expect(screen.getByRole("img", { name: "正在输入" })).toBeTruthy();
  push("message.ended", { role: "assistant", text: "你好呀" });
  expect(screen.queryByRole("img", { name: "正在输入" })).toBeNull();
  expect(screen.getAllByText("你好呀")).toHaveLength(1);
  expect(screen.queryByText("忽略")).toBeNull();
});

test("R4 用户消息只在 message.ended 渲染一次", () => {
  const { ws } = open([]);
  const push = feed(ws);
  push("message.started", { role: "user" });
  expect(screen.queryByText("hi")).toBeNull();
  push("message.ended", { role: "user", text: "hi" });
  expect(screen.getAllByText("hi")).toHaveLength(1);
});

test("R5 工具活动：成功与失败分别显示，run.failed 显示原因", () => {
  const { ws } = open([]);
  const push = feed(ws);
  push("tool.started", { toolCallId: "t1", toolName: "read_file" });
  push("tool.started", { toolCallId: "t2", toolName: "bash" });
  expect(screen.getAllByText("运行中")).toHaveLength(2);
  push("tool.ended", { toolCallId: "t1", isError: false });
  push("tool.ended", { toolCallId: "t2", isError: true });
  expect(screen.getByText("完成")).toBeTruthy();
  expect(screen.getByText("失败")).toBeTruthy();
  push("run.failed", { message: "额度用尽" });
  expect(screen.getByText("额度用尽")).toBeTruthy();
});

test("R5 已有命令失败提示时，之后 run.failed 的原因仍然显示", () => {
  const { ws } = open([]);
  type("hi");
  enter();
  ack(ws, "c1", false, "队列已满");
  feed(ws)("run.failed", { message: "额度用尽" });
  expect(screen.getByText("队列已满")).toBeTruthy();
  expect(screen.getByText("额度用尽")).toBeTruthy();
});

test("R5 快照里的 activeTools 恢复进行中的工具", () => {
  open([], { activeTools: [{ toolCallId: "t9", toolName: "grep" }] });
  expect(screen.getByText("grep")).toBeTruthy();
  expect(screen.getByText("运行中")).toBeTruthy();
});

test("R6 运行中出现停止按钮且发送仍可用；空闲时没有停止", () => {
  const { ws } = open([]);
  const push = feed(ws);
  expect(screen.queryByRole("button", { name: "停止运行" })).toBeNull();
  push("run.started");
  expect(screen.getByRole("button", { name: "停止运行" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  push("run.ended");
  expect(screen.queryByRole("button", { name: "停止运行" })).toBeNull();
});

test("R6 队列非空显示排队 N 与各项文本，queue.updated 更新", () => {
  const { ws } = open([], { running: true, queue: ["第一条", "第二条"] });
  expect(screen.getByText("排队 2")).toBeTruthy();
  expect(screen.getByText("第一条")).toBeTruthy();
  feed(ws)("queue.updated", { queue: ["第二条"] });
  expect(screen.getByText("排队 1")).toBeTruthy();
  expect(screen.queryByText("第一条")).toBeNull();
});

test("R7 去除首尾空白后发出 send_message 并清空输入框", () => {
  const { ws } = open([]);
  type("  你好  ");
  enter();
  expect(ws.sent).toEqual([{ id: "c1", type: "send_message", text: "你好" }]);
  expect(box().value).toBe("");
});

test("R7 空白、Shift+Enter、输入法组合中的 Enter 都不发送", () => {
  const { ws } = open([]);
  type("   ");
  enter();
  type("a");
  enter({ shiftKey: true });
  enter({ isComposing: true });
  expect(ws.sent).toEqual([]);
  expect(box().value).toBe("a");
});

test("R7 运行中也可以发送", () => {
  const { ws } = open([], { running: true });
  type("插话");
  enter();
  expect(ws.sent.map((m) => m.type)).toEqual(["send_message"]);
});

test("R7 连接未就绪时命令发不出去，不清空输入框", () => {
  const { ws } = open([]);
  type("留着");
  ws.readyState = 3;
  enter();
  expect(ws.sent).toEqual([]);
  expect(box().value).toBe("留着");
});

test("R8 回执失败：显示错误并把原文放回输入框", () => {
  const { ws } = open([]);
  type("重要内容");
  enter();
  expect(box().value).toBe("");
  ack(ws, "c1", false, "会话忙");
  expect(screen.getByText("会话忙")).toBeTruthy();
  expect(box().value).toBe("重要内容");
});

test("R8 输入框已有新内容时不覆盖，错误仍显示", () => {
  const { ws } = open([]);
  type("甲");
  enter();
  type("乙");
  ack(ws, "c1", false, "会话忙");
  expect(box().value).toBe("乙");
  expect(screen.getByText("会话忙")).toBeTruthy();
});

test("R8 断线时未确认的发送放回输入框；已确认的不会", () => {
  const { ws } = open([]);
  type("没送到");
  enter();
  act(() => ws.drop());
  expect(box().value).toBe("没送到");
});

test("R8 连发两条都未确认就断线：按发送顺序合并放回，一条不丢", () => {
  const { ws } = open([], { running: true });
  type("第一条");
  enter();
  type("第二条");
  enter();
  act(() => ws.drop());
  expect(box().value).toBe("第一条\n第二条");
});

test("R8 先有回执失败放回的内容、再断线：未动过的草稿继续合并，两条都不丢", () => {
  const { ws } = open([], { running: true });
  type("第一条");
  enter();
  type("第二条");
  enter();
  ack(ws, "c1", false, "队列已满");
  expect(box().value).toBe("第一条");
  act(() => ws.drop());
  expect(box().value).toBe("第一条\n第二条");
});

test("R8 放回后用户改过草稿：之后断线放回的内容不覆盖也不拼接", () => {
  const { ws } = open([], { running: true });
  type("第一条");
  enter();
  type("第二条");
  enter();
  ack(ws, "c1", false, "队列已满");
  type("第一条改了");
  act(() => ws.drop());
  expect(box().value).toBe("第一条改了");
});

test("R8 已收到成功回执的发送，断线后不再放回", () => {
  const { ws } = open([]);
  type("送到了");
  enter();
  ack(ws, "c1", true);
  act(() => ws.drop());
  expect(box().value).toBe("");
});

test("R9 停止：回执前禁用，回执失败显示错误并恢复可点击", () => {
  const { ws } = open([], { running: true });
  const stop = () =>
    screen.getByRole("button", { name: "停止运行" }) as HTMLButtonElement;
  fireEvent.click(stop());
  expect(ws.sent).toEqual([{ id: "c1", type: "stop" }]);
  expect(stop().disabled).toBe(true);
  ack(ws, "c1", false, "停不了");
  expect(screen.getByText("停不了")).toBeTruthy();
  expect(stop().disabled).toBe(false);
});

test("R9 run.ended 后停止按钮消失", () => {
  const { ws } = open([], { running: true });
  fireEvent.click(screen.getByRole("button", { name: "停止运行" }));
  feed(ws)("run.ended");
  expect(screen.queryByRole("button", { name: "停止运行" })).toBeNull();
});

// 只伪造定时器，fetch 的微任务不受影响；这类用例里不要用 findBy*（它依赖真实定时器）。
const fakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const probes = (api: { calls: string[] }) =>
  api.calls.filter((c) => c === "/api/v1/sessions").length;
const drop = (ws: FakeWS) => act(() => ws.drop());

test("R9 断线后停止不可点；重连成功后恢复可点击", async () => {
  fakeClock();
  const { ws } = open([], { running: true });
  fireEvent.click(screen.getByRole("button", { name: "停止运行" }));
  drop(ws);
  const stop = () =>
    screen.getByRole("button", { name: "停止运行" }) as HTMLButtonElement;
  expect(stop().disabled).toBe(true);
  await tick(3100);
  serve(FakeWS.last, snapshot(1, [], { running: true }));
  await tick(0);
  expect(stop().disabled).toBe(false);
});

test("R10 断线：保留已显示内容，发送不可用，3 秒后先探测再建连", async () => {
  fakeClock();
  const { ws, api } = open(msgs(0, 8));
  drop(ws);
  expect(screen.getByText(/正在重连/)).toBeTruthy();
  expect(screen.getByText("m7")).toBeTruthy();
  expect(box().disabled).toBe(true);
  await tick(2900);
  expect(probes(api)).toBe(0);
  expect(FakeWS.all).toHaveLength(1);
  await tick(200);
  expect(probes(api)).toBe(1);
  expect(FakeWS.all).toHaveLength(2);
});

test("R10 重连后的新快照追上断线期间的消息，提示消失", async () => {
  fakeClock();
  const { ws, api } = open(msgs(0, 8));
  drop(ws);
  await tick(3100);
  api.history.push(...msgs(8, 10));
  serve(FakeWS.last, snapshot(1, api.history));
  await tick(0);
  expect(screen.getByText("m9")).toBeTruthy();
  expect(screen.queryByText(/正在重连|连接已断开/)).toBeNull();
  expect(box().disabled).toBe(false);
});

test("R10 探测返回 401：通知外壳，不再建连也不再重试", async () => {
  fakeClock();
  const { ws, api, onUnauthorized } = open([]);
  api.sessions = 401;
  drop(ws);
  await tick(3100);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  await tick(20000);
  expect(FakeWS.all).toHaveLength(1);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});

test("R10 探测返回 429：提示等待秒数并停止；之后手动重连可恢复", async () => {
  fakeClock();
  const { ws, api } = open([]);
  api.sessions = 429;
  api.retryAfter = "7";
  drop(ws);
  await tick(3100);
  expect(screen.getByText(/尝试过多.*7 秒/)).toBeTruthy();
  await tick(20000);
  expect(FakeWS.all).toHaveLength(1);
  api.sessions = 200;
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  await tick(0);
  expect(FakeWS.all).toHaveLength(2);
});

test("R10 探测返回 403：提示来源不被允许并停止", async () => {
  fakeClock();
  const { ws, api } = open([]);
  api.sessions = 403;
  drop(ws);
  await tick(3100);
  expect(screen.getByText(/来源不被允许/)).toBeTruthy();
  await tick(20000);
  expect(FakeWS.all).toHaveLength(1);
});

test("R10 探测网络失败算一次失败，3 秒后继续探测", async () => {
  fakeClock();
  const { ws, api } = open([]);
  api.sessions = "network";
  drop(ws);
  await tick(3100);
  await tick(3100);
  expect(probes(api)).toBe(2);
  expect(FakeWS.all).toHaveLength(1);
  api.sessions = 200;
  await tick(3100);
  expect(FakeWS.all).toHaveLength(2);
});

test("R10 连续 5 次连不上快照后停止，出现重新连接按钮", async () => {
  fakeClock();
  const { ws } = open([]);
  drop(ws);
  for (let i = 0; i < 5; i++) {
    await tick(3100);
    drop(FakeWS.last);
  }
  expect(FakeWS.all).toHaveLength(6);
  await tick(20000);
  expect(FakeWS.all).toHaveLength(6);
  expect(screen.getByText(/连接已断开/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新连接" })).toBeTruthy();
});

test("R10 收到快照后失败计数清零", async () => {
  fakeClock();
  const { ws } = open([]);
  drop(ws);
  await tick(3100);
  drop(FakeWS.last);
  await tick(3100);
  drop(FakeWS.last);
  await tick(3100);
  serve(FakeWS.last, snapshot(1, []));
  await tick(0);
  drop(FakeWS.last);
  for (let i = 0; i < 5; i++) {
    await tick(3100);
    drop(FakeWS.last);
  }
  expect(FakeWS.all).toHaveLength(9);
  await tick(20000);
  expect(FakeWS.all).toHaveLength(9);
});

test("R1 首帧不是快照：显示错误，不自动重连", async () => {
  fakeClock();
  const { ws } = connect();
  serve(ws, frame(1, "run.started"));
  expect(ws.closed).toBe(true);
  expect(screen.getByRole("button", { name: "重新连接" })).toBeTruthy();
  await tick(20000);
  expect(FakeWS.all).toHaveLength(1);
});

test("R4 快照里的 partial 恢复进行中的助手文本并显示光标", () => {
  open([], { running: true, partial: { role: "assistant", text: "部分文本" } });
  expect(screen.getByText("部分文本")).toBeTruthy();
  expect(screen.getByRole("img", { name: "正在输入" })).toBeTruthy();
});

// jsdom 没有布局：用实例属性模拟滚动度量，返回的对象可在用例里改。
function scrollable(top: number, height = 1000, client = 400) {
  const feed = screen.getByRole("log");
  const m = { top, height, client };
  Object.defineProperty(feed, "scrollHeight", {
    configurable: true,
    get: () => m.height,
  });
  Object.defineProperty(feed, "clientHeight", {
    configurable: true,
    get: () => m.client,
  });
  Object.defineProperty(feed, "scrollTop", {
    configurable: true,
    get: () => m.top,
    set: (v: number) => {
      m.top = v;
    },
  });
  fireEvent.scroll(feed);
  return m;
}

test("R11 用户在底部时，新内容到达后跟随到底部", () => {
  const { ws } = open(msgs(0, 8));
  const m = scrollable(600);
  m.height = 1100;
  feed(ws)("message.ended", said("新消息"));
  expect(m.top).toBe(1100);
});

test("R11 用户在底部时，排队文本出现后也跟随到底部", () => {
  const { ws } = open(msgs(0, 8));
  const m = scrollable(600);
  m.height = 1100;
  feed(ws)("queue.updated", { queue: ["排队中"] });
  expect(m.top).toBe(1100);
});

test("R11 用户在底部时，run.failed 的错误段出现后也跟随到底部", () => {
  const { ws } = open(msgs(0, 8));
  const m = scrollable(600);
  m.height = 1100;
  feed(ws)("run.failed", { message: "额度用尽" });
  expect(m.top).toBe(1100);
});

test("R11 用户在底部时，工具状态变化撑高后也跟随到底部", () => {
  const { ws } = open(msgs(0, 8));
  const push = feed(ws);
  push("tool.started", { toolCallId: "t1", toolName: "bash" });
  const m = scrollable(600);
  m.height = 1100;
  push("tool.ended", { toolCallId: "t1", isError: true });
  expect(m.top).toBe(1100);
});

test("R11 用户上滚后，新内容到达不抢走位置", () => {
  const { ws } = open(msgs(0, 8));
  const m = scrollable(100);
  m.height = 1100;
  feed(ws)("message.ended", said("新消息"));
  expect(m.top).toBe(100);
  expect(screen.getByText("新消息")).toBeTruthy();
});

test("R12 对话区、输入框、停止按钮、光标都有可访问名称", () => {
  const { ws } = open([], { running: true });
  expect(screen.getByRole("log", { name: "对话记录" })).toBeTruthy();
  expect(screen.getByLabelText("输入消息")).toBeTruthy();
  expect(screen.getByRole("button", { name: "停止运行" })).toBeTruthy();
  feed(ws)("message.started", { role: "assistant" });
  expect(screen.getByRole("img", { name: "正在输入" })).toBeTruthy();
});

test("R13 历史已到最早时不显示加载按钮", async () => {
  open(msgs(0, 50));
  await screen.findByText("m0");
  expect(screen.queryByRole("button", { name: "加载更早" })).toBeNull();
});

test("R13 点击加载更早：带游标取下一页，拼在已有历史之前", async () => {
  const { api } = open(msgs(0, 400));
  await screen.findByText("m200");
  expect(screen.queryByText("m199")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "加载更早" }));
  expect(await screen.findByText("m0")).toBeTruthy();
  expect(
    api.calls.some((c) => /before=.+&limit=200|limit=200&before=/.test(c)),
  ).toBe(true);
  expect(screen.getAllByText("m250")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "加载更早" })).toBeNull();
});

test("R13 加载失败：提示并保留按钮，重试可成功", async () => {
  const { api } = open(msgs(0, 400));
  await screen.findByText("m200");
  api.messages = 500;
  fireEvent.click(await screen.findByRole("button", { name: "加载更早" }));
  expect(await screen.findByText(/加载失败/)).toBeTruthy();
  api.messages = 200;
  fireEvent.click(screen.getByRole("button", { name: "加载更早" }));
  expect(await screen.findByText("m0")).toBeTruthy();
});

test("R13 响应不是合法 JSON：提示失败并解除加载中，重试可成功", async () => {
  const { api } = open(msgs(0, 400));
  await screen.findByText("m200");
  api.messages = "garbage";
  fireEvent.click(await screen.findByRole("button", { name: "加载更早" }));
  expect(await screen.findByText(/加载失败/)).toBeTruthy();
  api.messages = 200;
  fireEvent.click(screen.getByRole("button", { name: "加载更早" }));
  expect(await screen.findByText("m0")).toBeTruthy();
});

test("R13 取数期间游标已变（重新对齐替换了历史块）：丢弃旧结果", async () => {
  const { ws, api } = open(msgs(0, 400));
  await screen.findByText("m200");
  let release = () => {};
  api.pause = new Promise<void>((r) => (release = r));
  fireEvent.click(await screen.findByRole("button", { name: "加载更早" }));

  serve(ws, frame(5, "run.started"));
  api.history.push(...msgs(400, 700));
  serve(ws, snapshot(9, api.history));
  await screen.findByText("m500");
  await act(async () => release());

  expect(screen.queryByText("m0")).toBeNull();
  expect(screen.getByText("m500")).toBeTruthy();
});

test("R13 加载更早后视口停在点击前的消息位置", async () => {
  const { api } = open(msgs(0, 400));
  await screen.findByText("m200");
  const m = scrollable(300);
  let release = () => {};
  api.pause = new Promise<void>((r) => (release = r));
  fireEvent.click(await screen.findByRole("button", { name: "加载更早" }));
  m.height = 1800;
  await act(async () => release());
  await screen.findByText("m0");
  expect(m.top).toBe(300 + (1800 - 1000));
});

test("R13 请求期间新消息到达：位移只算历史块增加的高度", async () => {
  const { ws, api } = open(msgs(0, 400));
  await screen.findByText("m200");
  const m = scrollable(300);
  let release = () => {};
  api.pause = new Promise<void>((r) => (release = r));
  fireEvent.click(await screen.findByRole("button", { name: "加载更早" }));
  m.height = 1100;
  feed(ws)("message.ended", said("新消息"));
  m.height = 1900;
  await act(async () => release());
  await screen.findByText("m0");
  expect(m.top).toBe(300 + (1900 - 1100));
});

test("R14 切走再切回，草稿原样保留", () => {
  open();
  type("起草中");
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  expect(box().value).toBe("起草中");
});

test("R14 草稿按会话隔离，各不串入", () => {
  open();
  type("甲的内容");
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  expect(box().value).toBe("");
  type("乙的内容");
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  expect(box().value).toBe("甲的内容");
});

test("R14 切换会话时断线，未确认的发送回到原会话草稿", () => {
  const { ws } = open();
  type("发到甲");
  enter();
  act(() => ws.drop());
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  expect(box().value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  expect(box().value).toBe("发到甲");
});

test("R14 切换会话，断线时未确认的发送不进新会话的输入框", () => {
  const { ws } = open();
  type("留在甲");
  enter();
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  act(() => ws.drop());
  expect(box().value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  expect(box().value).toBe("留在甲");
});

test("R2 历史接口返回结构不对（200 但没有 messages）：提示失败并解除加载中", async () => {
  const c = connect(msgs(0, 8));
  c.api.messages = "shape";
  serve(c.ws, snapshot(1, msgs(0, 8)));
  expect(await screen.findByText(/历史加载失败/)).toBeTruthy();
  expect(screen.getByText("m7")).toBeTruthy();
});
