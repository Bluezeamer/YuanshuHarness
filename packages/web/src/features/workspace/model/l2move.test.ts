// 迁移自 mock 的 l1.smoke.cjs：跨主机拖放的放行 / 拒绝、跨容器拒绝、窗格拖到另一个窗口。
// 拖放命中几何（dragover → zone / 禁用标记）在这里以纯函数 dropZoneAt / dropBlocked 断言。
import { describe, expect, it } from "vitest";
import { dropZoneAt, isEdge, STRIP_HEIGHT } from "../../../ui/tiling/zones";
import {
  addTabToPane,
  defaultWindow,
  findPane,
  findTab,
  idGenFrom,
  MAX_PANES,
  newTab,
  paneCount,
  panesOf,
  patchAfx,
  splitPane,
} from "./l2";
import {
  detachPane,
  dropBlocked,
  movePane,
  movePaneIn,
  movePaneToWindow,
  movePaneToWindowIn,
  moveTab,
  moveTabIn,
  tabDragHost,
} from "./l2move";
import { at, bad, mkCtx, val } from "./testkit";
import type { Pane, Tab, Window, WindowState, WinMap } from "./types";

const BUILD = "build-node-03";
const GPU = "gpu-04";
const WS = [
  { host: BUILD, path: "/w/a" },
  { host: GPU, path: "/w/b" },
];

function three() {
  const ctx = mkCtx("auth");
  const w = defaultWindow(ctx, WS);
  const [chat, build, gpu] = panesOf(w) as [Pane, Pane, Pane];
  return { ctx, w, chat, build, gpu };
}
const first = (p: Pane): Tab => p.tabs[0] as Tab;
const pidsOf = (w: Window) => panesOf(w).map((p) => p.pid);
/** 在 build 右边再开一个同主机窗格（装一个新 term） */
function withSecondBuild() {
  const s = three();
  const t = newTab(s.ctx, "term", { host: BUILD });
  const w = val(splitPane(s.w, s.build.pid, "right", t, s.ctx));
  const extra = findTab(w, t.id)?.pane as Pane;
  return { ...s, w, extra, extraTab: t };
}

describe("落点几何", () => {
  it("顶部 34px = strip，距边 24% 内 = 四向，其余 center", () => {
    expect(dropZoneAt(at(500, STRIP_HEIGHT - 1))).toBe("strip");
    expect(dropZoneAt(at(5, 5))).toBe("strip");
    expect(dropZoneAt(at(20, 350))).toBe("left");
    expect(dropZoneAt(at(980, 350))).toBe("right");
    expect(dropZoneAt(at(500, 690))).toBe("bottom");
    expect(dropZoneAt(at(500, 350))).toBe("center");
    expect(isEdge("left")).toBe(true);
    expect(isEdge("center")).toBe(false);
    expect(isEdge("strip")).toBe(false);
  });

  it("tabDragHost：按主机隔离的标签取其主机，其余（对话、浏览器、画布）为 null", () => {
    const { ctx } = three();
    expect(tabDragHost(newTab(ctx, "term", { host: BUILD }))).toBe(BUILD);
    expect(tabDragHost(newTab(ctx, "chat"))).toBeNull();
    expect(tabDragHost(newTab(ctx, "sub"))).toBeNull();
    expect(tabDragHost(newTab(ctx, "web"))).toBeNull();
    expect(tabDragHost(newTab(ctx, "canvas", { host: BUILD }))).toBeNull();
  });

  it("dropBlocked：跨主机时并格 / 并标签禁用，四向拆分可用", () => {
    const { gpu, chat } = three();
    expect(dropBlocked(gpu, BUILD, "center")).toBe(true);
    expect(dropBlocked(gpu, BUILD, "strip")).toBe(true);
    for (const z of ["left", "right", "top", "bottom"] as const)
      expect(dropBlocked(gpu, BUILD, z)).toBe(false);
    expect(dropBlocked(gpu, GPU, "center")).toBe(false);
    expect(dropBlocked(gpu, null, "center")).toBe(false);
    expect(dropBlocked(chat, BUILD, "center")).toBe(false);
  });
});

describe("moveTab：跨窗格", () => {
  it("跨主机拖到边缘 → 贴靠拆分：新窗格属标签自己的主机，目标窗格不变", () => {
    const { ctx, w, build, gpu } = three();
    const tab = first(build);
    const gpuTabs = gpu.tabs.length;
    const r = val(moveTab(w, build.pid, tab.id, gpu.pid, "left", ctx));
    expect(paneCount(r)).toBe(4);
    const moved = findTab(r, tab.id)?.pane as Pane;
    expect(moved.pid).not.toBe(build.pid);
    expect(moved.host).toBe(BUILD);
    expect(moved.tabs).toEqual([tab]);
    expect(findPane(r, gpu.pid)?.host).toBe(GPU);
    expect(findPane(r, gpu.pid)?.tabs).toHaveLength(gpuTabs);
    expect(findPane(r, build.pid)?.tabs).toHaveLength(build.tabs.length - 1);
    expect(r.focus).toBe(moved.pid);
    const ids = pidsOf(r);
    expect(ids.indexOf(moved.pid)).toBe(ids.indexOf(gpu.pid) - 1);
  });

  it("跨主机拖到中部 / 标签条 → 拒绝并点名两台主机、指路到拆分", () => {
    const { ctx, w, build, gpu } = three();
    for (const zone of ["center", "strip"] as const) {
      const e = bad(
        moveTab(w, build.pid, first(build).id, gpu.pid, zone, ctx),
        "host-conflict",
      );
      expect(e.hosts).toEqual([GPU, BUILD]);
      expect(e.error).toContain("贴靠拆分");
    }
  });

  it("浏览器、画布不受主机限制：能拖进别的主机的窗格中部 / 标签条，窗格主机不变", () => {
    const { ctx, w, build, gpu } = three();
    for (const ty of ["web", "canvas"] as const) {
      const tab = newTab(ctx, ty, { host: BUILD });
      const placed = val(addTabToPane(w, build.pid, tab));
      for (const zone of ["center", "strip"] as const) {
        const r = val(moveTab(placed, build.pid, tab.id, gpu.pid, zone, ctx));
        expect(findPane(r, gpu.pid)?.tabs.map((t) => t.id)).toContain(tab.id);
        expect(findPane(r, gpu.pid)?.host).toBe(GPU);
        expect(findPane(r, build.pid)?.host).toBe(BUILD);
      }
    }
  });

  it("同主机并入：加到目标窗格末尾（或 beforeTabId 之前）并激活，空窗格被关掉", () => {
    const { ctx, w, build, extra, extraTab } = withSecondBuild();
    const moved = first(build);
    const r = val(moveTab(w, build.pid, moved.id, extra.pid, "center", ctx));
    expect(findPane(r, extra.pid)?.tabs.map((t) => t.id)).toEqual([
      extraTab.id,
      moved.id,
    ]);
    expect(findPane(r, extra.pid)?.active).toBe(moved.id);
    expect(r.focus).toBe(extra.pid);
    const r2 = val(
      moveTab(w, build.pid, moved.id, extra.pid, "strip", ctx, extraTab.id),
    );
    expect(findPane(r2, extra.pid)?.tabs.map((t) => t.id)).toEqual([
      moved.id,
      extraTab.id,
    ]);
    // 唯一标签搬走 → 源窗格消失
    const emptied = val(
      moveTab(w, extra.pid, extraTab.id, build.pid, "center", ctx),
    );
    expect(findPane(emptied, extra.pid)).toBeUndefined();
    expect(paneCount(emptied)).toBe(3);
    expect(emptied.focus).toBe(build.pid);
  });

  it("源窗格当前标签被摘走 → 落到前一个", () => {
    const { ctx, w, build, extra } = withSecondBuild();
    const [files, term] = build.tabs as [Tab, Tab];
    const r = val(moveTab(w, build.pid, files.id, extra.pid, "center", ctx));
    expect(findPane(r, build.pid)?.active).toBe(term.id);
  });

  it("对话标签不受主机限制；主机级标签并入未绑主机的窗格后绑定该主机", () => {
    const { ctx, w, chat, build } = three();
    const chatTab = first(chat);
    const into = val(
      moveTab(w, chat.pid, chatTab.id, build.pid, "center", ctx),
    );
    expect(findPane(into, build.pid)?.host).toBe(BUILD);
    expect(findPane(into, chat.pid)).toBeUndefined();
    const extra = newTab(ctx, "chat");
    const w2 = val(splitPane(w, chat.pid, "bottom", extra, ctx));
    const target = findTab(w2, extra.id)?.pane as Pane;
    const term = build.tabs[1] as Tab;
    const bound = val(
      moveTab(w2, build.pid, term.id, target.pid, "center", ctx),
    );
    expect(findPane(bound, target.pid)?.host).toBe(BUILD);
  });

  it("摘走最后一个主机级标签 → 源窗格解绑主机", () => {
    const { ctx, w, chat, build } = three();
    const term = newTab(ctx, "term", { host: BUILD });
    const mixed = val(addTabToPane(w, chat.pid, term));
    expect(findPane(mixed, chat.pid)?.host).toBe(BUILD);
    const r = val(moveTab(mixed, chat.pid, term.id, build.pid, "center", ctx));
    expect(findPane(r, chat.pid)?.host).toBeNull();
  });

  it("窗格数上限：多标签窗格再拆出会超限；唯一标签的窗格挪位净增 0，放行", () => {
    const { ctx, w, chat, build } = three();
    let cur = w;
    while (paneCount(cur) < MAX_PANES)
      cur = val(splitPane(cur, chat.pid, "bottom", newTab(ctx, "chat"), ctx));
    bad(
      moveTab(cur, build.pid, first(build).id, chat.pid, "left", ctx),
      "limit",
    );
    const sole = panesOf(cur).find(
      (p) => p.tabs.length === 1 && p.pid !== chat.pid,
    ) as Pane;
    const r = val(
      moveTab(cur, sole.pid, first(sole).id, chat.pid, "right", ctx),
    );
    expect(paneCount(r)).toBe(MAX_PANES);
  });

  it("窗格 / 标签不存在 → not-found", () => {
    const { ctx, w, build, gpu } = three();
    bad(moveTab(w, "nope", "x", gpu.pid, "center", ctx), "not-found");
    bad(moveTab(w, build.pid, "x", "nope", "center", ctx), "not-found");
    bad(moveTab(w, build.pid, "nope", gpu.pid, "left", ctx), "not-found");
  });

  it("不改动输入", () => {
    const { ctx, w, build, gpu } = three();
    const snap = JSON.stringify(w);
    moveTab(w, build.pid, first(build).id, gpu.pid, "right", ctx);
    expect(JSON.stringify(w)).toBe(snap);
  });

  it("标签的 afx 与 termId 随标签走", () => {
    const { ctx, w, build, gpu } = three();
    const term = build.tabs[1] as Tab;
    const w1 = val(patchAfx(w, term.id, { w: 320 }));
    const tab = findTab(w1, term.id)?.tab as Tab;
    const r = val(moveTab(w1, build.pid, term.id, gpu.pid, "right", ctx));
    expect(findTab(r, term.id)?.tab).toEqual(tab);
  });
});

describe("moveTab：同窗格", () => {
  it("重排：beforeTabId 之前，缺省放末尾；激活该标签并聚焦", () => {
    const { ctx, w: w0, build } = three();
    const web = newTab(ctx, "preview", { host: BUILD, path: "/x" });
    const w = val(addTabToPane(w0, build.pid, web));
    const [files, term] = build.tabs as [Tab, Tab];
    const r1 = val(
      moveTab(w, build.pid, web.id, build.pid, "strip", ctx, files.id),
    );
    expect(findPane(r1, build.pid)?.tabs.map((t) => t.id)).toEqual([
      web.id,
      files.id,
      term.id,
    ]);
    expect(findPane(r1, build.pid)?.active).toBe(web.id);
    const r2 = val(moveTab(w, build.pid, files.id, build.pid, "center", ctx));
    expect(findPane(r2, build.pid)?.tabs.map((t) => t.id)).toEqual([
      term.id,
      web.id,
      files.id,
    ]);
    expect(r2.focus).toBe(build.pid);
  });

  it("拖到自己窗格的边缘：多标签 → 拆出新窗格；唯一标签 → 非法", () => {
    const { ctx, w, build, chat } = three();
    const r = val(
      moveTab(w, build.pid, first(build).id, build.pid, "bottom", ctx),
    );
    expect(paneCount(r)).toBe(4);
    expect(findPane(r, build.pid)?.tabs).toHaveLength(build.tabs.length - 1);
    bad(moveTab(w, chat.pid, first(chat).id, chat.pid, "left", ctx), "invalid");
  });
});

describe("movePane", () => {
  it("四边：摘下后在目标旁重新插入，窗格总数不变，跨主机也放行，满员也放行", () => {
    const { ctx, w, chat, build, gpu } = three();
    const r = val(movePane(w, gpu.pid, build.pid, "left"));
    expect(pidsOf(r)).toEqual([chat.pid, gpu.pid, build.pid]);
    expect(r.focus).toBe(gpu.pid);
    let full = w;
    while (paneCount(full) < MAX_PANES)
      full = val(splitPane(full, chat.pid, "bottom", newTab(ctx, "chat"), ctx));
    expect(paneCount(val(movePane(full, gpu.pid, chat.pid, "top")))).toBe(
      MAX_PANES,
    );
  });

  it("中部 / 标签条：全部标签并入目标窗格，源窗格关闭，聚焦目标", () => {
    const { w, build, extra } = withSecondBuild();
    const r = val(movePane(w, extra.pid, build.pid, "center"));
    expect(findPane(r, extra.pid)).toBeUndefined();
    expect(findPane(r, build.pid)?.tabs).toHaveLength(build.tabs.length + 1);
    expect(findPane(r, build.pid)?.active).toBe(extra.active);
    expect(r.focus).toBe(build.pid);
    expect(paneCount(val(movePane(w, extra.pid, build.pid, "strip")))).toBe(3);
  });

  it("跨主机并成一格 → 拒绝并点名两台主机", () => {
    const { w, build, gpu } = three();
    const e = bad(movePane(w, build.pid, gpu.pid, "center"), "host-conflict");
    expect(e.hosts).toEqual([GPU, BUILD]);
    expect(e.error).toContain("贴靠拆分");
  });

  it("对话窗格可并入主机窗格；主机窗格并入未绑主机的窗格后绑定主机", () => {
    const { w, chat, build } = three();
    const a = val(movePane(w, chat.pid, build.pid, "center"));
    expect(findPane(a, build.pid)?.host).toBe(BUILD);
    const b = val(movePane(w, build.pid, chat.pid, "center"));
    expect(findPane(b, chat.pid)?.host).toBe(BUILD);
  });

  it("拖到自己：中心是空操作（原引用），边缘非法；不存在 not-found", () => {
    const { w, build } = three();
    expect(val(movePane(w, build.pid, build.pid, "center"))).toBe(w);
    bad(movePane(w, build.pid, build.pid, "left"), "invalid");
    bad(movePane(w, "nope", build.pid, "left"), "not-found");
    bad(movePane(w, build.pid, "nope", "left"), "not-found");
  });
});

describe("窗口之间", () => {
  const twoWindows = () => {
    const { ctx, w, gpu } = three();
    const w1 = defaultWindow(ctx, []);
    const st: WindowState = { list: [w, w1], active: 0 };
    return { ctx, st, w0: w, w1, gpu, other: panesOf(w1)[0] as Pane };
  };

  it("movePaneToWindow：落在目标窗口焦点窗格右侧，切过去；源窗口少一个", () => {
    const { st, gpu, other } = twoWindows();
    const r = val(movePaneToWindow(st, gpu.pid, 1));
    expect(r.active).toBe(1);
    expect(pidsOf(r.list[1] as Window)).toEqual([other.pid, gpu.pid]);
    expect(r.list[1]?.focus).toBe(gpu.pid);
    expect(paneCount(r.list[0] as Window)).toBe(2);
  });

  it("源窗口只有这一个窗格 → 搬走后源窗口被移除", () => {
    const { st, other, w0 } = twoWindows();
    const r = val(movePaneToWindow(st, other.pid, 0));
    expect(r.list).toHaveLength(1);
    expect(r.active).toBe(0);
    expect(paneCount(r.list[0] as Window)).toBe(paneCount(w0) + 1);
  });

  it("拒绝：同窗口（原引用）、目标窗口满员、越界、窗格不存在", () => {
    const { ctx, st, gpu } = twoWindows();
    expect(val(movePaneToWindow(st, gpu.pid, 0))).toBe(st);
    let full = st.list[1] as Window;
    const only = panesOf(full)[0] as Pane;
    while (paneCount(full) < MAX_PANES)
      full = val(splitPane(full, only.pid, "right", newTab(ctx, "chat"), ctx));
    bad(
      movePaneToWindow(
        { ...st, list: [st.list[0] as Window, full] },
        gpu.pid,
        1,
      ),
      "limit",
    );
    bad(movePaneToWindow(st, gpu.pid, 5), "not-found");
    bad(movePaneToWindow(st, gpu.pid, -1), "not-found");
    bad(movePaneToWindow(st, "nope", 1), "not-found");
  });

  it("detachPane：拆到新窗口并切过去；窗口里只剩一个窗格时拒绝", () => {
    const { st, gpu, other } = twoWindows();
    const ids = idGenFrom([]);
    const r = val(detachPane(st, gpu.pid, ids));
    expect(r.list).toHaveLength(3);
    expect(r.active).toBe(2);
    expect(pidsOf(r.list[2] as Window)).toEqual([gpu.pid]);
    expect(r.list[2]?.focus).toBe(gpu.pid);
    expect(paneCount(r.list[0] as Window)).toBe(2);
    bad(detachPane(st, other.pid, ids), "last");
    bad(detachPane(st, "nope", ids), "not-found");
  });
});

describe("跨会话容器的拒绝（整份窗口表）", () => {
  function world() {
    const ids = idGenFrom([]);
    const a = defaultWindow({ sid: "auth", ids }, WS);
    const b = defaultWindow({ sid: "docs", ids }, [
      { host: BUILD, path: "/d" },
    ]);
    const a2 = defaultWindow({ sid: "auth", ids }, []);
    const wins: WinMap = {
      auth: { list: [a, a2], active: 0 },
      docs: { list: [b], active: 0 },
    };
    return {
      ids,
      wins,
      a,
      a2,
      b,
      pa: panesOf(a) as Pane[],
      pb: panesOf(b) as Pane[],
      pa2: panesOf(a2) as Pane[],
    };
  }

  it("跨容器拖标签 → cross-session，窗口表原样", () => {
    const { ids, wins, pa, pb } = world();
    const r = moveTabIn(
      wins,
      (pa[1] as Pane).pid,
      first(pa[1] as Pane).id,
      (pb[1] as Pane).pid,
      "center",
      ids,
    );
    bad(r, "cross-session");
    bad(
      moveTabIn(
        wins,
        (pa[1] as Pane).pid,
        first(pa[1] as Pane).id,
        (pb[1] as Pane).pid,
        "left",
        ids,
      ),
      "cross-session",
    );
  });

  it("同会话不同窗口 → invalid；窗格不存在 → not-found", () => {
    const { ids, wins, pa, pa2 } = world();
    bad(
      moveTabIn(
        wins,
        (pa[1] as Pane).pid,
        first(pa[1] as Pane).id,
        (pa2[0] as Pane).pid,
        "center",
        ids,
      ),
      "invalid",
    );
    bad(
      moveTabIn(wins, "nope", "x", (pa[0] as Pane).pid, "center", ids),
      "not-found",
    );
  });

  it("同窗口内成功：只替换该窗口，其他会话与窗口保持原引用", () => {
    const { ids, wins, pa } = world();
    const r = val(
      moveTabIn(
        wins,
        (pa[1] as Pane).pid,
        first(pa[1] as Pane).id,
        (pa[2] as Pane).pid,
        "left",
        ids,
      ),
    );
    expect(r.docs).toBe(wins.docs);
    expect(r.auth?.list[1]).toBe(wins.auth?.list[1]);
    expect(paneCount(r.auth?.list[0] as Window)).toBe(4);
    // 新窗格的 id 与全局已有 id 不冲突
    const all = Object.values(r).flatMap((s) =>
      s.list.flatMap((w) => panesOf(w).map((p) => p.pid)),
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it("窗格跨容器移动 → cross-session；同窗口成功", () => {
    const { wins, pa, pb } = world();
    bad(
      movePaneIn(wins, (pa[1] as Pane).pid, (pb[1] as Pane).pid, "left"),
      "cross-session",
    );
    bad(
      movePaneIn(wins, (pa[1] as Pane).pid, (pb[1] as Pane).pid, "center"),
      "cross-session",
    );
    const r = val(
      movePaneIn(wins, (pa[2] as Pane).pid, (pa[0] as Pane).pid, "right"),
    );
    expect(panesOf(r.auth?.list[0] as Window).map((p) => p.pid)).toEqual([
      (pa[0] as Pane).pid,
      (pa[2] as Pane).pid,
      (pa[1] as Pane).pid,
    ]);
    expect(r.docs).toBe(wins.docs);
  });

  it("窗格不能跨容器移到别的窗口；同容器可以", () => {
    const { wins, pa, pb } = world();
    bad(
      movePaneToWindowIn(wins, "auth", (pb[0] as Pane).pid, 0),
      "cross-session",
    );
    bad(movePaneToWindowIn(wins, "auth", "nope", 0), "not-found");
    bad(movePaneToWindowIn(wins, "zzz", (pa[0] as Pane).pid, 0), "not-found");
    const r = val(movePaneToWindowIn(wins, "auth", (pa[2] as Pane).pid, 1));
    expect(r.auth?.active).toBe(1);
    expect(r.docs).toBe(wins.docs);
    expect(val(movePaneToWindowIn(wins, "auth", (pa[0] as Pane).pid, 0))).toBe(
      wins,
    );
  });
});
