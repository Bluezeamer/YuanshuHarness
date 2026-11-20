// 工作区布局上的纯函数：会话行单击 / 双击落到对话标签，会话列表变化后收敛。
import { describe, expect, it } from "vitest";
import { type Ctx, defaultWindow, findPane, idGenFrom, panesOf } from "./l2";
import {
  chatSids,
  focusedSid,
  pinSession,
  placeSession,
  reconcileSessions,
  showSession,
  viewingSids,
} from "./layoutOps";
import { val } from "./testkit";
import type { L2Node, Pane, Tab, Window, WindowState } from "./types";

const ctx = (used: Iterable<string> = []): Ctx => ({ ids: idGenFrom(used) });
/** 要新增标签的用例：发号器避开示例里已占用的 id */
const fresh = () => ctx(["w1", "p1", "p2", "t1", "t2", "t3", "t4"]);
const CHAT = { ctab: "chat" } as const;
const chat = (id: string, sid?: string, temp = false): Tab => ({
  id,
  type: "chat",
  ctab: "chat",
  ...(sid === undefined ? {} : { sid }),
  ...(temp ? { temp: true } : {}),
});
const sub = (id: string, sid?: string): Tab => ({
  id,
  type: "sub",
  ...(sid === undefined ? {} : { sid }),
});
const term = (id: string): Tab => ({ id, type: "term", host: "server" });
const pane = (
  pid: string,
  tabs: [Tab, ...Tab[]],
  host: string | null = null,
): Pane => ({ pid, host, tabs, active: tabs[0].id });
const row = (...children: L2Node[]): L2Node => ({
  dir: "row",
  sizes: children.map(() => 1),
  children,
});
const win = (root: L2Node, focus: string): Window => ({
  id: "w1",
  root,
  focus,
});
const st = (list: Window[], active = 0): WindowState => ({ list, active });

const tabsOf = (w: Window, pid: string) => findPane(w, pid)?.tabs ?? [];
const ids = (w: Window, pid: string) => tabsOf(w, pid).map((t) => t.id);
const tab = (w: Window, pid: string, tid: string) =>
  tabsOf(w, pid).find((t) => t.id === tid);

describe("viewingSids", () => {
  it("只算当前窗口、只算每个窗格的当前标签，按窗格顺序去重", () => {
    const other = win(pane("q1", [chat("s1", "z")]), "q1");
    const p1 = pane("p1", [chat("t1", "a"), chat("t2", "b")]);
    // 两个窗格的当前标签都显示 a：只算一次；p2 里的 x 不是当前标签
    const p2 = pane("p2", [chat("t3", "a"), chat("t5", "x")]);
    const p3 = pane("p3", [chat("t4", "c")]);
    expect(viewingSids(st([other, win(row(p1, p2, p3), "p1")], 1))).toEqual([
      "a",
      "c",
    ]);
  });

  it("对话标签没有 sid、sub 与 term 的当前标签都不算", () => {
    const w = win(
      row(pane("p1", [chat("t1")]), pane("p2", [sub("t2", "s"), term("t3")])),
      "p1",
    );
    expect(viewingSids(st([w]))).toEqual([]);
    expect(viewingSids(st([]))).toEqual([]);
  });
});

describe("focusedSid", () => {
  it("聚焦窗格里当前标签是绑了会话的对话标签才有；别的窗格、别的标签、空对话标签、其它类型都是 null", () => {
    const p1 = pane("p1", [chat("t1", "a"), chat("t2", "b")]);
    const p2 = pane("p2", [chat("t3", "c")]);
    expect(focusedSid(st([win(row(p1, p2), "p2")]))).toBe("c");
    // p1 的当前标签是 t1(a)，不是 t2(b)
    expect(focusedSid(st([win(row(p1, p2), "p1")]))).toBe("a");
    expect(focusedSid(st([win(pane("p1", [chat("t1")]), "p1")]))).toBeNull();
    expect(
      focusedSid(st([win(pane("p1", [sub("t1", "a")]), "p1")])),
    ).toBeNull();
    expect(focusedSid(st([]))).toBeNull();
  });

  it("只看当前窗口", () => {
    const other = win(pane("q1", [chat("s1", "z")]), "q1");
    const cur = { ...win(pane("p1", [chat("t1", "a")]), "p1"), id: "w2" };
    expect(focusedSid(st([other, cur], 1))).toBe("a");
  });
});

describe("chatSids", () => {
  it("当前窗口里所有对话标签的会话（含不是当前标签的），按窗格顺序去重；不看 sub / 空标签 / 别的窗口", () => {
    const other = win(pane("q1", [chat("s1", "z")]), "q1");
    const p1 = pane("p1", [chat("t1", "a"), chat("t2", "b"), chat("t6")]);
    const p2 = pane("p2", [chat("t3", "a"), sub("t5", "x")]);
    expect(chatSids(st([other, win(row(p1, p2), "p1")], 1))).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("showSession", () => {
  it("已显示该会话：激活并聚焦它所在窗格，临时状态不变", () => {
    const w = win(
      row(pane("p1", [chat("t1", "a")]), pane("p2", [chat("t2", "b", true)])),
      "p1",
    );
    const next = val(showSession(w, "b", fresh()));
    expect(next.focus).toBe("p2");
    expect(findPane(next, "p2")?.active).toBe("t2");
    // 已固定的会话单击只是激活，不会变成临时
    const fixed = win(pane("p1", [chat("t1", "a")]), "p1");
    expect(val(showSession(fixed, "a", ctx()))).toBe(fixed);
    expect(tab(fixed, "p1", "t1")?.temp).toBeUndefined();
  });

  it("有临时标签：换 sid 而不是新增，保持 temp", () => {
    const w = win(pane("p1", [chat("t1", "a", true)]), "p1");
    const next = val(showSession(w, "b", fresh()));
    expect(tabsOf(next, "p1")).toHaveLength(1);
    expect(tab(next, "p1", "t1")).toMatchObject({ sid: "b", temp: true });
    expect(findPane(next, "p1")?.active).toBe("t1");
  });

  it("多个窗格各有临时标签：替换聚焦窗格里的那个", () => {
    const w = win(
      row(
        pane("p1", [chat("t1", "a", true)]),
        pane("p2", [chat("t2", "b", true)]),
      ),
      "p2",
    );
    const next = val(showSession(w, "z", fresh()));
    expect(tab(next, "p2", "t2")?.sid).toBe("z");
    expect(tab(next, "p1", "t1")?.sid).toBe("a");
    expect(next.focus).toBe("p2");
  });

  it("都没有：新增一个临时对话标签，落在聚焦窗格的对话标签旁", () => {
    const w = win(
      row(pane("p1", [chat("t1", "a")]), pane("p2", [term("t2")], "server")),
      "p1",
    );
    const next = val(showSession(w, "b", fresh()));
    const p1 = tabsOf(next, "p1");
    expect(p1).toHaveLength(2);
    expect(p1[1]).toMatchObject({ type: "chat", sid: "b", temp: true });
    expect(findPane(next, "p1")?.active).toBe(p1[1]?.id);
    expect(ids(next, "p2")).toEqual(["t2"]);
  });

  it("聚焦窗格没有对话标签：落到第一个含对话标签的窗格", () => {
    const w = win(
      row(pane("p1", [chat("t1", "a")]), pane("p2", [term("t2")], "server")),
      "p2",
    );
    const next = val(showSession(w, "b", fresh()));
    expect(tabsOf(next, "p1")).toHaveLength(2);
    expect(ids(next, "p2")).toEqual(["t2"]);
  });
});

describe("placeSession", () => {
  const two = () =>
    win(
      row(pane("p1", [chat("t1", "a")]), pane("p2", [chat("t2", "b", true)])),
      "p1",
    );

  it("拖到窗格边缘：在它旁边新开窗格，里面是该会话的固定对话标签", () => {
    const next = val(placeSession(two(), "c", "p1", "right", fresh()));
    const panes = panesOf(next);
    expect(panes).toHaveLength(3);
    const created = panes.find((p) => p.tabs.some((t) => t.sid === "c"));
    expect(created?.tabs).toHaveLength(1);
    expect(created?.tabs[0]).toMatchObject({ type: "chat", sid: "c" });
    expect(created?.tabs[0]?.temp).toBeUndefined();
    expect(next.focus).toBe(created?.pid);
    // 落在 p1 的右边
    expect(panes.map((p) => p.pid).indexOf(created?.pid as string)).toBe(1);
  });

  it("拖到窗格中部：并入目标窗格并激活", () => {
    const next = val(placeSession(two(), "c", "p1", "center", fresh()));
    expect(tabsOf(next, "p1").map((t) => t.sid)).toEqual(["a", "c"]);
    expect(findPane(next, "p1")?.active).toBe(tabsOf(next, "p1")[1]?.id);
    expect(next.focus).toBe("p1");
  });

  it("拖到标签条：插在指定标签之前", () => {
    const w = win(pane("p1", [chat("t1", "a"), chat("t2", "b")]), "p1");
    const next = val(placeSession(w, "c", "p1", "strip", fresh(), "t2"));
    expect(tabsOf(next, "p1").map((t) => t.sid)).toEqual(["a", "c", "b"]);
  });

  it("窗口里已经显示它：移动那个标签而不是再开一个，并去掉临时标记", () => {
    const next = val(placeSession(two(), "b", "p1", "center", fresh()));
    // p2 只有这一个标签：移走后窗格消失
    expect(panesOf(next)).toHaveLength(1);
    const moved = tabsOf(next, "p1").find((t) => t.sid === "b");
    expect(moved?.id).toBe("t2");
    expect(moved?.temp).toBeUndefined();
    expect(tabsOf(next, "p1").filter((t) => t.sid === "b")).toHaveLength(1);
  });

  it("已经显示它、拖到自己所在窗格的中部：同窗格内不动位置，也不重复", () => {
    const w = win(pane("p1", [chat("t1", "a"), chat("t2", "b", true)]), "p1");
    const next = val(placeSession(w, "b", "p1", "center", fresh()));
    expect(tabsOf(next, "p1")).toHaveLength(2);
    expect(tab(next, "p1", "t2")?.temp).toBeUndefined();
  });

  it("目标窗格不存在 → not-found；窗格数到上限 → limit", () => {
    expect(placeSession(two(), "c", "nope", "center", fresh()).ok).toBe(false);
    const full = win(
      row(
        pane("p1", [chat("t1", "a")]),
        pane("p2", [chat("t2", "b")]),
        pane("p3", [chat("t3", "c")]),
        pane("p4", [chat("t4", "d")]),
        pane("p5", [chat("t5", "e")]),
        pane("p6", [chat("t6", "f")]),
      ),
      "p1",
    );
    const r = placeSession(
      full,
      "z",
      "p1",
      "right",
      ctx([
        "w1",
        "p1",
        "p2",
        "p3",
        "p4",
        "p5",
        "p6",
        "t1",
        "t2",
        "t3",
        "t4",
        "t5",
        "t6",
      ]),
    );
    expect(r.ok).toBe(false);
  });
});

describe("pinSession", () => {
  it("已显示：去掉临时标记并激活聚焦", () => {
    const w = win(
      row(pane("p1", [chat("t1", "a")]), pane("p2", [chat("t2", "b", true)])),
      "p1",
    );
    const next = val(pinSession(w, "b", fresh()));
    expect(next.focus).toBe("p2");
    expect(findPane(next, "p2")?.active).toBe("t2");
    expect(tab(next, "p2", "t2")).toEqual({
      id: "t2",
      type: "chat",
      ...CHAT,
      sid: "b",
    });
    // 已经固定的会话再双击是空操作
    expect(val(pinSession(next, "b", ctx()))).toBe(next);
  });

  it("先单击再双击 = 固定同一批标签", () => {
    const w = win(pane("p1", [chat("t1", "a")]), "p1");
    const shown = val(showSession(w, "b", fresh()));
    expect(tabsOf(shown, "p1")).toHaveLength(2);
    const pinned = val(pinSession(shown, "b", fresh()));
    expect(tabsOf(pinned, "p1")).toHaveLength(2);
    expect(tabsOf(pinned, "p1").some((t) => t.temp === true)).toBe(false);
  });

  it("有别的会话的临时标签：换成 sid 并固定", () => {
    const w = win(pane("p1", [chat("t1", "a", true)]), "p1");
    const next = val(pinSession(w, "b", fresh()));
    expect(tabsOf(next, "p1")).toHaveLength(1);
    expect(tab(next, "p1", "t1")).toEqual({
      id: "t1",
      type: "chat",
      ...CHAT,
      sid: "b",
    });
  });

  it("都没有：新增一个固定对话标签", () => {
    const w = win(pane("p1", [chat("t1", "a")]), "p1");
    const next = val(pinSession(w, "b", fresh()));
    const tabs = tabsOf(next, "p1");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ type: "chat", sid: "b" });
    expect(tabs[1]?.temp).toBeUndefined();
    expect(findPane(next, "p1")?.active).toBe(tabs[1]?.id);
  });
});

describe("reconcileSessions", () => {
  const known = new Set(["a"]);

  it("已删会话的 chat / sub 标签被关，窗格空了就摘掉", () => {
    const w = win(
      row(
        pane("p1", [chat("t1", "gone"), chat("t2", "a")]),
        pane("p2", [sub("t3", "gone")], "server"),
      ),
      "p1",
    );
    const next = reconcileSessions(st([w]), known, null, ctx(), false);
    const only = next.list[0] as Window;
    expect(panesOf(only)).toHaveLength(1);
    expect(ids(only, "p1")).toEqual(["t2"]);
  });

  it("会话已删：它的轮末 diff 预览标签也被关；没有会话的预览标签不动", () => {
    const diff = (id: string, sid?: string): Tab => ({
      id,
      type: "preview",
      host: "server",
      path: "/a",
      diff: { turn: 1, path: "/a" },
      ...(sid === undefined ? {} : { sid }),
    });
    const plain: Tab = {
      id: "t9",
      type: "preview",
      host: "server",
      path: "/b",
    };
    const w = win(
      row(
        pane("p1", [chat("t1", "a")]),
        pane("p2", [diff("t2", "gone"), diff("t3"), plain], "server"),
      ),
      "p1",
    );
    const next = reconcileSessions(st([w]), known, null, ctx(), false);
    expect(ids(next.list[0] as Window, "p2")).toEqual(["t3", "t9"]);
  });

  it("窗口里最后一个窗格的标签全失效：改放一个空对话标签", () => {
    const w = win(pane("p1", [chat("t1", "gone")]), "p1");
    const next = reconcileSessions(st([w]), known, null, ctx(), false);
    const [p] = panesOf(next.list[0] as Window);
    expect(p?.tabs).toHaveLength(1);
    expect(p?.tabs[0]).toMatchObject({ type: "chat", ...CHAT });
    expect(p?.tabs[0]?.sid).toBeUndefined();
  });

  it("fill：窗口里没有存活会话的对话标签时，空对话标签被绑成 latest 并标临时", () => {
    const w = win(pane("p1", [chat("t1")]), "p1");
    const next = reconcileSessions(st([w]), known, "a", ctx(), true);
    expect(tab(next.list[0] as Window, "p1", "t1")).toMatchObject({
      sid: "a",
      temp: true,
    });
  });

  it("没有 fill、也没关过失效标签：用户新开的空对话标签不会被顶掉", () => {
    const w = win(pane("p1", [chat("t1")]), "p1");
    const state = st([w]);
    expect(reconcileSessions(state, known, "a", ctx(), false)).toBe(state);
  });

  it("没有 fill，但这个窗口刚关掉了失效标签：剩下的空对话标签绑成 latest", () => {
    const w = win(pane("p1", [chat("t1", "gone"), chat("t2")]), "p1");
    const next = reconcileSessions(st([w]), new Set(["b"]), "b", ctx(), false);
    const only = next.list[0] as Window;
    expect(ids(only, "p1")).toEqual(["t2"]);
    expect(tab(only, "p1", "t2")).toMatchObject({ sid: "b", temp: true });
  });

  it("窗口里已有存活会话的对话标签：不绑，哪怕它显示的不是 latest", () => {
    const w = win(pane("p1", [chat("t1", "a"), chat("t2")]), "p1");
    const state = st([w]);
    expect(
      reconcileSessions(state, new Set(["a", "b"]), "b", ctx(), true),
    ).toBe(state);
    expect(tab(w, "p1", "t2")?.sid).toBeUndefined();
  });

  it("latest 为 null：只关失效标签", () => {
    const w = win(pane("p1", [chat("t1")]), "p1");
    const state = st([w]);
    expect(reconcileSessions(state, known, null, ctx(), true)).toBe(state);
  });

  it("多个窗口里都已有存活会话的对话标签时不改动", () => {
    const a = win(pane("p1", [chat("t1", "a")]), "p1");
    const b = { ...win(pane("p2", [chat("t2", "a")]), "p2"), id: "w2" };
    const state = st([a, b]);
    expect(reconcileSessions(state, known, "a", ctx(), true)).toBe(state);
  });
});

describe("默认窗口（空对话标签）", () => {
  it("空对话标签的默认窗口在 latest 到来后绑上会话", () => {
    const w = defaultWindow(ctx(), []);
    const [p] = panesOf(w) as [Pane];
    expect(p.tabs[0]?.sid).toBeUndefined();
    const next = reconcileSessions(st([w]), new Set(["a"]), "a", ctx(), true);
    expect(panesOf(next.list[0] as Window)[0]?.tabs[0]).toMatchObject({
      sid: "a",
      temp: true,
    });
  });
});
