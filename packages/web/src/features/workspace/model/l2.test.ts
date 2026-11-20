// 迁移自 mock 的 l1.smoke.cjs 里 L2 部分：默认窗格、主机隔离、加标签路由、窗口条。
import { describe, expect, it } from "vitest";
import { isBranch } from "../../../ui/tiling/tree";
import {
  activateTab,
  addTab,
  addTabToPane,
  addWindow,
  afxOf,
  closePane,
  closeTab,
  closeWindow,
  defaultWindow,
  dropPane,
  findPane,
  findTab,
  hostConflict,
  hostConflictError,
  hostToneOf,
  hostTones,
  idGenFrom,
  initialWindows,
  isHostTab,
  locatePane,
  MAX_PANES,
  mapPane,
  newPane,
  newTab,
  openDiff,
  openFilePreview,
  openInBrowser,
  openPreview,
  openTeamDiff,
  orderHostChoices,
  paneCount,
  panesOf,
  patchAfx,
  patchTab,
  revealBrowser,
  setFocus,
  setPaneSizes,
  splitPane,
  switchWindow,
  updateWindow,
  usedIds,
} from "./l2";
import { bad, mkCtx, val } from "./testkit";
import type { L2Node, Pane, Window, WinMap } from "./types";
import { fail, ok } from "./types";

const BUILD = "build-node-03";
const GPU = "gpu-04";
const WS = [
  { host: BUILD, path: "/w/a" },
  { host: GPU, path: "/w/b" },
];

/** auth 式默认窗口：对话 + build + gpu 三个窗格 */
function three() {
  const ctx = mkCtx("auth");
  const w = defaultWindow(ctx, WS);
  const [chat, build, gpu] = panesOf(w) as [Pane, Pane, Pane];
  return { ctx, w, chat, build, gpu };
}
const hostsOf = (w: Window) => panesOf(w).map((p) => p.host);
const typesOf = (p: Pane) => p.tabs.map((t) => t.type);

describe("发号", () => {
  it("顺序发号，避开已占用的 id", () => {
    const ids = idGenFrom(["t1", "p2", "w3"]);
    const got = [ids("t"), ids("p"), ids("w"), ids("t")];
    expect(new Set(got).size).toBe(4);
    for (const used of ["t1", "p2", "w3"]) expect(got).not.toContain(used);
  });

  it("usedIds 收齐窗口、窗格、标签 id", () => {
    const { w } = three();
    const wins: WinMap = { auth: { list: [w], active: 0 } };
    const used = usedIds(wins);
    expect(used).toContain(w.id);
    for (const p of panesOf(w)) {
      expect(used).toContain(p.pid);
      for (const t of p.tabs) expect(used).toContain(t.id);
    }
    expect(new Set(used).size).toBe(used.length);
  });
});

describe("默认窗口", () => {
  it("没有目录：只含一个对话窗格，未绑主机", () => {
    const ctx = mkCtx("retry");
    const w = defaultWindow(ctx, []);
    expect(isBranch(w.root)).toBe(false);
    const [p] = panesOf(w);
    expect(p?.host).toBeNull();
    expect(p?.tabs).toHaveLength(1);
    expect(p?.tabs[0]).toMatchObject({
      type: "chat",
      ctab: "chat",
      sid: "retry",
    });
    expect(w.focus).toBe(p?.pid);
  });

  it("两台目录主机各占一个窗格，窗格不混主机", () => {
    const { w, chat, build, gpu } = three();
    expect(hostsOf(w)).toEqual([null, BUILD, GPU]);
    expect(typesOf(chat)).toEqual(["chat"]);
    expect(typesOf(build)).toEqual(["files", "term"]);
    expect(typesOf(gpu)).toEqual(["term", "files"]);
    for (const p of [build, gpu])
      expect(p.tabs.every((t) => t.host === p.host)).toBe(true);
    expect(w.focus).toBe(chat.pid);
    expect(build.tabs[0]?.cwd).toBe("/w/a");
  });

  it("只有一台目录主机 → 两个窗格", () => {
    const w = defaultWindow(mkCtx(), [{ host: BUILD, path: "/w" }]);
    expect(hostsOf(w)).toEqual([null, BUILD]);
  });

  it("同一台主机的多个目录只占一个窗格", () => {
    const same = defaultWindow(mkCtx(), [
      { host: BUILD, path: "/a" },
      { host: BUILD, path: "/b" },
    ]);
    expect(hostsOf(same)).toEqual([null, BUILD]);
    const extraTwice = defaultWindow(mkCtx(), [
      { host: BUILD, path: "/a" },
      { host: GPU, path: "/g1" },
      { host: GPU, path: "/g2" },
    ]);
    expect(hostsOf(extraTwice)).toEqual([null, BUILD, GPU]);
  });

  it("每台不同的主机各一个窗格，按目录清单的出现顺序；窗格总数不超过 6", () => {
    const three = defaultWindow(mkCtx(), [
      ...WS,
      { host: "third", path: "/c" },
    ]);
    expect(hostsOf(three)).toEqual([null, BUILD, GPU, "third"]);
    const hosts = Array.from({ length: 9 }, (_, i) => ({
      host: `h${i}`,
      path: "/w",
    }));
    const capped = defaultWindow(mkCtx(), hosts);
    expect(paneCount(capped)).toBe(MAX_PANES);
    expect(hostsOf(capped)).toEqual([null, "h0", "h1", "h2", "h3", "h4"]);
  });

  it("initialWindows：一个窗口，active=0", () => {
    const st = initialWindows(mkCtx(), WS);
    expect(st.list).toHaveLength(1);
    expect(st.active).toBe(0);
  });
});

describe("标签与窗格构造", () => {
  it("newTab 只写有值的字段，主机级标签缺省 server", () => {
    const ctx = mkCtx("s9");
    expect(newTab(ctx, "chat")).toMatchObject({
      type: "chat",
      ctab: "chat",
      sid: "s9",
    });
    expect(newTab(ctx, "sub", { sub: "x1" })).toMatchObject({
      type: "sub",
      sid: "s9",
      sub: "x1",
    });
    // 任务标签属于派发它的会话，带任务 id；不会混进 sub 的字段
    const job = newTab(ctx, "job", { job: "j1" });
    expect(job).toMatchObject({ type: "job", sid: "s9", job: "j1" });
    expect("sub" in job).toBe(false);
    expect("job" in newTab(ctx, "sub", { sub: "x1", job: "j1" })).toBe(false);
    const term = newTab(ctx, "term");
    expect(term.host).toBe("server");
    expect(Object.keys(term).sort()).toEqual(["host", "id", "type"]);
    expect(newTab(ctx, "files", { host: BUILD, cwd: "/w" })).toMatchObject({
      host: BUILD,
      cwd: "/w",
      path: "",
    });
    expect(newTab(ctx, "preview", { path: "/a.md" }).path).toBe("/a.md");
    expect(newTab(ctx, "web", { page: "p1" }).page).toBe("p1");
    expect(newTab(ctx, "web").page).toBeUndefined();
  });

  it("term 标签携带服务端终端 id（刷新后接回同一终端）", () => {
    const t = newTab(mkCtx(), "term", { termId: "term-42" });
    expect(t.termId).toBe("term-42");
    expect(newTab(mkCtx(), "term").termId).toBeUndefined();
    expect(
      newTab(mkCtx(), "files", { termId: "ignored" }).termId,
    ).toBeUndefined();
  });

  it("newPane：active 为第一个标签", () => {
    const ctx = mkCtx();
    const a = newTab(ctx, "chat");
    const p = newPane(ctx, [a, newTab(ctx, "chat")]);
    expect(p.active).toBe(a.id);
    expect(p.host).toBeNull();
  });
});

describe("主机规则", () => {
  it("isHostTab：只有 term/files/preview 按主机隔离窗格", () => {
    const ctx = mkCtx();
    for (const ty of ["term", "files", "preview"] as const)
      expect(isHostTab(newTab(ctx, ty))).toBe(true);
    for (const ty of ["chat", "sub", "web", "canvas"] as const)
      expect(isHostTab(newTab(ctx, ty))).toBe(false);
  });

  it("newTab：画布带主机（数据地址），对话、执行体、浏览器没有 host 字段", () => {
    const ctx = mkCtx();
    expect(newTab(ctx, "canvas", { host: GPU, path: "/w/b" }).host).toBe(GPU);
    expect(newTab(ctx, "canvas").host).toBe("server");
    for (const ty of ["chat", "sub", "web"] as const)
      expect("host" in newTab(ctx, ty, { host: GPU })).toBe(false);
  });

  it("hostConflict：浏览器与画布不冲突，放进任何窗格都不改窗格的主机", () => {
    const { ctx, w, build } = three();
    for (const ty of ["web", "canvas"] as const) {
      const t = newTab(ctx, ty, { host: GPU });
      expect(hostConflict(build, t)).toBe(false);
      const r = val(addTab(w, build.pid, t, ctx));
      expect(paneCount(r)).toBe(3); // 没有拆出新窗格
      expect(findPane(r, build.pid)?.host).toBe(BUILD);
      expect(findPane(r, build.pid)?.tabs.at(-1)?.type).toBe(ty);
    }
  });

  it("只装浏览器 / 画布的窗格不绑主机，之后任何主机的标签都能并进来", () => {
    const { ctx, w, chat } = three();
    let r = val(addTabToPane(w, chat.pid, newTab(ctx, "web")));
    r = val(addTabToPane(r, chat.pid, newTab(ctx, "canvas", { host: BUILD })));
    expect(findPane(r, chat.pid)?.host).toBeNull();
    r = val(addTabToPane(r, chat.pid, newTab(ctx, "term", { host: GPU })));
    expect(findPane(r, chat.pid)?.host).toBe(GPU);
  });

  it("hostConflict：窗格绑了别的主机才冲突；对话标签与未绑窗格都不冲突", () => {
    const { ctx, chat, build } = three();
    const onGpu = newTab(ctx, "term", { host: GPU });
    expect(hostConflict(build, onGpu)).toBe(true);
    expect(hostConflict(build, newTab(ctx, "term", { host: BUILD }))).toBe(
      false,
    );
    expect(hostConflict(build, newTab(ctx, "chat"))).toBe(false);
    expect(hostConflict(chat, onGpu)).toBe(false);
  });

  it("hostConflictError：点名两台主机并指路", () => {
    const e = bad(hostConflictError(BUILD, GPU), "host-conflict");
    expect(e.hosts).toEqual([BUILD, GPU]);
    expect(e.error).toContain(BUILD);
    expect(e.error).toContain(GPU);
    expect(e.error).toContain("贴靠拆分");
  });

  it("orderHostChoices：本窗格主机在前，其余保持原序并去重", () => {
    expect(orderHostChoices(GPU, ["a", GPU, "b", "a"])).toEqual([
      GPU,
      "a",
      "b",
    ]);
    expect(orderHostChoices(null, ["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("hostTones：按窗格出现顺序分配 1..6 且各不相同，用尽后循环", () => {
    const { w } = three();
    expect(hostTones(w)).toEqual({ [BUILD]: 1, [GPU]: 2 });
    const ctx = mkCtx();
    const panes = Array.from({ length: 7 }, (_, i) =>
      newPane(ctx, [newTab(ctx, "term", { host: `h${i}` })], `h${i}`),
    );
    const root: L2Node = {
      dir: "row",
      sizes: panes.map(() => 1),
      children: panes,
    };
    const tones = hostTones({ id: "w", root, focus: "" });
    expect(tones.h0).toBe(1);
    expect(tones.h5).toBe(6);
    expect(tones.h6).toBe(1);
  });

  it("hostToneOf：窗格里已有的主机沿用它的颜色，还没有窗格的取下一个将分到的颜色", () => {
    const { w } = three();
    expect(hostToneOf(w, BUILD)).toBe(1);
    expect(hostToneOf(w, GPU)).toBe(2);
    expect(hostToneOf(w, "elsewhere")).toBe(3);
  });
});

describe("查询", () => {
  it("panesOf / paneCount / findPane / findTab", () => {
    const { w, build } = three();
    expect(paneCount(w)).toBe(3);
    expect(findPane(w, build.pid)).toBe(build);
    expect(findPane(w, "nope")).toBeUndefined();
    const tid = build.tabs[1]?.id ?? "";
    expect(findTab(w, tid)?.pane.pid).toBe(build.pid);
    expect(findTab(w, "nope")).toBeUndefined();
  });

  it("locatePane：跨会话与窗口定位", () => {
    const a = three();
    const b = defaultWindow(
      mkCtx("other", usedIds({ auth: { list: [a.w], active: 0 } })),
      [],
    );
    const wins: WinMap = {
      auth: { list: [a.w], active: 0 },
      other: { list: [b], active: 0 },
    };
    expect(locatePane(wins, a.gpu.pid)).toMatchObject({
      sid: "auth",
      index: 0,
    });
    expect(locatePane(wins, panesOf(b)[0]?.pid ?? "")).toMatchObject({
      sid: "other",
    });
    expect(locatePane(wins, "nope")).toBeUndefined();
  });
});

describe("窗口列表", () => {
  const st3 = (active: number) => {
    const ctx = mkCtx();
    return {
      list: [
        defaultWindow(ctx, []),
        defaultWindow(ctx, []),
        defaultWindow(ctx, []),
      ],
      active,
    };
  };

  it("addWindow：追加并切过去，其他窗口原样（窗口条按会话独立）", () => {
    const st = initialWindows(mkCtx(), WS);
    const r = addWindow(st, mkCtx("auth", usedIds({ auth: st })), WS);
    expect(r.list).toHaveLength(2);
    expect(r.active).toBe(1);
    expect(r.list[0]).toBe(st.list[0]);
    expect(st.list).toHaveLength(1);
  });

  it("switchWindow：切换、同窗口返回原引用、越界 / 非整数 not-found", () => {
    const st = st3(0);
    expect(val(switchWindow(st, 2)).active).toBe(2);
    expect(val(switchWindow(st, 0))).toBe(st);
    bad(switchWindow(st, 3), "not-found");
    bad(switchWindow(st, -1), "not-found");
    bad(switchWindow(st, 1.5), "not-found");
    bad(switchWindow(st, Number.NaN), "not-found");
  });

  it("closeWindow：active 随删除位置修正", () => {
    expect(val(closeWindow(st3(2), 2)).active).toBe(1);
    expect(val(closeWindow(st3(2), 0)).active).toBe(1);
    expect(val(closeWindow(st3(0), 1)).active).toBe(0);
    expect(val(closeWindow(st3(0), 0)).active).toBe(0);
    expect(val(closeWindow(st3(1), 1)).list).toHaveLength(2);
  });

  it("closeWindow：最后一个窗口不能关，越界 not-found", () => {
    const one = initialWindows(mkCtx(), []);
    bad(closeWindow(one, 0), "last");
    bad(closeWindow(st3(0), 7), "not-found");
  });

  it("updateWindow：缺省作用于当前窗口，其他窗口与会话不变；无变化返回原引用", () => {
    const ctx = mkCtx();
    const w0 = defaultWindow(ctx, []);
    const w1 = defaultWindow(ctx, []);
    const wins: WinMap = {
      a: { list: [w0, w1], active: 1 },
      b: { list: [w0], active: 0 },
    };
    const pid = panesOf(w1)[0]?.pid ?? "";
    const r = val(updateWindow(wins, "a", (w) => setFocus(w, pid)));
    expect(r).toBe(wins);
    const r2 = val(updateWindow(wins, "a", (w) => ok({ ...w, id: "X" }), 0));
    expect(r2.a?.list[0]?.id).toBe("X");
    expect(r2.a?.list[1]).toBe(w1);
    expect(r2.b).toBe(wins.b);
    bad(
      updateWindow(wins, "zzz", (w) => ok(w)),
      "not-found",
    );
    bad(
      updateWindow(wins, "a", (w) => ok(w), 9),
      "not-found",
    );
    bad(
      updateWindow(wins, "a", () => fail("invalid", "x")),
      "invalid",
    );
  });
});

describe("标签：激活 / 关闭 / 加入", () => {
  it("activateTab：激活并聚焦窗格；已是当前返回原引用；不存在 not-found", () => {
    const { ctx, w: w0, build } = three();
    const extra = newTab(ctx, "preview", { host: BUILD, path: "/x" });
    const w = val(addTabToPane(w0, build.pid, extra));
    const tid = build.tabs[0]?.id ?? "";
    const r = val(activateTab(w, build.pid, tid));
    expect(findPane(r, build.pid)?.active).toBe(tid);
    expect(r.focus).toBe(build.pid);
    expect(val(activateTab(r, build.pid, tid))).toBe(r);
    bad(activateTab(w, build.pid, "nope"), "not-found");
    bad(activateTab(w, "nope", tid), "not-found");
  });

  it("closeTab：关掉当前标签落到前一个，关非当前不动 active", () => {
    const { ctx, w, build } = three();
    const [files, term] = build.tabs as [Pane["tabs"][0], Pane["tabs"][0]];
    // 再放一个预览标签，凑够「关非当前标签不动 active」要的第三个
    const extra = newTab(ctx, "preview", { host: BUILD, path: "/x" });
    const w3 = val(addTabToPane(w, build.pid, extra));
    const a1 = val(activateTab(w3, build.pid, term.id));
    expect(
      findPane(val(closeTab(a1, build.pid, term.id, ctx)), build.pid)?.active,
    ).toBe(files.id);
    expect(
      findPane(val(closeTab(a1, build.pid, extra.id, ctx)), build.pid)?.active,
    ).toBe(term.id);
    expect(
      findPane(val(closeTab(w3, build.pid, files.id, ctx)), build.pid)?.active,
    ).toBe(extra.id);
  });

  it("closeTab：窗格空了 → 关窗格，焦点移到第一个窗格", () => {
    const { ctx, w, chat, gpu } = three();
    let cur = val(setFocus(w, gpu.pid));
    for (const t of gpu.tabs) cur = val(closeTab(cur, gpu.pid, t.id, ctx));
    expect(paneCount(cur)).toBe(2);
    expect(findPane(cur, gpu.pid)).toBeUndefined();
    expect(cur.focus).toBe(chat.pid);
  });

  it("closeTab：窗口里最后一个窗格的最后一个标签 → 换一个新对话标签并解绑主机", () => {
    const ctx = mkCtx("s1");
    const w = defaultWindow(ctx, []);
    const p = panesOf(w)[0] as Pane;
    const r = val(closeTab(w, p.pid, p.tabs[0]?.id ?? "", ctx));
    const q = panesOf(r)[0] as Pane;
    expect(q.tabs).toHaveLength(1);
    expect(q.tabs[0]).toMatchObject({ type: "chat", sid: "s1" });
    expect(q.tabs[0]?.id).not.toBe(p.tabs[0]?.id);
    expect(q.host).toBeNull();
    expect(q.active).toBe(q.tabs[0]?.id);
  });

  it("closeTab：关掉最后一个主机级标签 → 窗格解绑主机", () => {
    const { ctx, w, chat } = three();
    const term = newTab(ctx, "term", { host: BUILD });
    const bound = val(addTabToPane(w, chat.pid, term));
    expect(findPane(bound, chat.pid)?.host).toBe(BUILD);
    const r = val(closeTab(bound, chat.pid, term.id, ctx));
    expect(findPane(r, chat.pid)?.host).toBeNull();
  });

  it("closeTab：标签 / 窗格不存在 → not-found", () => {
    const { ctx, w, build } = three();
    bad(closeTab(w, build.pid, "nope", ctx), "not-found");
    bad(closeTab(w, "nope", "x", ctx), "not-found");
  });

  it("addTabToPane：同主机留在本窗格并激活、聚焦", () => {
    const { ctx, w, build } = three();
    const t = newTab(ctx, "term", { host: BUILD });
    const r = val(addTabToPane(w, build.pid, t));
    const p = findPane(r, build.pid);
    expect(p?.tabs).toHaveLength(build.tabs.length + 1);
    expect(p?.active).toBe(t.id);
    expect(r.focus).toBe(build.pid);
  });

  it("addTabToPane：异主机被拒绝，点名两台主机；对话标签任意窗格都可加", () => {
    const { ctx, w, build } = three();
    const e = bad(
      addTabToPane(w, build.pid, newTab(ctx, "term", { host: GPU })),
      "host-conflict",
    );
    expect(e.hosts).toEqual([BUILD, GPU]);
    expect(e.error).toContain(BUILD);
    expect(e.error).toContain(GPU);
    val(addTabToPane(w, build.pid, newTab(ctx, "chat")));
  });

  it("addTabToPane：未绑主机的窗格装入主机级标签后绑定该主机", () => {
    const { ctx, w, chat } = three();
    const r = val(
      addTabToPane(w, chat.pid, newTab(ctx, "files", { host: GPU })),
    );
    expect(findPane(r, chat.pid)?.host).toBe(GPU);
  });

  it("addTabToPane：标签 id 重复 / 窗格不存在", () => {
    const { w, build, gpu } = three();
    bad(
      addTabToPane(w, gpu.pid, { ...(build.tabs[0] as Pane["tabs"][0]) }),
      "invalid",
    );
    bad(addTabToPane(w, "nope", build.tabs[0] as Pane["tabs"][0]), "not-found");
  });

  it("addTab：同主机留在本窗格；异主机 → 右侧新建该主机的窗格并聚焦", () => {
    const { ctx, w, build } = three();
    const same = val(
      addTab(w, build.pid, newTab(ctx, "term", { host: BUILD }), ctx),
    );
    expect(paneCount(same)).toBe(3);
    const t = newTab(ctx, "term", { host: "h3" });
    const r = val(addTab(w, build.pid, t, ctx));
    expect(paneCount(r)).toBe(4);
    const panes = panesOf(r);
    const at = panes.findIndex((p) => p.pid === build.pid);
    expect(panes[at + 1]?.host).toBe("h3");
    expect(panes[at + 1]?.tabs).toEqual([t]);
    expect(r.focus).toBe(panes[at + 1]?.pid);
    expect(findPane(r, build.pid)?.host).toBe(BUILD);
  });

  it("addTab：窗格数已达上限时异主机被拒，同主机仍可", () => {
    const { ctx, w, build } = three();
    let cur = w;
    while (paneCount(cur) < MAX_PANES)
      cur = val(splitPane(cur, build.pid, "bottom", newTab(ctx, "chat"), ctx));
    bad(
      addTab(cur, build.pid, newTab(ctx, "term", { host: GPU }), ctx),
      "limit",
    );
    val(addTab(cur, build.pid, newTab(ctx, "term", { host: BUILD }), ctx));
  });
});

describe("窗格：分割 / 关闭 / 焦点 / 比例", () => {
  it("splitPane：四向拆分，新窗格属 tab 的主机并取得焦点", () => {
    const { ctx, w, chat } = three();
    const t = newTab(ctx, "files", { host: "h9" });
    const r = val(splitPane(w, chat.pid, "bottom", t, ctx));
    expect(paneCount(r)).toBe(4);
    const fresh = findTab(r, t.id)?.pane;
    expect(fresh?.host).toBe("h9");
    expect(r.focus).toBe(fresh?.pid);
    // 向下拆：chat 所在位置变成 col 分支，chat 在上
    const first = isBranch(r.root) ? r.root.children[0] : null;
    expect(first && isBranch(first) && first.dir).toBe("col");
    const chatTab = newTab(ctx, "chat");
    expect(
      findTab(val(splitPane(w, chat.pid, "left", chatTab, ctx)), chatTab.id)
        ?.pane.host,
    ).toBeNull();
  });

  it("splitPane：窗格数上限 6、目标不存在、标签 id 重复都被拒绝", () => {
    const { ctx, w, chat, build } = three();
    let cur = w;
    while (paneCount(cur) < MAX_PANES)
      cur = val(splitPane(cur, chat.pid, "right", newTab(ctx, "chat"), ctx));
    bad(splitPane(cur, chat.pid, "right", newTab(ctx, "chat"), ctx), "limit");
    bad(splitPane(w, "nope", "right", newTab(ctx, "chat"), ctx), "not-found");
    bad(
      splitPane(w, chat.pid, "right", build.tabs[0] as Pane["tabs"][0], ctx),
      "invalid",
    );
  });

  it("closePane：关闭焦点窗格 → 焦点移到第一个；关非焦点窗格焦点不变", () => {
    const { w, chat, build, gpu } = three();
    const onGpu = val(setFocus(w, gpu.pid));
    const r = val(closePane(onGpu, gpu.pid));
    expect(paneCount(r)).toBe(2);
    expect(r.focus).toBe(chat.pid);
    expect(val(closePane(w, build.pid)).focus).toBe(chat.pid);
    expect(val(closePane(onGpu, build.pid)).focus).toBe(gpu.pid);
  });

  it("closePane：折叠分支后树里没有只剩一个孩子的分支", () => {
    const { w, build, gpu } = three();
    const r = val(closePane(val(closePane(w, build.pid)), gpu.pid));
    expect(isBranch(r.root)).toBe(false);
  });

  it("closePane：最后一个窗格不能关，不存在 not-found", () => {
    const w = defaultWindow(mkCtx(), []);
    bad(closePane(w, panesOf(w)[0]?.pid ?? ""), "last");
    bad(closePane(three().w, "nope"), "not-found");
  });

  it("setFocus：同窗格返回原引用，不存在 not-found", () => {
    const { w, chat, build } = three();
    expect(val(setFocus(w, chat.pid))).toBe(w);
    expect(val(setFocus(w, build.pid)).focus).toBe(build.pid);
    bad(setFocus(w, "nope"), "not-found");
  });

  it("setPaneSizes：写入比例；路径 / 个数 / 非正数无效", () => {
    const { w } = three();
    const r = val(setPaneSizes(w, [], [2, 3, 1]));
    expect(isBranch(r.root) && r.root.sizes).toEqual([2, 3, 1]);
    bad(setPaneSizes(w, [], [1, 1]), "invalid");
    bad(setPaneSizes(w, [], [1, 0, 1]), "invalid");
    bad(setPaneSizes(w, [9], [1, 1]), "invalid");
  });

  it("dropPane / mapPane 不改动输入", () => {
    const { w, build } = three();
    const snap = JSON.stringify(w);
    mapPane(w, build.pid, (p) => ({ ...p, active: "x" }));
    dropPane(w, build.pid);
    expect(JSON.stringify(w)).toBe(snap);
    expect(
      dropPane(
        defaultWindow(mkCtx(), []),
        panesOf(defaultWindow(mkCtx(), []))[0]?.pid ?? "",
      ),
    ).toBeNull();
  });
});

describe("标签字段：patchTab / afx / 终端接回", () => {
  it("patchTab：改字段，undefined 删除字段，不存在 not-found", () => {
    const { w, build } = three();
    const tid = build.tabs[0]?.id ?? "";
    const r = val(patchTab(w, tid, { cwd: "/x", path: "/x/a" }));
    expect(findTab(r, tid)?.tab).toMatchObject({ cwd: "/x", path: "/x/a" });
    const r2 = val(patchTab(r, tid, { cwd: undefined }));
    expect(
      findTab(r2, tid)?.tab && "cwd" in (findTab(r2, tid)?.tab ?? {}),
    ).toBe(false);
    bad(patchTab(w, "nope", { cwd: "/" }), "not-found");
  });

  it("term 标签：写入 termId、标记已结束（旧 id 404），重新打开时清掉", () => {
    const { w, build } = three();
    const tid = build.tabs[1]?.id ?? "";
    const attached = val(patchTab(w, tid, { termId: "term-7" }));
    expect(findTab(attached, tid)?.tab.termId).toBe("term-7");
    const ended = val(patchTab(attached, tid, { termEnded: true }));
    expect(findTab(ended, tid)?.tab).toMatchObject({
      termId: "term-7",
      termEnded: true,
    });
    const reopened = val(
      patchTab(ended, tid, { termId: "term-8", termEnded: undefined }),
    );
    const tab = findTab(reopened, tid)?.tab;
    expect(tab?.termId).toBe("term-8");
    expect(tab && "termEnded" in tab).toBe(false);
  });

  it("afx：按标签存取，浅合并；设为 undefined 删键；清空后整个字段消失", () => {
    const { w, build } = three();
    const [a, b] = build.tabs as [Pane["tabs"][0], Pane["tabs"][0]];
    expect(afxOf(w, a.id)).toEqual({});
    const r = val(patchAfx(w, a.id, { w: 240, subAll: true }));
    expect(afxOf(r, a.id)).toEqual({ w: 240, subAll: true });
    expect(afxOf(r, b.id)).toEqual({});
    const r2 = val(patchAfx(r, a.id, { subAll: undefined }));
    expect(afxOf(r2, a.id)).toEqual({ w: 240 });
    const r3 = val(patchAfx(r2, a.id, { w: undefined }));
    expect(
      findTab(r3, a.id)?.tab && "afx" in (findTab(r3, a.id)?.tab ?? {}),
    ).toBe(false);
    bad(patchAfx(w, "nope", { w: 1 }), "not-found");
  });
});

describe("openPreview", () => {
  /** P1(host=BUILD, files) | P2(host=BUILD, preview /a.md) | P3(host=GPU, files) */
  function setup() {
    const ctx = mkCtx();
    const files = newTab(ctx, "files", { host: BUILD });
    const prev = newTab(ctx, "preview", { host: BUILD, path: "/a.md" });
    const gfiles = newTab(ctx, "files", { host: GPU });
    const p1 = newPane(ctx, [files], BUILD);
    const p2 = newPane(ctx, [prev], BUILD);
    const p3 = newPane(ctx, [gfiles], GPU);
    const win: Window = {
      id: "w1",
      root: { dir: "row", sizes: [1, 1, 1], children: [p1, p2, p3] },
      focus: p1.pid,
    };
    return { ctx, win, p1, p2, p3, files, prev, gfiles };
  }

  it("同主机同路径已开 → 只聚焦，不新增标签", () => {
    const { ctx, win, p1, p2, files, prev } = setup();
    const r = val(openPreview(win, p1.pid, files.id, "/a.md", ctx, false));
    expect(r.focus).toBe(p2.pid);
    expect(findPane(r, p2.pid)?.tabs).toHaveLength(1);
    expect(findPane(r, p2.pid)?.active).toBe(prev.id);
  });

  it("同主机已有预览窗格 → 新路径开在那里", () => {
    const { ctx, win, p1, p2, files } = setup();
    const r = val(openPreview(win, p1.pid, files.id, "/b.md", ctx, false));
    expect(findPane(r, p2.pid)?.tabs.map((t) => t.path)).toEqual([
      "/a.md",
      "/b.md",
    ]);
    expect(r.focus).toBe(p2.pid);
    expect(findPane(r, p1.pid)?.tabs).toHaveLength(1);
  });

  it("另一台主机上同路径不算已开；没有该主机的预览窗格 → 新开窗格", () => {
    const { ctx, win, p3, gfiles } = setup();
    const r = val(openPreview(win, p3.pid, gfiles.id, "/a.md", ctx, false));
    // 不再塞进来源窗格（那会把文件管理器挤掉）
    expect(findPane(r, p3.pid)?.tabs).toHaveLength(1);
    const hit = panesOf(r)
      .flatMap((p) => p.tabs)
      .filter((t) => t.type === "preview" && t.path === "/a.md")
      .map((t) => (t.type === "preview" ? t.host : null));
    expect(hit).toContain(GPU);
  });

  it("来源窗格不存在 → not-found", () => {
    const { ctx, win } = setup();
    bad(openPreview(win, "nope", null, "/a", ctx, false), "not-found");
  });

  const previews = (w: Window, host = BUILD) =>
    panesOf(w)
      .flatMap((p) => p.tabs)
      .filter((t) => t.type === "preview" && t.host === host);

  it("单击：新文件开成临时预览（放进同主机的预览窗格）", () => {
    const { ctx, win, p1, p2, files } = setup();
    const r = val(openPreview(win, p1.pid, files.id, "/b.md", ctx, true));
    const tabs = findPane(r, p2.pid)?.tabs ?? [];
    expect(tabs.map((t) => [t.path, t.temp === true])).toEqual([
      ["/a.md", false],
      ["/b.md", true],
    ]);
  });

  it("再单击别的文件：就地换掉临时预览（位置不变、换新标签 id、总数不变）", () => {
    const { ctx, win, p1, p2, files } = setup();
    const one = val(openPreview(win, p1.pid, files.id, "/b.md", ctx, true));
    const oldId = findPane(one, p2.pid)?.tabs[1]?.id;
    const two = val(openPreview(one, p1.pid, files.id, "/c.md", ctx, true));
    const tabs = findPane(two, p2.pid)?.tabs ?? [];
    expect(tabs.map((t) => t.path)).toEqual(["/a.md", "/c.md"]);
    expect(tabs[1]?.temp).toBe(true);
    expect(tabs[1]?.id).not.toBe(oldId);
    expect(findPane(two, p2.pid)?.active).toBe(tabs[1]?.id);
  });

  it("单击已固定的文件：只激活，不变成临时", () => {
    const { ctx, win, p1, p2, files, prev } = setup();
    const r = val(openPreview(win, p1.pid, files.id, "/a.md", ctx, true));
    expect(findPane(r, p2.pid)?.active).toBe(prev.id);
    expect(previews(r).every((t) => t.temp !== true)).toBe(true);
  });

  it("双击正是临时预览的那个文件：固定它，不新增标签", () => {
    const { ctx, win, p1, p2, files } = setup();
    const one = val(openPreview(win, p1.pid, files.id, "/b.md", ctx, true));
    const tid = findPane(one, p2.pid)?.tabs[1]?.id;
    const two = val(openPreview(one, p1.pid, files.id, "/b.md", ctx, false));
    const tabs = findPane(two, p2.pid)?.tabs ?? [];
    expect(tabs).toHaveLength(2);
    expect(tabs[1]?.id).toBe(tid);
    expect(tabs[1]?.temp).toBeUndefined();
  });

  it("双击另一个文件：开固定标签，已有的临时预览不动；之后单击仍替换那个临时的", () => {
    const { ctx, win, p1, p2, files } = setup();
    const one = val(openPreview(win, p1.pid, files.id, "/b.md", ctx, true));
    const two = val(openPreview(one, p1.pid, files.id, "/c.md", ctx, false));
    expect(
      findPane(two, p2.pid)?.tabs.map((t) => [t.path, t.temp === true]),
    ).toEqual([
      ["/a.md", false],
      ["/b.md", true],
      ["/c.md", false],
    ]);
    const three = val(openPreview(two, p1.pid, files.id, "/d.md", ctx, true));
    expect(findPane(three, p2.pid)?.tabs.map((t) => t.path)).toEqual([
      "/a.md",
      "/d.md",
      "/c.md",
    ]);
  });

  it("临时预览按主机各一个：另一台主机的单击不换掉这台的", () => {
    const { ctx, win, p1, p3, files, gfiles } = setup();
    const one = val(openPreview(win, p1.pid, files.id, "/b.md", ctx, true));
    const two = val(openPreview(one, p3.pid, gfiles.id, "/x.md", ctx, true));
    expect(
      previews(two)
        .filter((t) => t.temp)
        .map((t) => t.path),
    ).toEqual(["/b.md"]);
    expect(previews(two, GPU).map((t) => [t.path, t.temp === true])).toEqual([
      ["/x.md", true],
    ]);
  });

  it("固定与临时标记用 patchTab 去掉（双击标签）", () => {
    const { ctx, win, p1, p2, files } = setup();
    const one = val(openPreview(win, p1.pid, files.id, "/b.md", ctx, true));
    const tid = findPane(one, p2.pid)?.tabs[1]?.id ?? "";
    const r = val(patchTab(one, tid, { temp: undefined }));
    expect(findTab(r, tid)?.tab.temp).toBeUndefined();
  });

  it("对话里点文件：有该主机的预览窗格就放进去", () => {
    const { ctx, win, p1, p2, files } = setup();
    const r = val(openFilePreview(win, p1.pid, files.id, BUILD, "/b.md", ctx));
    expect(findPane(r, p2.pid)?.tabs.map((t) => t.path)).toEqual([
      "/a.md",
      "/b.md",
    ]);
    expect(r.focus).toBe(p2.pid);
    expect(findPane(r, p1.pid)?.tabs).toHaveLength(1);
  });

  it("对话里点文件：没有该主机的预览窗格就在右侧新开窗格，不塞进对话窗格", () => {
    const { ctx, win, p1, files } = setup();
    const r = val(openFilePreview(win, p1.pid, files.id, GPU, "/a.md", ctx));
    const hit = panesOf(r).flatMap((p) =>
      p.tabs
        .filter((t) => t.type === "preview" && t.host === GPU)
        .map((t) => ({ pane: p, tab: t })),
    );
    expect(hit).toHaveLength(1);
    expect(hit[0]?.tab.path).toBe("/a.md");
    expect(hit[0]?.pane.host).toBe(GPU);
    // 来源窗格还是只有原来那个标签
    expect(findPane(r, p1.pid)?.tabs).toHaveLength(1);
  });
});

describe("openDiff：轮末 diff 属于某个会话的某一轮", () => {
  function setup() {
    const ctx = mkCtx();
    const files = newTab(ctx, "files", { host: BUILD });
    const p1 = newPane(ctx, [files], BUILD);
    const win: Window = { id: "w1", root: p1, focus: p1.pid };
    return { ctx, win, p1, files };
  }
  const diffs = (w: Window) =>
    panesOf(w)
      .flatMap((p) => p.tabs)
      .filter((t) => t.diff);

  it("新开的 diff 标签带上会话 id", () => {
    const { ctx, win, p1, files } = setup();
    const r = val(openDiff(win, p1.pid, files.id, 3, "/a.ts", ctx, "sA"));
    expect(diffs(r)).toHaveLength(1);
    expect(diffs(r)[0]).toMatchObject({
      sid: "sA",
      diff: { turn: 3, path: "/a.ts" },
    });
  });

  it("两个会话的同一轮同一文件不是同一个标签", () => {
    const { ctx, win, p1, files } = setup();
    const a = val(openDiff(win, p1.pid, files.id, 3, "/a.ts", ctx, "sA"));
    const b = val(openDiff(a, p1.pid, files.id, 3, "/a.ts", ctx, "sB"));
    expect(diffs(b).map((t) => t.sid)).toEqual(["sA", "sB"]);
    // 同会话同一轮再开：只聚焦，不新增
    const again = val(openDiff(b, p1.pid, files.id, 3, "/a.ts", ctx, "sA"));
    expect(diffs(again)).toHaveLength(2);
  });

  it("工作区对 HEAD（turn 为 null）不带 sid", () => {
    const { ctx, win, p1, files } = setup();
    const r = val(openDiff(win, p1.pid, files.id, null, "/a.ts", ctx));
    expect(diffs(r)[0]?.sid).toBeUndefined();
  });
});

describe("openTeamDiff：团队建队以来的改动属于 lead 会话", () => {
  function setup() {
    const ctx = mkCtx();
    const files = newTab(ctx, "files", { host: BUILD });
    const p1 = newPane(ctx, [files], BUILD);
    const win: Window = { id: "w1", root: p1, focus: p1.pid };
    return { ctx, win, p1, files };
  }
  const diffs = (w: Window) =>
    panesOf(w)
      .flatMap((p) => p.tabs)
      .filter((t) => t.diff);

  it("新开的标签带 team 与会话 id；同会话同文件再开只聚焦", () => {
    const { ctx, win, p1, files } = setup();
    const a = val(openTeamDiff(win, p1.pid, files.id, "a.ts", ctx, "sA"));
    expect(diffs(a)[0]).toMatchObject({
      sid: "sA",
      diff: { turn: null, path: "a.ts", team: true },
    });
    expect(
      diffs(val(openTeamDiff(a, p1.pid, files.id, "a.ts", ctx, "sA"))),
    ).toHaveLength(1);
  });

  it("与同路径的工作区对 HEAD、某一轮的 diff 是不同的标签；两个会话的团队也不同", () => {
    const { ctx, win, p1, files } = setup();
    let w = val(openDiff(win, p1.pid, files.id, null, "a.ts", ctx));
    w = val(openDiff(w, p1.pid, files.id, 1, "a.ts", ctx, "sA"));
    w = val(openTeamDiff(w, p1.pid, files.id, "a.ts", ctx, "sA"));
    w = val(openTeamDiff(w, p1.pid, files.id, "a.ts", ctx, "sB"));
    expect(diffs(w)).toHaveLength(4);
  });
});

describe("按工作区的默认窗口：对话标签可绑外部会话", () => {
  it("ctx 与 init 都没有 sid：对话标签不写 sid 键（空对话标签）", () => {
    const tag = newTab({ ids: idGenFrom([]) }, "chat");
    expect(tag).toEqual({ id: tag.id, type: "chat", ctab: "chat" });
    expect("sid" in tag).toBe(false);
  });

  it("defaultWindow 的第三个参数指定对话标签的会话", () => {
    const w = defaultWindow({ ids: idGenFrom([]) }, [], "x");
    expect(panesOf(w)[0]?.tabs[0]).toMatchObject({ type: "chat", sid: "x" });
  });

  it("不传第三个参数：行为不变（走 ctx.sid，没有就是空对话标签）", () => {
    expect(panesOf(defaultWindow(mkCtx("s9"), []))[0]?.tabs[0]?.sid).toBe("s9");
    const w = defaultWindow({ ids: idGenFrom([]) }, WS);
    expect(panesOf(w)[0]?.tabs[0]?.sid).toBeUndefined();
    // initialWindows / addWindow 同样透传
    const st = initialWindows({ ids: idGenFrom([]) }, [], "x");
    expect(panesOf(st.list[0] as Window)[0]?.tabs[0]?.sid).toBe("x");
    const added = addWindow(
      st,
      { ids: idGenFrom(usedIds({ a: st })) },
      [],
      "y",
    );
    expect(panesOf(added.list[1] as Window)[0]?.tabs[0]?.sid).toBe("y");
  });

  it("web 标签不绑会话：浏览器跟工作区走，只记当前显示的页面", () => {
    const ctx = mkCtx("s1");
    const tab = newTab(ctx, "web", { sid: "s2", page: "p1" });
    expect(tab).toMatchObject({ page: "p1" });
    expect("sid" in tab).toBe(false);
    expect("host" in tab).toBe(false);
  });
});

describe("revealBrowser：agent 开始用浏览器时自动出标签", () => {
  /** P1(chat) | P2(web 当前页 p1 + files 标签，active 在 files)；focus 在 P1 */
  function setup() {
    const ctx = mkCtx();
    const chat = newTab(ctx, "chat");
    const web = newTab(ctx, "web", { page: "p1" });
    const files = newTab(ctx, "files");
    const p1 = newPane(ctx, [chat]);
    const p2 = newPane(ctx, [web, files], "server");
    p2.active = files.id;
    const win: Window = {
      id: "w1",
      root: { dir: "row", sizes: [1, 1], children: [p1, p2] },
      focus: p1.pid,
    };
    return { ctx, win, p1, p2, web, files };
  }
  const webTabs = (w: Window) =>
    panesOf(w).flatMap((p) => p.tabs.filter((t) => t.type === "web"));

  it("没有浏览器标签 → 在焦点窗格右侧新开窗格放它，焦点不动", () => {
    const ctx = mkCtx();
    const p1 = newPane(ctx, [newTab(ctx, "chat")]);
    const win: Window = { id: "w1", root: p1, focus: p1.pid };
    const r = val(revealBrowser(win, "p9", ctx));
    expect(webTabs(r).map((t) => t.page)).toEqual(["p9"]);
    expect(paneCount(r)).toBe(2);
    expect(r.focus).toBe(p1.pid);
  });

  it("有但在后台 → 切过去并显示这个页面，焦点不动", () => {
    const { ctx, win, p1, p2, web } = setup();
    const r = val(revealBrowser(win, "p9", ctx));
    expect(findPane(r, p2.pid)?.active).toBe(web.id);
    expect(findTab(r, web.id)?.tab.page).toBe("p9");
    expect(webTabs(r)).toHaveLength(1);
    expect(r.focus).toBe(p1.pid);
  });

  it("已在前台 → 窗口原样不动（标签自己提示新页面）", () => {
    const { ctx, win, p2, web } = setup();
    const shown = val(activateTab(win, p2.pid, web.id));
    expect(val(revealBrowser(shown, "p9", ctx))).toBe(shown);
  });

  it("窗格数到上限又没有浏览器标签 → limit", () => {
    const ctx = mkCtx();
    let win: Window = {
      id: "w1",
      root: newPane(ctx, [newTab(ctx, "chat")]),
      focus: "",
    };
    win.focus = panesOf(win)[0]?.pid ?? "";
    while (paneCount(win) < MAX_PANES)
      win = val(splitPane(win, win.focus, "right", newTab(ctx, "term"), ctx));
    bad(revealBrowser(win, "p9", ctx), "limit");
  });
});

describe("openInBrowser：用户主动在浏览器里看某个页面", () => {
  function setup() {
    const ctx = mkCtx();
    const chat = newTab(ctx, "chat");
    const web = newTab(ctx, "web", { page: "p1" });
    const files = newTab(ctx, "files");
    const p1 = newPane(ctx, [chat]);
    const p2 = newPane(ctx, [web, files], "server");
    p2.active = files.id;
    const win: Window = {
      id: "w1",
      root: { dir: "row", sizes: [1, 1], children: [p1, p2] },
      focus: p1.pid,
    };
    return { ctx, win, p1, p2, web };
  }

  it("已有浏览器标签 → 显示这一页、切过去、焦点跟过去，不新增标签", () => {
    const { ctx, win, p1, p2, web } = setup();
    const r = val(openInBrowser(win, p1.pid, "p9", ctx));
    expect(findTab(r, web.id)?.tab.page).toBe("p9");
    expect(findPane(r, p2.pid)?.active).toBe(web.id);
    expect(r.focus).toBe(p2.pid);
    expect(
      panesOf(r)
        .flatMap((p) => p.tabs)
        .filter((t) => t.type === "web"),
    ).toHaveLength(1);
  });

  it("没有浏览器标签 → 在来源窗格右侧新开窗格，焦点在新窗格", () => {
    const ctx = mkCtx();
    const p1 = newPane(ctx, [newTab(ctx, "chat")]);
    const win: Window = { id: "w1", root: p1, focus: p1.pid };
    const r = val(openInBrowser(win, p1.pid, "p9", ctx));
    const webs = panesOf(r)
      .flatMap((p) => p.tabs)
      .filter((t) => t.type === "web");
    expect(webs.map((t) => t.page)).toEqual(["p9"]);
    expect(r.focus).not.toBe(p1.pid);
    expect(findPane(r, p1.pid)?.tabs).toHaveLength(1);
  });

  it("来源窗格不存在 → not-found", () => {
    const { ctx, win } = setup();
    bad(openInBrowser(win, "nope", "p9", ctx), "not-found");
  });
});
