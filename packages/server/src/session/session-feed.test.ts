import { describe, expect, test } from "vitest";
import type { SessionView } from "./library.js";
import { type FeedEvent, SessionFeed } from "./session-feed.js";

// 视图字段很多，测试只关心随视图变化的少数字段。
const view = (id: string, status = "idle"): SessionView =>
  ({ id, title: id, status, unreadResult: false }) as SessionView;

function world(init: {
  views?: SessionView[];
  parents?: Record<string, string>;
}) {
  const views = new Map<string, SessionView>();
  for (const v of init.views ?? []) views.set(v.id, v);
  const parents = init.parents ?? {};
  const cleared: string[] = [];
  const feed = new SessionFeed({
    list: () => [...views.values()],
    view: (id) => views.get(id) ?? null,
    topOf: (id) => parents[id] ?? id,
    isListed: (id) => !(id in parents),
    clearMarks: (id) => cleared.push(id),
  });
  const events: FeedEvent[] = [];
  feed.subscribe((e) => events.push(e));
  return { views, cleared, feed, events };
}

describe("列表级事件", () => {
  test("首次 touch 发 added，视图没变不发，变了发 updated", () => {
    const w = world({});
    w.views.set("a", view("a"));
    w.feed.touch("a");
    expect(w.events).toEqual([
      { type: "session.added", data: { session: view("a") } },
    ]);
    w.feed.touch("a");
    expect(w.events).toHaveLength(1);
    w.views.set("a", view("a", "running"));
    w.feed.touch("a");
    expect(w.events).toHaveLength(2);
    expect(w.events[1]).toMatchObject({
      type: "session.updated",
      data: { session: { id: "a", status: "running" } },
    });
  });

  test("快照之后的变化按 updated 发，不再重复发 added", () => {
    const w = world({ views: [view("a")] });
    expect(w.feed.snapshot().map((v) => v.id)).toEqual(["a"]);
    w.views.set("a", view("a", "blocked"));
    w.feed.touch("a");
    expect(w.events.map((e) => e.type)).toEqual(["session.updated"]);
  });

  test("removed：只对推过的会话发一次", () => {
    const w = world({ views: [view("a")] });
    w.feed.snapshot();
    w.feed.removed("a");
    w.feed.removed("a");
    expect(w.events).toEqual([{ type: "session.removed", data: { id: "a" } }]);
  });

  test("子代理会话的变化落到它的根会话那一行", () => {
    const w = world({
      views: [view("root", "idle")],
      parents: { child: "root" },
    });
    w.views.set("root", view("root", "running"));
    w.feed.touch("child");
    expect(w.events).toEqual([
      {
        type: "session.added",
        data: { session: view("root", "running") },
      },
    ]);
    // 子代理自己不在列表里
    expect(w.feed.snapshot().map((v) => v.id)).toEqual(["root"]);
  });

  test("子代理会话被删：根会话那一行改成它的新视图，不发 removed", () => {
    const w = world({
      views: [view("root", "running")],
      parents: { child: "root" },
    });
    w.feed.snapshot();
    w.views.set("root", view("root", "idle"));
    w.feed.removed("child");
    expect(w.events).toEqual([
      { type: "session.updated", data: { session: view("root", "idle") } },
    ]);
  });
});

describe("在看", () => {
  test("新进入被看集合的会话被清标记并推一次变化；多个连接取并集", () => {
    const w = world({ views: [view("a"), view("b")] });
    w.feed.snapshot();
    w.feed.setViewing("c1", ["a"]);
    expect(w.cleared).toEqual(["a"]);
    expect(w.events).toHaveLength(0);
    w.feed.setViewing("c2", ["b"]);
    expect(w.cleared).toEqual(["a", "b"]);
    expect(w.feed.watched("a")).toBe(true);
    expect(w.feed.watched("b")).toBe(true);
    // 整份替换：c1 改成只看 b，a 不再被看
    w.feed.setViewing("c1", ["b"]);
    expect(w.feed.watched("a")).toBe(false);
    expect(w.feed.watched("b")).toBe(true);
  });

  test("清掉标记后视图变化会推 updated", () => {
    const w = world({ views: [view("a")] });
    w.feed.snapshot();
    const marked = { ...view("a"), unreadResult: true };
    w.views.set("a", marked);
    w.feed.touch("a");
    w.views.set("a", view("a"));
    w.feed.setViewing("c1", ["a"]);
    expect(w.events.map((e) => e.type)).toEqual([
      "session.updated",
      "session.updated",
    ]);
    expect(
      (w.events[1] as Extract<FeedEvent, { type: "session.updated" }>).data
        .session.unreadResult,
    ).toBe(false);
  });

  test("dropViewer 后不再算在看", () => {
    const w = world({ views: [view("a")] });
    w.feed.setViewing("c1", ["a"]);
    w.feed.setViewing("c2", ["a"]);
    w.feed.dropViewer("c1");
    expect(w.feed.watched("a")).toBe(true);
    w.feed.dropViewer("c2");
    expect(w.feed.watched("a")).toBe(false);
  });
});
