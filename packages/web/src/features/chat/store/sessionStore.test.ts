import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ack,
  compactionAnchor,
  FakeWS,
  frame,
  installChatApi,
  msgs,
  snapshot,
} from "../../../test/chatFakes";
import { ChatHub } from "./hub";

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(history = msgs(0, 8)) {
  const api = installChatApi(history);
  const onUnauthorized = vi.fn();
  const hub = new ChatHub({ token: () => "tok", onUnauthorized });
  const store = hub.acquire("s1");
  return { api, hub, store, ws: FakeWS.last, onUnauthorized };
}
function open(history = msgs(0, 8), extra: Record<string, unknown> = {}) {
  const c = setup(history);
  c.ws.serve(snapshot(1, history, extra));
  return c;
}
const said = (text: string) => ({ role: "assistant", text });
const feed =
  (ws: FakeWS, next = 2) =>
  (type: string, data: object = {}) =>
    ws.serve(frame(next++, type, data));
// 让已发出的 fetch 与其后续微任务跑完（只伪造 setTimeout 时，用 tick 推进）。
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const fakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const settled = (c: {
  store: { getSnapshot(): { historyLoading: boolean } };
}) =>
  vi.waitFor(() => expect(c.store.getSnapshot().historyLoading).toBe(false));

// ---- 连接与快照 ----

test("R1 用子协议带令牌连接，令牌不进 URL", () => {
  const { ws } = open();
  expect(ws.protocols).toEqual(["yuanshu.v1", "bearer.tok"]);
  expect(ws.url).toContain("/api/v1/sessions/s1/stream");
  expect(ws.url).not.toContain("tok");
});

test("R1 释放后连接关闭，旧连接的帧不再改变状态", () => {
  const { ws, hub, store } = open();
  hub.release("s1");
  expect(ws.closed).toBe(true);
  ws.serve(frame(2, "message.ended", said("旧会话的话")));
  expect(store.getSnapshot().messages.at(-1)?.text).not.toBe("旧会话的话");
});

test("R2 历史加快照窗口：按序、窗口内的消息不重复", async () => {
  const c = open(msgs(0, 300));
  await settled(c);
  const s = c.store.getSnapshot();
  expect(s.messages).toHaveLength(50);
  // 尾页取最近 200 条（100..299），去掉与快照窗口（250..299）重叠的部分
  expect(s.loaded.older.map((m) => m.index)).toEqual(
    Array.from({ length: 150 }, (_, i) => 100 + i),
  );
  expect(s.loaded.nextBefore).not.toBeNull();
});

test("R2 messages 响应带回压缩边界锚点，进 loaded 供对话流插卡", async () => {
  const c = setup(msgs(0, 8));
  c.api.compactions = [compactionAnchor(3, 1), compactionAnchor(6, 2)];
  c.ws.serve(snapshot(1, c.api.history));
  await settled(c);
  expect(c.store.getSnapshot().loaded.compactions.map((x) => x.seq)).toEqual([
    1, 2,
  ]);
  expect(
    c.store.getSnapshot().loaded.compactions.map((x) => x.afterIndex),
  ).toEqual([3, 6]);
});

test("R2 resync 后新快照与已加载的历史并存：既不丢也不重复", async () => {
  const c = open(msgs(0, 300));
  await settled(c);
  c.store.loadEarlier();
  await vi.waitFor(() =>
    expect(c.store.getSnapshot().loadingEarlier).toBe(false),
  );
  expect(c.store.getSnapshot().loaded.older[0]?.index).toBe(0);

  c.ws.serve(frame(5, "run.started"));
  expect(c.ws.commands("resync")).toHaveLength(1);
  c.api.history.push(...msgs(300, 302));
  c.ws.serve(snapshot(9, c.api.history));
  await vi.waitFor(() =>
    expect(c.store.getSnapshot().messages.at(-1)?.text).toBe("m301"),
  );
  await settled(c);
  const idx = c.store.getSnapshot().loaded.older.map((m) => m.index);
  expect(new Set(idx).size).toBe(idx.length);
  expect(idx[0]).toBe(0);
  expect(idx.at(-1)).toBe(251);
  expect(c.store.getSnapshot().messages).toHaveLength(50);
});

test("R2 后续快照缺 startIndex：清掉旧历史块并提示失败", async () => {
  const c = open(msgs(0, 300));
  await settled(c);
  c.ws.serve(snapshot(9, c.api.history, { startIndex: undefined }));
  const s = c.store.getSnapshot();
  expect(s.historyFailed).toBe(true);
  expect(s.loaded.older).toEqual([]);
  expect(s.messages.at(-1)?.text).toBe("m299");
});

test("R2 缺 startIndex 的快照到达时，在途的尾页请求作废，不回填旧历史", async () => {
  const c = setup(msgs(0, 300));
  let release = () => {};
  c.api.tailPause = new Promise<void>((r) => (release = r));
  c.ws.serve(snapshot(1, c.api.history));
  c.ws.serve(snapshot(9, c.api.history, { startIndex: undefined }));
  release();
  await new Promise((r) => setTimeout(r, 10));
  const s = c.store.getSnapshot();
  expect(s.historyFailed).toBe(true);
  expect(s.loaded.older).toEqual([]);
});

test.each([
  ["500", { messages: 500 as const }],
  ["不是合法 JSON", { messages: "garbage" as const }],
  ["网络失败", { messages: "network" as const }],
  ["200 但没有 messages", { messages: "shape" as const }],
])("R2 历史取不到（%s）：提示失败，窗口里的消息仍在", async (_n, patch) => {
  const c = setup(msgs(0, 8));
  Object.assign(c.api, patch);
  c.ws.serve(snapshot(1, msgs(0, 8)));
  await settled(c);
  const s = c.store.getSnapshot();
  expect(s.historyFailed).toBe(true);
  expect(s.messages.at(-1)?.text).toBe("m7");
});

test("R2 快照没有 startIndex：不猜起点，提示失败", () => {
  const c = setup(msgs(0, 8));
  c.ws.serve(snapshot(1, msgs(0, 8), { startIndex: undefined }));
  expect(c.store.getSnapshot().historyFailed).toBe(true);
  expect(c.store.getSnapshot().messages).toHaveLength(8);
});

test("R3 跳号：发 resync、丢弃其后的实时帧，新快照到达后恢复", () => {
  const { ws, store } = open(msgs(0, 2));
  ws.serve(frame(3, "message.ended", said("跳号帧")));
  expect(ws.sent.map((m) => m.type)).toEqual(["resync"]);
  ws.serve(frame(4, "message.ended", said("跳号后")));
  expect(store.getSnapshot().messages.map((m) => m.text)).toEqual(["m0", "m1"]);
  ws.serve(snapshot(9, msgs(0, 3)));
  ws.serve(frame(10, "message.ended", said("恢复后")));
  expect(store.getSnapshot().messages.at(-1)?.text).toBe("恢复后");
});

test("R13 加载更早：带游标取下一页拼在前面；失败保留游标可重试", async () => {
  const c = open(msgs(0, 300));
  await settled(c);
  expect(c.store.getSnapshot().loaded.older[0]?.index).toBe(100);
  c.api.messages = 500;
  c.store.loadEarlier();
  await vi.waitFor(() =>
    expect(c.store.getSnapshot().earlierFailed).toBe(true),
  );
  expect(c.store.getSnapshot().loaded.nextBefore).not.toBeNull();
  c.api.messages = 200;
  c.store.loadEarlier();
  await vi.waitFor(() =>
    expect(c.store.getSnapshot().loadingEarlier).toBe(false),
  );
  const s = c.store.getSnapshot();
  expect(s.earlierFailed).toBe(false);
  expect(s.loaded.older[0]?.index).toBe(0);
  expect(s.loaded.nextBefore).toBeNull();
});

test("R13 取数期间游标已变（重新对齐替换了历史块）：丢弃旧结果", async () => {
  const c = open(msgs(0, 300));
  await settled(c);
  let release = () => {};
  c.api.pause = new Promise<void>((r) => (release = r));
  c.store.loadEarlier();
  const cursorBefore = c.store.getSnapshot().loaded.nextBefore;
  // 缺口：断线期间新增超过一页，重新对齐后历史块被新页替换，游标随之改变
  c.api.history.push(...msgs(300, 700));
  c.ws.serve(snapshot(9, c.api.history));
  await vi.waitFor(() =>
    expect(c.store.getSnapshot().loaded.nextBefore).not.toBe(cursorBefore),
  );
  const replaced = c.store.getSnapshot().loaded;
  release();
  await vi.waitFor(() =>
    expect(c.store.getSnapshot().loadingEarlier).toBe(false),
  );
  expect(c.store.getSnapshot().loaded).toEqual(replaced);
});

// ---- 发送、停止与命令回执 ----

test("R7 去除首尾空白后发出 send_message；空白不发；运行中也可发", () => {
  const { ws, store } = open([], { running: true });
  expect(store.send("   ")).toBe(false);
  expect(store.send("  你好  ")).toBe(true);
  expect(ws.sent).toEqual([{ id: "c1", type: "send_message", text: "你好" }]);
});

test("R7 连接未就绪时命令发不出去", () => {
  const { ws, store } = open([]);
  ws.readyState = 3;
  expect(store.send("留着")).toBe(false);
  expect(ws.sent).toEqual([]);
});

test("R8 回执失败：lastError 带错误码与说明，原文放回草稿", () => {
  const { ws, hub, store } = open([]);
  hub.setDraft("s1", "重要内容");
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(hub.draftOf("s1").text).toBe("");
  ws.serve(ack("c1", false, "session_running", "会话正在运行"));
  expect(store.getSnapshot().lastError).toEqual({
    command: "send_message",
    code: "session_running",
    message: "会话正在运行",
  });
  expect(hub.draftOf("s1").text).toBe("重要内容");
});

test("R8 草稿已有新内容时不覆盖，错误仍记录", () => {
  const { ws, hub, store } = open([]);
  hub.setDraft("s1", "甲");
  hub.submit("s1");
  hub.setDraft("s1", "乙");
  ws.serve(ack("c1", false, "bad_request"));
  expect(hub.draftOf("s1").text).toBe("乙");
  expect(store.getSnapshot().lastError?.code).toBe("bad_request");
  // 服务端没给 message：用本地说明兜底
  expect(store.getSnapshot().lastError?.message).toBe("请求无效，请检查后重试");
});

test("R8 断线时未确认的发送放回草稿；已确认的不会", () => {
  const { ws, hub } = open([]);
  hub.setDraft("s1", "送到了");
  hub.submit("s1");
  ws.serve(ack("c1", true));
  hub.setDraft("s1", "没送到");
  hub.submit("s1");
  ws.drop();
  expect(hub.draftOf("s1").text).toBe("没送到");
});

test("R8 连发两条都未确认就断线：按发送顺序合并放回，一条不丢", () => {
  const { ws, hub } = open([], { running: true });
  hub.setDraft("s1", "第一条");
  hub.submit("s1");
  hub.setDraft("s1", "第二条");
  hub.submit("s1");
  ws.drop();
  expect(hub.draftOf("s1").text).toBe("第一条\n第二条");
});

test("R8 先有回执失败放回的内容、再断线：未动过的草稿继续合并", () => {
  const { ws, hub } = open([], { running: true });
  hub.setDraft("s1", "第一条");
  hub.submit("s1");
  hub.setDraft("s1", "第二条");
  hub.submit("s1");
  ws.serve(ack("c1", false, "bad_request", "队列已满"));
  expect(hub.draftOf("s1").text).toBe("第一条");
  ws.drop();
  expect(hub.draftOf("s1").text).toBe("第一条\n第二条");
});

test("R8 放回后用户改过草稿：之后断线放回的内容不覆盖也不拼接", () => {
  const { ws, hub } = open([], { running: true });
  hub.setDraft("s1", "第一条");
  hub.submit("s1");
  hub.setDraft("s1", "第二条");
  hub.submit("s1");
  ws.serve(ack("c1", false, "bad_request", "队列已满"));
  hub.setDraft("s1", "第一条改了");
  ws.drop();
  expect(hub.draftOf("s1").text).toBe("第一条改了");
});

test("R9 停止：回执前 stopPending，回执失败记 lastError 并恢复；run.ended 也恢复", () => {
  const { ws, store } = open([], { running: true });
  store.stop();
  expect(ws.sent).toEqual([{ id: "c1", type: "stop" }]);
  expect(store.getSnapshot().stopPending).toBe(true);
  ws.serve(ack("c1", false, "bad_request", "停不了"));
  expect(store.getSnapshot().stopPending).toBe(false);
  expect(store.getSnapshot().lastError?.message).toBe("停不了");
  store.stop();
  feed(ws)("run.ended");
  expect(store.getSnapshot().stopPending).toBe(false);
  expect(store.getSnapshot().running).toBe(false);
});

test("R9 断线后 stopPending 复位", () => {
  const { ws, store } = open([], { running: true });
  store.stop();
  ws.drop();
  expect(store.getSnapshot().stopPending).toBe(false);
});

// ---- 重连 ----

test("R10 断线：保留已显示内容，3 秒后先探测再建连；新快照追上断线期间的消息", async () => {
  fakeClock();
  const { ws, api, store } = open(msgs(0, 8));
  ws.drop();
  expect(store.getSnapshot().conn).toBe("reconnecting");
  expect(store.getSnapshot().messages).toHaveLength(8);
  await tick(2900);
  expect(api.requests.filter((r) => r === "/api/v1/sessions")).toHaveLength(0);
  expect(FakeWS.all).toHaveLength(1);
  await tick(200);
  expect(api.requests.filter((r) => r === "/api/v1/sessions")).toHaveLength(1);
  expect(FakeWS.all).toHaveLength(2);
  api.history.push(...msgs(8, 10));
  FakeWS.last.serve(snapshot(1, api.history));
  await tick();
  expect(store.getSnapshot().conn).toBe("open");
  expect(store.getSnapshot().messages.at(-1)?.text).toBe("m9");
});

test("R10 探测返回 401：通知外壳，不再建连也不再重试", async () => {
  fakeClock();
  const { ws, api, onUnauthorized } = open([]);
  api.sessions = 401;
  ws.drop();
  await tick(3100);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  await tick(20_000);
  expect(FakeWS.all).toHaveLength(1);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});

test("R10 探测返回 429：提示等待秒数并停止；手动重连可恢复", async () => {
  fakeClock();
  const { ws, api, store } = open([]);
  api.sessions = 429;
  api.retryAfter = "7";
  ws.drop();
  await tick(3100);
  expect(store.getSnapshot().notice).toMatch(/尝试过多.*7 秒/);
  expect(store.getSnapshot().conn).toBe("closed");
  await tick(20_000);
  expect(FakeWS.all).toHaveLength(1);
  api.sessions = 200;
  store.reconnect();
  await tick();
  expect(FakeWS.all).toHaveLength(2);
});

test("R10 探测返回 403：提示来源不被允许并停止", async () => {
  fakeClock();
  const { ws, api, store } = open([]);
  api.sessions = 403;
  ws.drop();
  await tick(3100);
  expect(store.getSnapshot().notice).toMatch(/来源不被允许/);
  await tick(20_000);
  expect(FakeWS.all).toHaveLength(1);
});

test("R10 探测网络失败算一次失败，3 秒后继续探测", async () => {
  fakeClock();
  const { ws, api } = open([]);
  api.sessions = "network";
  ws.drop();
  await tick(3100);
  await tick(3100);
  expect(api.requests.filter((r) => r === "/api/v1/sessions")).toHaveLength(2);
  expect(FakeWS.all).toHaveLength(1);
  api.sessions = 200;
  await tick(3100);
  expect(FakeWS.all).toHaveLength(2);
});

test("R10 连续 5 次连不上快照后停止；收到快照后失败计数清零", async () => {
  fakeClock();
  const { ws, store } = open([]);
  ws.drop();
  for (let i = 0; i < 5; i++) {
    await tick(3100);
    FakeWS.last.drop();
  }
  expect(FakeWS.all).toHaveLength(6);
  await tick(20_000);
  expect(FakeWS.all).toHaveLength(6);
  expect(store.getSnapshot().conn).toBe("closed");

  // 重新来：中途收到一次快照，计数清零
  store.reconnect();
  await tick();
  FakeWS.last.drop();
  await tick(3100);
  FakeWS.last.serve(snapshot(1, []));
  await tick();
  FakeWS.last.drop();
  const before = FakeWS.all.length;
  for (let i = 0; i < 5; i++) {
    await tick(3100);
    FakeWS.last.drop();
  }
  expect(FakeWS.all).toHaveLength(before + 5);
});

test("R1 首帧不是快照：关闭连接、提示协议错误、不自动重连", async () => {
  fakeClock();
  const { ws, store } = setup();
  ws.serve(frame(1, "run.started"));
  expect(ws.closed).toBe(true);
  expect(store.getSnapshot().conn).toBe("closed");
  expect(store.getSnapshot().notice).toMatch(/snapshot/);
  await tick(20_000);
  expect(FakeWS.all).toHaveLength(1);
});

// ---- 弹窗 ----

const approval = {
  promptId: "p1",
  source: "approval",
  title: "允许执行 bash？",
  input: "text",
  options: [{ id: "allow", label: "允许" }],
  expiresAt: Date.now() + 90_000,
};

test("answerPrompt 发 answer_prompt；成功以 prompt.resolved 为准才关闭", () => {
  const { ws, store } = open([], { prompts: [approval] });
  expect(store.getSnapshot().prompts).toHaveLength(1);
  expect(store.answerPrompt("p1", { optionId: "allow" })).toBe(true);
  expect(ws.sent).toEqual([
    { id: "c1", type: "answer_prompt", promptId: "p1", optionId: "allow" },
  ]);
  expect(store.getSnapshot().answering).toBe("p1");
  expect(store.answerPrompt("p1", { optionId: "allow" })).toBe(false);
  ws.serve(ack("c1", true));
  expect(store.getSnapshot().answering).toBeNull();
  expect(store.getSnapshot().prompts).toHaveLength(1);
  ws.serve(
    frame(2, "prompt.resolved", { promptId: "p1", outcome: "answered" }),
  );
  expect(store.getSnapshot().prompts).toEqual([]);
});

test.each([
  ["prompt_resolved", undefined, "已被其他端答复"],
  ["prompt_unknown", undefined, "已不存在"],
  ["bad_request", undefined, "答复无效"],
  ["other", "服务端的话", "服务端的话"],
])("answerPrompt 回执失败（%s）按弹窗提示", (code, message, want) => {
  const { ws, store } = open([], { prompts: [approval] });
  store.answerPrompt("p1", { optionId: "allow" });
  ws.serve(ack("c1", false, code, message));
  expect(store.getSnapshot().promptError?.promptId).toBe("p1");
  expect(store.getSnapshot().promptError?.message).toContain(want);
  expect(store.getSnapshot().answering).toBeNull();
  // 弹窗答复的失败不进 lastError
  expect(store.getSnapshot().lastError).toBeNull();
});

test("answerPrompt 的文字回答可以带附件路径", () => {
  const { ws, store } = open([], { prompts: [approval] });
  store.answerPrompt("p1", {
    text: "见附件",
    attachments: [{ path: "a.pdf" }],
  });
  expect(ws.sent).toEqual([
    {
      id: "c1",
      type: "answer_prompt",
      promptId: "p1",
      text: "见附件",
      attachments: [{ path: "a.pdf" }],
    },
  ]);
});

// ---- 排队消息：取回的是文字 + 附件，编辑时整体替换 ----

test("queueTexts 解析回执里的排队内容；形状不对整体当失败", async () => {
  const { ws, store } = open();
  const good = store.queueTexts();
  ws.serve({
    ...ack("c1"),
    data: {
      queue: [
        {
          text: "看图",
          attachments: [
            {
              name: "a.png",
              mime: "image/png",
              sizeText: "1 KB",
              path: "a.png",
            },
          ],
        },
        { text: "只有字" },
      ],
    },
  });
  expect(await good).toEqual([
    {
      text: "看图",
      attachments: [
        { name: "a.png", mime: "image/png", sizeText: "1 KB", path: "a.png" },
      ],
    },
    { text: "只有字", attachments: [] },
  ]);
  const bad = store.queueTexts();
  ws.serve({ ...ack("c2"), data: { queue: ["旧形状的字符串"] } });
  expect(await bad).toBeNull();
});

test("editQueue 带文字与附件；两者都空不发", () => {
  const { ws, store } = open();
  expect(store.editQueue(0, "  ", [])).toBe(false);
  expect(store.editQueue(1, "", [{ path: "a.png" }])).toBe(true);
  expect(store.editQueue(0, " 改后 ", [])).toBe(true);
  expect(ws.sent).toEqual([
    {
      id: "c1",
      type: "edit_queue",
      index: 1,
      text: "",
      attachments: [{ path: "a.png" }],
    },
    { id: "c2", type: "edit_queue", index: 0, text: "改后", attachments: [] },
  ]);
});

test("弹窗在断线重连后仍在：新快照仍带待处理弹窗", () => {
  const { ws, store } = open([], { prompts: [approval] });
  ws.drop();
  expect(store.getSnapshot().prompts).toHaveLength(1);
});

// ---- 插件的单向 UI 事件 ----

test("extension.ui 的 notify 弹一条 toast，不进对话流；状态条之类这一批先丢弃", async () => {
  const ui = await import("../../../ui");
  const toastSpy = vi.spyOn(ui, "toast");
  const { ws, store } = open([]);
  const before = store.getSnapshot();
  const send = feed(ws);
  send("extension.ui", {
    method: "notify",
    message: "MCP servers need attention",
    notifyType: "warning",
  });
  expect(toastSpy).toHaveBeenCalledTimes(1);
  expect(toastSpy).toHaveBeenCalledWith("MCP servers need attention", {
    tone: "warn",
  });
  send("extension.ui", {
    method: "setStatus",
    statusKey: "k",
    statusText: "忙",
  });
  send("extension.ui", {
    method: "setWidget",
    widgetKey: "k",
    widgetLines: ["a"],
  });
  expect(toastSpy).toHaveBeenCalledTimes(1);
  // 对话状态原样：没有新消息、没有错误
  expect(store.getSnapshot().messages).toEqual(before.messages);
  expect(store.getSnapshot().error).toBe(before.error);
  toastSpy.mockRestore();
});
