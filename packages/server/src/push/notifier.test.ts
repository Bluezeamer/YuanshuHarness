// 通知的触发与策略：真 SessionFeed + 假 send + 假定时器。
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import type { SessionStatus, SessionView } from "../session/library.js";
import type { FeedEvent } from "../session/session-feed.js";
import { SessionFeed } from "../session/session-feed.js";
import { type Db, openDatabase } from "../store/db.js";
import { DeviceStore } from "../store/devices.js";
import { type PushPrefs, PushStore } from "../store/push.js";
import { PushNotifier } from "./notifier.js";
import type { PushPayload } from "./payload.js";
import type { PushSender, SendResult } from "./sender.js";

const SID = "sess-1";

let db: Db;
let devices: DeviceStore;
let store: PushStore;
let feed: SessionFeed;
let notifier: PushNotifier;
let views: Map<string, SessionView>;
let calls: { endpoint: string; payload: PushPayload }[];
let reply: (endpoint: string) => SendResult;
let logs: string[];

const view = (
  id: string,
  status: SessionStatus,
  title = "标题",
): SessionView => ({
  id,
  name: title,
  preview: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  running: status === "running",
  directoryId: "dir",
  promptPresetId: null,
  modePresetIds: [],
  activeModeId: null,
  title,
  no: null,
  status,
  lifecycle: status === "archived" ? "archived" : "active",
  workspaceId: null,
  parentSessionId: null,
  forkEntryId: null,
  unreadResult: false,
  unreadError: false,
  pinned: false,
});

const makeSend = (): PushSender => async (target, payload) => {
  calls.push({ endpoint: target.endpoint, payload });
  return reply(target.endpoint);
};

beforeEach(() => {
  vi.useFakeTimers();
  db = openDatabase(makeTmpDir("yuanshu-notifier-"));
  devices = new DeviceStore(db);
  store = new PushStore(db);
  views = new Map([[SID, view(SID, "idle")]]);
  feed = new SessionFeed({
    list: () => [...views.values()],
    view: (id) => views.get(id) ?? null,
    topOf: (id) => id,
    isListed: () => true,
    // 与真 feed 一致：看过就清未读标记，视图随之变化、发一条 updated。
    clearMarks: (id) => {
      const v = views.get(id);
      if (v) views.set(id, { ...v, unreadResult: false, unreadError: false });
    },
  });
  calls = [];
  logs = [];
  reply = () => ({ ok: true });
  notifier = new PushNotifier({
    store,
    feed,
    send: makeSend(),
    log: (m, err) => logs.push(err === undefined ? m : `${m}：${reason(err)}`),
  });
  notifier.start();
});

afterEach(() => {
  notifier.stop();
  vi.useRealTimers();
  db.close();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

/** 一台订阅中的设备；prefs 只改给出的字段。 */
function device(name: string, prefs: Partial<PushPrefs> = {}): string {
  const id = devices.create(name).device.id;
  store.upsert(id, {
    endpoint: `https://push.example/${name}`,
    p256dh: "p",
    auth: "a",
  });
  if (Object.keys(prefs).length > 0) store.setPrefs(id, prefs);
  return id;
}

/** 把一个新视图推给 feed（内容得变，feed 才发事件）。 */
function pushStatus(
  status: SessionStatus,
  title = "标题",
  marks: { unreadResult?: boolean; unreadError?: boolean } = {},
) {
  views.set(SID, { ...view(SID, status, title), ...marks });
  feed.touch(SID);
}

const kinds = () => calls.map((c) => c.payload.kind);
const at = (name: string) =>
  calls.filter((c) => c.endpoint.endsWith(`/${name}`));
const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

test("blocked 只在「刚刚变成 blocked」时触发一次", async () => {
  device("a");
  pushStatus("blocked");
  pushStatus("blocked", "标题改了");
  await flush();
  expect(kinds()).toEqual(["blocked"]);
  expect(calls[0]?.payload).toEqual({
    v: 1,
    kind: "blocked",
    sid: SID,
    title: "标题",
    tag: `s:${SID}`,
  });
});

test("archived 的会话不触发；已发出的 blocked 被归档算处理过（补 resolved）", async () => {
  device("a", { policy: "always" });
  pushStatus("archived");
  await flush();
  expect(calls).toEqual([]);

  pushStatus("blocked");
  await flush();
  pushStatus("archived");
  await flush();
  expect(kinds()).toEqual(["blocked", "resolved"]);
});

test("session.removed 清掉待发定时器；之后重新出现仍是 blocked 会再触发", async () => {
  device("a", { policy: "delay", delaySec: 30 });
  pushStatus("blocked");
  await vi.advanceTimersByTimeAsync(10_000);
  feed.removed(SID);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toEqual([]);

  views.set(SID, view(SID, "blocked"));
  feed.touch(SID);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(kinds()).toEqual(["blocked"]);
});

test("always 不受「有人在看」影响；三类事件各自开关", async () => {
  device("a", {
    policy: "always",
    blocked: true,
    error: false,
    done: false,
  });
  feed.setViewing("c1", [SID]);
  pushStatus("blocked");
  notifier.turnEnded(SID, "标题", true);
  notifier.turnEnded(SID, "标题", false);
  await flush();
  expect(kinds()).toEqual(["blocked"]);

  store.setPrefs(store.list()[0]?.deviceId ?? "", { error: true });
  pushStatus("idle");
  await flush();
  // 已经发了 blocked、现在不再 blocked：补一条 resolved，然后才是新的 blocked 与 error
  expect(kinds()).toEqual(["blocked", "resolved"]);
  pushStatus("blocked");
  notifier.turnEnded(SID, "标题", true);
  await flush();
  expect(kinds()).toEqual(["blocked", "resolved", "blocked", "error"]);
});

test("unwatched：此刻有人在看就不发，没人看才发", async () => {
  device("a", { policy: "unwatched", done: true });
  feed.setViewing("c1", [SID]);
  pushStatus("blocked");
  notifier.turnEnded(SID, "标题", false);
  await flush();
  expect(calls).toEqual([]);

  feed.setViewing("c1", []);
  pushStatus("idle");
  pushStatus("blocked");
  notifier.turnEnded(SID, "标题", false);
  await flush();
  expect(kinds()).toEqual(["blocked", "done"]);
});

test("delay：到点仍成立才发；期间被处理（不再 blocked）就不发", async () => {
  device("a", { policy: "delay", delaySec: 30 });
  pushStatus("blocked");
  pushStatus("idle");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toEqual([]);

  pushStatus("blocked");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(kinds()).toEqual(["blocked"]);
});
test("delay：新触发替换旧定时器", async () => {
  device("a", { policy: "delay", delaySec: 30 });
  pushStatus("blocked");
  await vi.advanceTimersByTimeAsync(20_000);
  pushStatus("idle");
  pushStatus("blocked");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls).toEqual([]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(kinds()).toEqual(["blocked"]);
});

test("delay：error / done 到点时被看或重新开始跑就不发", async () => {
  device("a", { policy: "delay", delaySec: 5, done: true, error: true });

  // 重新跑起来
  pushStatus("running");
  notifier.turnEnded(SID, "标题", true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(calls).toEqual([]);

  // 到点时被看了
  pushStatus("idle");
  notifier.turnEnded(SID, "标题", false);
  feed.setViewing("c1", [SID]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(calls).toEqual([]);

  feed.setViewing("c1", []);
  pushStatus("idle", "换个标题");
  notifier.turnEnded(SID, "换个标题", false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(kinds()).toEqual(["done"]);
});

test("delay：blocked 到点时有人在看就不发（审批仍挂着也一样）；等待期间关掉这类通知就不发", async () => {
  const a = device("a", { policy: "delay", delaySec: 30 });
  pushStatus("blocked");
  feed.setViewing("c1", [SID]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toEqual([]);

  feed.setViewing("c1", []);
  pushStatus("idle");
  pushStatus("blocked");
  store.setPrefs(a, { blocked: false });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toEqual([]);
});

test("多设备偏好互不影响：一台 always 一台 delay", async () => {
  const a = device("a", { policy: "always" });
  const b = device("b", { policy: "delay", delaySec: 60 });
  pushStatus("blocked");
  await flush();
  expect(calls.map((c) => c.endpoint)).toEqual(["https://push.example/a"]);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls.map((c) => c.endpoint)).toEqual([
    "https://push.example/a",
    "https://push.example/b",
  ]);
  expect(store.get(a)?.prefs.policy).toBe("always");
  expect(store.get(b)?.prefs.policy).toBe("delay");
});

test("turnEnded：error / done 按偏好发，标题取传入的", async () => {
  device("a", { policy: "always", done: false });
  notifier.turnEnded(SID, "出错的那轮", true);
  notifier.turnEnded(SID, "跑完的那轮", false);
  await flush();
  expect(kinds()).toEqual(["error"]);
  expect(calls[0]?.payload.title).toBe("出错的那轮");

  store.setPrefs(store.list()[0]?.deviceId ?? "", { done: true });
  notifier.turnEnded(SID, "跑完的那轮", false);
  await flush();
  expect(kinds()).toEqual(["error", "done"]);
  expect(calls[1]?.payload.title).toBe("跑完的那轮");
});

test("已发的 blocked：会话不再是 blocked → 补一条 resolved，且只补一次", async () => {
  device("a", { policy: "always" });
  pushStatus("blocked");
  await flush();
  pushStatus("idle");
  await flush();
  expect(kinds()).toEqual(["blocked", "resolved"]);
  expect(calls[1]?.payload.tag).toBe(`s:${SID}`);

  pushStatus("running");
  pushStatus("idle");
  await flush();
  expect(kinds().filter((k) => k === "resolved")).toHaveLength(1);
  // 处理完，仍未读：blocked 重新出现才再发一条新的
  pushStatus("blocked");
  await flush();
  expect(kinds()).toEqual(["blocked", "resolved", "blocked"]);
});

test("已发的 error / done：重新开始跑或被看 → resolved", async () => {
  device("a", { policy: "always", done: true });
  notifier.turnEnded(SID, "标题", false);
  await flush();
  pushStatus("running");
  await flush();
  expect(kinds()).toEqual(["done", "resolved"]);

  // 另一轮出错：未读标在视图上；开始看它清掉标记 → 一条 updated → 补 resolved
  pushStatus("idle");
  pushStatus("running");
  pushStatus("idle");
  notifier.turnEnded(SID, "标题", true);
  await flush();
  expect(kinds()).toEqual(["done", "resolved", "error"]);
  pushStatus("idle", "标题", { unreadError: true });
  feed.setViewing("c1", [SID]);
  await flush();
  expect(kinds()).toEqual(["done", "resolved", "error", "resolved"]);

  // resolved 不重复
  feed.setViewing("c1", []);
  feed.setViewing("c2", [SID]);
  await flush();
  expect(kinds().filter((k) => k === "resolved")).toHaveLength(2);
});

test("gone（404 / 410）→ 删订阅；别的设备照常收到", async () => {
  const gone = device("gone", { policy: "always" });
  device("ok", { policy: "always" });
  reply = (endpoint) =>
    endpoint.endsWith("/gone")
      ? { ok: false, gone: true, status: 410, error: "410 gone" }
      : { ok: true };

  pushStatus("blocked");
  await flush();
  expect(store.get(gone)).toBeNull();
  expect(at("ok")).toHaveLength(1);
  expect(store.list()).toHaveLength(1);
});

test("普通失败只记日志：不重试、不删订阅", async () => {
  const a = device("a", { policy: "always" });
  reply = () => ({
    ok: false,
    gone: false,
    status: 500,
    error: "500 端点说不",
  });
  pushStatus("blocked");
  await flush();
  expect(calls).toHaveLength(1);
  expect(logs.join("\n")).toContain("500");
  expect(store.get(a)).not.toBeNull();
});

test("send 抛异常也不外溢，只记日志", async () => {
  notifier.stop();
  notifier = new PushNotifier({
    store,
    feed,
    send: () => {
      throw new Error("网络炸了");
    },
    log: (m, err) => logs.push(err === undefined ? m : `${m}：${reason(err)}`),
  });
  notifier.start();
  device("a", { policy: "always" });
  expect(() => pushStatus("blocked")).not.toThrow();
  await flush();
  expect(logs.join("\n")).toContain("网络炸了");
});

test("stop() 清掉待发定时器；重复 start 不会重复订阅", async () => {
  device("a", { policy: "delay", delaySec: 30, done: true });
  pushStatus("blocked");
  notifier.turnEnded(SID, "标题", false);
  notifier.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toEqual([]);

  notifier.start();
  notifier.start();
  pushStatus("idle");
  pushStatus("blocked");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(kinds()).toEqual(["blocked"]);
});

test("test()：没订阅返回 null；有订阅发一条 kind=test", async () => {
  expect(await notifier.test("nobody")).toBeNull();
  const a = device("a");
  expect(await notifier.test(a)).toEqual({ ok: true });
  expect(calls[0]?.payload).toMatchObject({
    kind: "test",
    sid: "",
    tag: "test",
  });
});

test("test() 失败也不抛，gone 时订阅被删", async () => {
  const a = device("a");
  reply = () => ({ ok: false, gone: true, status: 404, error: "404" });
  expect(await notifier.test(a)).toMatchObject({ ok: false, gone: true });
  expect(store.get(a)).toBeNull();
});

test("没订阅时什么都不发", async () => {
  pushStatus("blocked");
  notifier.turnEnded(SID, "标题", true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toEqual([]);
});

// 类型上用一下，说明 FeedEvent 只从这里来（编译期约束，别让 helper 飘走）。
const _feedEventType: FeedEvent["type"] = "session.updated";
void _feedEventType;
