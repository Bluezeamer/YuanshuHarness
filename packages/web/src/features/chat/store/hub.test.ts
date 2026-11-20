import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ack,
  FakeWS,
  frame,
  installChatApi,
  msgs,
  snapshot,
} from "../../../test/chatFakes";
import { makeQuote } from "../model/draft";
import { draftKey } from "./draftStorage";
import { ChatHub } from "./hub";

const stored = (): string | null => {
  const raw = localStorage.getItem(draftKey("s1"));
  return raw === null ? null : JSON.parse(raw);
};

beforeEach(() => {
  localStorage.clear();
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const newHub = () =>
  new ChatHub({ token: () => "tok", onUnauthorized: () => {} });

// 打开 s1 并送达快照；connected=false 时不送快照，连接未就绪。
function open(extra: Record<string, unknown> = {}, connected = true) {
  const history = msgs(0, 3);
  const api = installChatApi(history);
  const hub = newHub();
  const store = hub.acquire("s1");
  const ws = FakeWS.last;
  if (connected) ws.serve(snapshot(1, history, extra));
  return { api, hub, store, ws };
}

// ---- 镜像：多个对话标签共用一条连接与一份草稿 ----

test("R12 同一会话重复 acquire 只开一条连接；最后一个释放才关闭", () => {
  const { hub, ws } = open();
  hub.acquire("s1");
  expect(FakeWS.all).toHaveLength(1);
  expect(hub.refs("s1")).toBe(2);
  hub.release("s1");
  expect(ws.closed).toBe(false);
  hub.release("s1");
  expect(ws.closed).toBe(true);
  expect(hub.refs("s1")).toBe(0);
});

test("R11 一个标签收到的帧，所有订阅者都看到同一份", () => {
  const { store, ws } = open();
  const a = vi.fn();
  const b = vi.fn();
  store.subscribe(a);
  store.subscribe(b);
  ws.serve(frame(2, "message.ended", { role: "assistant", text: "同步的话" }));
  expect(a).toHaveBeenCalled();
  expect(b).toHaveBeenCalled();
  expect(store.getSnapshot().messages.at(-1)?.text).toBe("同步的话");
});

test("R11 goal.updated 广播：重新 acquire 的标签拿到同一份目标", () => {
  const { hub, store, ws } = open();
  const goal = {
    id: "g1",
    revision: 1,
    text: "补齐测试",
    by: "user",
    state: "active",
    maxRounds: 50,
    rounds: 0,
    since: "t",
    updatedAt: "t",
  };
  ws.serve(frame(2, "goal.updated", { goal }));
  expect(hub.acquire("s1").getSnapshot().goal).toEqual(goal);
  expect(hub.acquire("s1")).toBe(store);
});

test("R11 一边打字，另一边的草稿立刻同步；发送后两边同时清空", () => {
  const { hub, ws } = open();
  const seen: string[] = [];
  hub.subscribeDrafts(() => seen.push(hub.draftOf("s1").text));
  hub.setDraft("s1", "半截");
  expect(seen).toEqual(["半截"]);
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(ws.commands("send_message")).toHaveLength(1);
  expect(seen.at(-1)).toBe("");
});

test("R14 草稿不随连接释放：切走再回来仍在，且按会话隔离", () => {
  const { hub } = open();
  hub.setDraft("s1", "甲的草稿");
  hub.setDraft("s2", "乙的草稿");
  hub.release("s1");
  hub.acquire("s1");
  expect(hub.draftOf("s1").text).toBe("甲的草稿");
  expect(hub.draftOf("s2").text).toBe("乙的草稿");
  // 引用返回值稳定：没变更时同一个对象
  expect(hub.draftOf("s1")).toBe(hub.draftOf("s1"));
});

// ---- 草稿持久化：刷新不丢（IMPLEMENTATION §4） ----

test("草稿文本落 localStorage；新建 hub（相当于刷新）后原样取回，且按会话隔离", () => {
  const first = newHub();
  first.setDraft("s1", "写到一半\n的话");
  first.setDraft("s2", "另一个会话");
  expect(stored()).toBe("写到一半\n的话");

  const reloaded = newHub();
  expect(reloaded.draftOf("s1").text).toBe("写到一半\n的话");
  expect(reloaded.draftOf("s2").text).toBe("另一个会话");
  expect(reloaded.draftOf("s3").text).toBe("");
  // 取回后返回值仍稳定，供 useSyncExternalStore 比较
  expect(reloaded.draftOf("s1")).toBe(reloaded.draftOf("s1"));
});

test("引用 chip 和附件不落盘：刷新后只剩文本", () => {
  const first = newHub();
  first.setDraft("s1", "带引用的问题");
  first.addQuote("s1", makeQuote("local:/a.txt:L1", "原文"));
  first.addAttachment("s1", {
    name: "x.png",
    mimeType: "image/png",
    size: 3,
    path: "./x.png",
    status: "ready",
    progress: 100,
  });
  const keys = Object.keys(localStorage).filter((k) => k === draftKey("s1"));
  expect(keys).toHaveLength(1);
  expect(stored()).toBe("带引用的问题");

  const reloaded = newHub();
  expect(reloaded.draftOf("s1").text).toBe("带引用的问题");
  expect(reloaded.draftOf("s1").quotes).toHaveLength(0);
  expect(reloaded.draftOf("s1").attachments).toHaveLength(0);
});

test("发送成功后清掉本地草稿；刷新后输入框是空的", () => {
  const { hub } = open();
  hub.setDraft("s1", "这条要发出去");
  expect(stored()).toBe("这条要发出去");
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(stored()).toBeNull();
  expect(newHub().draftOf("s1").text).toBe("");
});

test("清空输入框就删键，不留空条目", () => {
  const hub = newHub();
  hub.setDraft("s1", "先写点");
  hub.setDraft("s1", "");
  expect(stored()).toBeNull();
});

test("发送失败（断线）放回草稿时同步写回本地，刷新后不丢", () => {
  const { hub, ws } = open({ running: true });
  hub.setDraft("s1", "还没送到");
  hub.submit("s1");
  expect(stored()).toBeNull();
  ws.drop();
  expect(hub.draftOf("s1").text).toBe("还没送到");
  expect(stored()).toBe("还没送到");
});

test("/goal 等命令发出后也清掉本地草稿，不会刷新后又冒出来", () => {
  const { hub } = open();
  hub.setDraft("s1", "/goal 补齐测试");
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(stored()).toBeNull();
});

test("发送被拒（内容为空 / 未连接）时本地草稿原样保留", () => {
  const hub = newHub();
  hub.setDraft("s1", "连接还没好");
  expect(hub.submit("s1").ok).toBe(false);
  expect(stored()).toBe("连接还没好");
});

test("discardDraft：会话删除时内存与本地草稿一并清掉，别的会话不受影响", () => {
  const hub = newHub();
  hub.setDraft("s1", "要删的");
  hub.setDraft("s2", "留着的");
  const seen = vi.fn();
  hub.subscribeDrafts(seen);
  hub.discardDraft("s1");
  expect(stored()).toBeNull();
  expect(hub.draftOf("s1").text).toBe("");
  expect(newHub().draftOf("s1").text).toBe("");
  expect(newHub().draftOf("s2").text).toBe("留着的");
  expect(seen).toHaveBeenCalled();
});

test("同源的另一个浏览器标签改了草稿（storage 事件）：这边立刻跟上并通知订阅者", () => {
  const hub = newHub();
  hub.setDraft("s1", "本标签的字");
  const seen: string[] = [];
  const off = hub.subscribeDrafts(() => seen.push(hub.draftOf("s1").text));
  const fromOtherTab = (newValue: string | null) => {
    const raw = newValue === null ? null : JSON.stringify(newValue);
    if (raw === null) localStorage.removeItem(draftKey("s1"));
    else localStorage.setItem(draftKey("s1"), raw);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: draftKey("s1"),
        newValue: raw,
        storageArea: localStorage,
      }),
    );
  };
  fromOtherTab("别的标签写的");
  expect(hub.draftOf("s1").text).toBe("别的标签写的");
  fromOtherTab(null);
  expect(hub.draftOf("s1").text).toBe("");
  expect(seen).toEqual(["别的标签写的", ""]);

  // 无关的键、取消订阅之后都不再响应
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "yuanshu.agents.order",
      newValue: "[]",
      storageArea: localStorage,
    }),
  );
  off();
  fromOtherTab("退订后");
  expect(seen).toHaveLength(2);
});

test("R14 切换会话时断线，未确认的发送回到原会话草稿，不进新会话", () => {
  const { hub, ws } = open({ running: true });
  hub.setDraft("s1", "还没送到");
  hub.submit("s1");
  hub.acquire("s2");
  ws.drop();
  expect(hub.draftOf("s1").text).toBe("还没送到");
  expect(hub.draftOf("s2").text).toBe("");
});

test("hub.configure 换令牌：之后新建的连接用新令牌", () => {
  installChatApi();
  const hub = newHub();
  hub.acquire("s1");
  hub.configure({ token: () => "new", onUnauthorized: () => {} });
  hub.release("s1");
  hub.acquire("s1");
  expect(FakeWS.last.protocols).toEqual(["yuanshu.v1", "bearer.new"]);
});

// ---- 引用 chip 与附件 ----

test("引用 chip 可添加、单独移除；按会话挂在 hub 上，释放连接后仍在", () => {
  const { hub } = open();
  hub.addQuote("s1", makeQuote("local:/a.txt:L1-L2", "甲\n乙"));
  hub.addQuote("s1", makeQuote("docs/x.md", "网页文字"));
  const [first] = hub.draftOf("s1").quotes;
  expect(hub.draftOf("s1").quotes.map((c) => c.quote.label)).toEqual([
    "local:/a.txt:L1-L2",
    "docs/x.md",
  ]);
  hub.removeQuote("s1", first?.id ?? "");
  expect(hub.draftOf("s1").quotes).toHaveLength(1);
  hub.release("s1");
  expect(hub.draftOf("s1").quotes).toHaveLength(1);
});

test("发送时消息里带引用原文，随后 chip 清空", () => {
  const { hub, ws } = open();
  hub.addQuote("s1", makeQuote("local:/a.txt:L2", "const x = 1;"));
  hub.setDraft("s1", "这行为什么这样写？");
  hub.submit("s1");
  const text = (ws.commands("send_message")[0]?.text as string) ?? "";
  expect(text).toContain("Quote local:/a.txt:L2");
  expect(text).toContain("const x = 1;");
  expect(text.endsWith("这行为什么这样写？")).toBe(true);
  expect(hub.draftOf("s1").quotes).toHaveLength(0);
});

test("没连上发不出去时 chip 与草稿保留，能重发", () => {
  const { hub, ws } = open({}, false);
  hub.addQuote("s1", makeQuote("local:/a.txt:L1", "留着"));
  hub.setDraft("s1", "问题");
  const r = hub.submit("s1");
  expect(r.ok).toBe(false);
  expect(ws.commands("send_message")).toHaveLength(0);
  expect(hub.draftOf("s1").quotes).toHaveLength(1);
  expect(hub.draftOf("s1").text).toBe("问题");
  ws.serve(snapshot(1, msgs(0, 3)));
  expect(hub.submit("s1")).toEqual({ ok: true });
});

test("发送失败：原问题与引用 chip 都放回草稿，不把围栏拼进文本", () => {
  const { hub, ws } = open();
  hub.addQuote("s1", makeQuote("local:/a.txt:L2", "const x = 1;"));
  hub.setDraft("s1", "问题");
  hub.submit("s1");
  expect(hub.draftOf("s1").quotes).toHaveLength(0);
  ws.serve(ack("c1", false, "bad_request"));
  expect(hub.draftOf("s1").text).toBe("问题");
  expect(hub.draftOf("s1").quotes.map((c) => c.quote.label)).toEqual([
    "local:/a.txt:L2",
  ]);
});

test("附件以引用随 send_message 发出；失败时放回", () => {
  const { hub, ws } = open();
  hub.addAttachment("s1", {
    name: "a.png",
    mimeType: "image/png",
    size: 3,
    path: "./2026-10-27/ab12-a.png",
    status: "ready",
    progress: 100,
  });
  hub.setDraft("s1", "看图");
  hub.submit("s1");
  expect(ws.sent[0]).toEqual({
    id: "c1",
    type: "send_message",
    text: "看图",
    attachments: [
      {
        name: "a.png",
        mimeType: "image/png",
        size: 3,
        path: "./2026-10-27/ab12-a.png",
      },
    ],
  });
  expect(hub.draftOf("s1").attachments).toEqual([]);
  ws.serve(ack("c1", false, "bad_request"));
  expect(hub.draftOf("s1").attachments.map((a) => a.name)).toEqual(["a.png"]);
});

test("只有附件没有文字也能发；什么都没有则不发", () => {
  const { hub, ws } = open();
  expect(hub.submit("s1")).toEqual({ ok: false, message: "内容为空" });
  hub.addAttachment("s1", {
    name: "a.txt",
    mimeType: "text/plain",
    size: 1,
    path: "./a.txt",
    status: "ready",
    progress: 100,
  });
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(ws.commands("send_message")).toHaveLength(1);
});

test("上传中的附件阻止发送；上传失败给出可操作提示；ready 后恢复", () => {
  const { hub, ws } = open();
  const att = hub.addAttachment("s1", {
    name: "big.bin",
    mimeType: "application/octet-stream",
    size: 2048,
    path: "",
    status: "uploading",
    progress: 10,
  });
  hub.setDraft("s1", "发个文件");
  expect(hub.submit("s1")).toEqual({
    ok: false,
    message: "附件还在上传，请稍候再发送",
  });
  expect(ws.sent).toEqual([]);
  expect(hub.draftOf("s1").text).toBe("发个文件");

  hub.updateAttachment("s1", att.id, { status: "error", error: "文件太大" });
  expect(hub.submit("s1")).toEqual({
    ok: false,
    message: "附件「big.bin」上传失败，请重试或移除",
  });
  expect(ws.sent).toEqual([]);

  hub.updateAttachment("s1", att.id, {
    status: "ready",
    path: "./big.bin",
    progress: 100,
    error: undefined,
  });
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(ws.commands("send_message")).toHaveLength(1);
});

test("updateAttachment 只改草稿里已有的附件；已移除的更新被忽略", () => {
  const { hub } = open();
  const att = hub.addAttachment("s1", {
    name: "a.png",
    mimeType: "image/png",
    size: 3,
    path: "",
    status: "uploading",
    progress: 0,
  });
  expect(att.id).toBe("a1");
  hub.updateAttachment("s1", "a1", { progress: 42 });
  expect(hub.draftOf("s1").attachments[0]?.progress).toBe(42);
  hub.removeAttachment("s1", "a1");
  hub.updateAttachment("s1", "a1", { status: "ready", path: "./a.png" });
  expect(hub.draftOf("s1").attachments).toEqual([]);
});

// ---- 输入分流：/goal、/compact 不走 send_message ----

test("/goal 文字走 set_goal，不发 send_message；草稿清空", () => {
  const { hub, ws } = open();
  hub.setDraft("s1", "/goal 把测试补齐");
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(ws.sent).toEqual([{ id: "c1", type: "set_goal", text: "把测试补齐" }]);
  expect(hub.draftOf("s1").text).toBe("");
});

test("空 /goal 不发命令，返回错误且草稿保留", () => {
  const { hub, ws } = open();
  hub.setDraft("s1", "/goal");
  expect(hub.submit("s1")).toEqual({
    ok: false,
    message: "在 /goal 后写目标，或 pause / resume / clear / edit <目标>",
  });
  expect(ws.sent).toEqual([]);
  expect(hub.draftOf("s1").text).toBe("/goal");
});

// 目标和消息一样可以附文件：草稿里的附件随 /goal 与 /goal edit 发出（只带路径），用掉的附件清出草稿
const readyFile = {
  name: "spec.pdf",
  mimeType: "application/pdf",
  size: 3,
  path: "./2026-11-17/ab12-spec.pdf",
  status: "ready" as const,
  progress: 100,
};

test("/goal 带草稿里的附件：set_goal 带路径，附件清出草稿、引用留着", () => {
  const { hub, ws } = open();
  hub.addAttachment("s1", readyFile);
  hub.addQuote("s1", makeQuote("local:/a.txt:L1", "引用"));
  hub.setDraft("s1", "/goal 按规格书实现");
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(ws.sent).toEqual([
    {
      id: "c1",
      type: "set_goal",
      text: "按规格书实现",
      attachments: [{ path: "./2026-11-17/ab12-spec.pdf" }],
    },
  ]);
  expect(hub.draftOf("s1").attachments).toEqual([]);
  expect(hub.draftOf("s1").quotes).toHaveLength(1);
});

test("/goal edit 有附件才带 attachments（整体替换），没有就不动目标的附件", () => {
  const { hub, ws } = open();
  hub.setDraft("s1", "/goal edit 改成补文档");
  hub.submit("s1");
  hub.addAttachment("s1", readyFile);
  hub.setDraft("s1", "/goal edit 改成补文档");
  hub.submit("s1");
  expect(ws.sent).toEqual([
    { id: "c1", type: "edit_goal", text: "改成补文档" },
    {
      id: "c2",
      type: "edit_goal",
      text: "改成补文档",
      attachments: [{ path: "./2026-11-17/ab12-spec.pdf" }],
    },
  ]);
});

test("/goal 的附件还在上传：不发命令，草稿原样保留", () => {
  const { hub, ws } = open();
  hub.addAttachment("s1", { ...readyFile, status: "uploading", progress: 10 });
  hub.setDraft("s1", "/goal 按规格书实现");
  expect(hub.submit("s1")).toEqual({
    ok: false,
    message: "附件还在上传，请稍候再发送",
  });
  expect(ws.sent).toEqual([]);
  expect(hub.draftOf("s1").attachments).toHaveLength(1);
});

test.each([
  ["/goal pause", { type: "pause_goal" }],
  ["/goal resume", { type: "resume_goal" }],
  ["/goal clear", { type: "clear_goal" }],
  ["/goal edit 改成补文档", { type: "edit_goal", text: "改成补文档" }],
])("%s 走对应的目标命令，草稿清空", (input, want) => {
  const { hub, ws } = open();
  hub.setDraft("s1", input);
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(ws.sent).toEqual([{ id: "c1", ...want }]);
  expect(hub.draftOf("s1").text).toBe("");
});

test("/compact 走 compact 命令，受理后 compacting 直到 context.compacted", () => {
  const { hub, store, ws } = open();
  hub.setDraft("s1", "/compact");
  expect(hub.submit("s1")).toEqual({ ok: true });
  expect(ws.sent).toEqual([{ id: "c1", type: "compact" }]);
  expect(store.getSnapshot().compacting).toBe(true);
  expect(store.compact()).toBe(false);
  ws.serve(frame(2, "context.compacted", { summary: "摘要", savedPct: 50 }));
  expect(store.getSnapshot().compacting).toBe(false);
  expect(store.getSnapshot().compact?.savedPct).toBe(50);
});

test.each(["/plan 重构登录", "/review", "/my-skill 参数"])(
  "%s 当普通消息发给模型",
  (text) => {
    const { hub, ws } = open();
    hub.setDraft("s1", text);
    hub.submit("s1");
    expect(ws.sent).toEqual([{ id: "c1", type: "send_message", text }]);
  },
);

test("submit 传 text 只发这段文字，不动草稿与引用", () => {
  const { hub, ws } = open();
  hub.setDraft("s1", "草稿别动");
  hub.addQuote("s1", makeQuote("a", "b"));
  expect(hub.submit("s1", "快捷问题")).toEqual({ ok: true });
  expect(ws.sent).toEqual([
    { id: "c1", type: "send_message", text: "快捷问题" },
  ]);
  expect(hub.draftOf("s1").text).toBe("草稿别动");
  expect(hub.draftOf("s1").quotes).toHaveLength(1);
});

test("会话没有连接时 submit 失败而不抛错", () => {
  const hub = newHub();
  hub.setDraft("x", "hi");
  expect(hub.submit("x")).toEqual({ ok: false, message: "会话未连接" });
});

// ---- 目标命令与压缩：逐条 ack ----

test("目标命令逐条发出，id 递增", () => {
  const { store, ws } = open();
  store.setGoal("甲");
  store.editGoal({ text: "乙" });
  store.editGoal({ maxRounds: null });
  store.editGoal({ text: "丙", maxRounds: 20 });
  store.editGoal({ attachments: [] });
  store.pauseGoal();
  store.resumeGoal();
  store.clearGoal();
  expect(ws.sent).toEqual([
    { id: "c1", type: "set_goal", text: "甲" },
    { id: "c2", type: "edit_goal", text: "乙" },
    // null = 改成不限，要原样带上
    { id: "c3", type: "edit_goal", maxRounds: null },
    { id: "c4", type: "edit_goal", text: "丙", maxRounds: 20 },
    // 空数组 = 清空附件，同样要带上
    { id: "c5", type: "edit_goal", attachments: [] },
    { id: "c6", type: "pause_goal" },
    { id: "c7", type: "resume_goal" },
    { id: "c8", type: "clear_goal" },
  ]);
  expect(store.setGoal("  ")).toBe(false);
  expect(store.editGoal({ text: "" })).toBe(false);
});

test.each([
  [
    "edit_goal",
    (s: ReturnType<ChatHub["acquire"]>) => s.editGoal({ text: "x" }),
    "no_goal",
    "当前没有长期目标",
  ],
  [
    "pause_goal",
    (s: ReturnType<ChatHub["acquire"]>) => s.pauseGoal(),
    "no_goal",
    undefined,
  ],
  [
    "set_goal",
    (s: ReturnType<ChatHub["acquire"]>) => s.setGoal("x"),
    "bad_request",
    "text 不能为空",
  ],
  [
    "compact",
    (s: ReturnType<ChatHub["acquire"]>) => s.compact(),
    "session_running",
    "会话正在运行或压缩中",
  ],
])(
  "%s 回执失败转 lastError（带错误码与中文说明）",
  (command, act, code, message) => {
    const { store, ws } = open();
    act(store);
    ws.serve(ack("c1", false, code, message));
    const err = store.getSnapshot().lastError;
    expect(err).toMatchObject({ command, code });
    expect(err?.message).toBeTruthy();
    if (message) expect(err?.message).toBe(message);
    // 下一条命令发出时清掉旧错误；也可手动关闭
    store.clearGoal();
    expect(store.getSnapshot().lastError).toBeNull();
  },
);

test("compact 被拒后 compacting 复位；dismissError 清错误", () => {
  const { store, ws } = open();
  store.compact();
  ws.serve(ack("c1", false, "session_running", ""));
  expect(store.getSnapshot().compacting).toBe(false);
  expect(store.getSnapshot().lastError?.message).toBe(
    "会话正在运行或压缩中，稍后再试",
  );
  store.dismissError();
  expect(store.getSnapshot().lastError).toBeNull();
});

test("context.compact_failed 复位 compacting 并记原因", () => {
  const { store, ws } = open();
  store.compact();
  ws.serve(ack("c1", true));
  ws.serve(frame(2, "context.compact_failed", { message: "模型不可用" }));
  expect(store.getSnapshot().compacting).toBe(false);
  expect(store.getSnapshot().compactError).toBe("模型不可用");
});

test("连接未就绪时目标命令不发、返回 false", () => {
  const { store, ws } = open();
  ws.readyState = 3;
  expect(store.setGoal("x")).toBe(false);
  expect(store.compact()).toBe(false);
  expect(ws.sent).toEqual([]);
});

// ---- 用量刷新 ----

const usage = {
  turns: 1,
  steps: 2,
  tokensPerSecond: 50,
  modelMs: 4000,
  tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0 },
  cacheHitRate: 0.5,
  context: {
    used: 1200,
    window: 8000,
    system: 100,
    tools: 100,
    messages: 1000,
  },
};
const call = {
  tokens: {
    system: 100,
    tools: 100,
    history: 500,
    current: 300,
    out: 200,
    cacheRead: 0,
    cacheWrite: 0,
    estimated: true,
  },
};

test("一轮结束后重取 /usage 与最近一次调用，精确值覆盖本地累加", async () => {
  const { api, store, ws } = open({ usage });
  api.usage = { ...usage, steps: 4, tokens: { ...usage.tokens, input: 2500 } };
  api.calls = [call];
  ws.serve(
    frame(2, "run.ended", {
      usage: { input: 1500, output: 100, cacheRead: 0, cacheWrite: 0 },
      steps: 2,
      turn: 2,
    }),
  );
  // 先看到本地累加值
  expect(store.getSnapshot().usage?.tokens.input).toBe(2500);
  await vi.waitFor(() => expect(store.getSnapshot().lastCall).not.toBeNull());
  expect(store.getSnapshot().usage?.steps).toBe(4);
  expect(store.getSnapshot().lastCall).toEqual(call.tokens);
  expect(api.requests).toContain("/api/v1/sessions/s1/usage");
  expect(api.requests).toContain("/api/v1/sessions/s1/calls?limit=1");
});

test("没有调用记录库（无 usage 字段）：不发 /usage 与 /calls 请求", async () => {
  const { api, ws } = open();
  ws.serve(frame(2, "run.ended", { aborted: false }));
  await new Promise((r) => setTimeout(r, 10));
  expect(api.requests.some((r) => r.includes("/usage"))).toBe(false);
  expect(api.requests.some((r) => r.includes("/calls"))).toBe(false);
});

test("重连快照带 usage 且已有调用：补取最近一次调用；取不到不报错", async () => {
  const { api, store } = open({ usage });
  await vi.waitFor(() =>
    expect(api.requests).toContain("/api/v1/sessions/s1/calls?limit=1"),
  );
  expect(store.getSnapshot().lastCall).toBeNull();
  expect(store.getSnapshot().lastError).toBeNull();
  expect(store.getSnapshot().usage?.steps).toBe(2);
});

// ---- 文件监听：同一会话多个组件订阅时按 env 取并集，只发一条 watch ----

test("文件监听：两个订阅者取并集，退订后发剩余的并集，最后一个退订发空数组", () => {
  const { hub, ws } = open();
  // 两个组件订阅同一个目录 + 一个额外文件
  hub.setWatch("s1", "a", "local", ["/w"]);
  hub.setWatch("s1", "b", "local", ["/w", "/w/x.ts"]);
  // 每次并集变化发一条，最后一条就是当前并集
  const last = () => ws.commands("watch").at(-1)?.paths;
  expect(last()).toEqual(["/w", "/w/x.ts"]);

  // 完全相同的并集（顺序不同也算同一个）不再重复发
  const count = ws.commands("watch").length;
  hub.setWatch("s1", "b", "local", ["/w/x.ts", "/w"]);
  expect(ws.commands("watch")).toHaveLength(count);

  // a 退订：并集仍是 b 那两个，不发新命令
  hub.setWatch("s1", "a", "local", []);
  expect(ws.commands("watch")).toHaveLength(count);

  // b 改成只盯一个：并集变化，补发
  const before = ws.commands("watch").length;
  hub.setWatch("s1", "b", "local", ["/w/x.ts"]);
  expect(ws.commands("watch")).toHaveLength(before + 1);
  expect(last()).toEqual(["/w/x.ts"]);

  // 最后一个人退订：发空数组让服务端释放底层监听
  hub.setWatch("s1", "b", "local", []);
  expect(last()).toEqual([]);
});

test("文件监听：连接还没就绪时先记下，快照到达后补发", () => {
  const history = msgs(0, 3);
  installChatApi(history);
  const hub = newHub();
  hub.acquire("s1");
  const ws = FakeWS.last;
  hub.setWatch("s1", "a", "local", ["/w"]);
  expect(ws.commands("watch")).toHaveLength(0);
  ws.serve(snapshot(1, history));
  expect(ws.commands("watch")).toHaveLength(1);
  expect(ws.commands("watch")[0]?.paths).toEqual(["/w"]);
});
