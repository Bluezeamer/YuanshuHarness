// 窗口树的解析与修复（走 loadLayout 入口）：任意输入都不抛、落到合法布局、幂等。
import { describe, expect, it } from "vitest";
import { isBranch, type Tree } from "../../../ui/tiling/tree";
import type { Ctx } from "./l2";
import {
  addWindow,
  idGenFrom,
  initialWindows,
  isHostTab,
  MAX_PANES,
  newTab,
  panesOf,
  patchAfx,
  patchTab,
  splitPane,
} from "./l2";
import type { LayoutDoc } from "./layoutDoc";
import {
  emptyLayout,
  LAYOUT_VERSION,
  loadLayout,
  serializeLayout,
} from "./layoutDoc";
import { newIdPool, parseWindowState } from "./persist";
import { val } from "./testkit";
import type { Pane } from "./types";

const WS = [
  { host: "build-node-03", path: "/w/a" },
  { host: "gpu-04", path: "/w/b" },
];

/** 一份有代表性的布局：两个窗口、嵌套窗格树、终端 id、afx、web 标签带当前页面 */
function rich(): LayoutDoc {
  const ids = idGenFrom([]);
  const ctx: Ctx = { sid: "auth", ids };
  let st = initialWindows(ctx, WS);
  const first = st.list[0] as NonNullable<(typeof st.list)[0]>;
  const [, build, gpu] = panesOf(first) as [Pane, Pane, Pane];
  let win = val(
    patchTab(first, build.tabs[1]?.id ?? "", {
      termId: "term-7",
      termEnded: true,
    }),
  );
  win = val(
    patchAfx(win, build.tabs[0]?.id ?? "", {
      w: 320,
      subAll: true,
      fold: { src: true },
    }),
  );
  win = val(
    splitPane(win, gpu.pid, "bottom", newTab(ctx, "web", { page: "p1" }), ctx),
  );
  st = { list: [win], active: 0 };
  st = addWindow(st, ctx, []);
  return { version: LAYOUT_VERSION, windows: st };
}

/** 逐条检查一份布局文档是否满足全部结构不变式 */
function assertValid(doc: LayoutDoc) {
  expect(doc.version).toBe(LAYOUT_VERSION);
  const ids = new Set<string>();
  const uniq = (id: string) => {
    expect(ids.has(id)).toBe(false);
    ids.add(id);
  };
  const walk = (n: Tree<object>): void => {
    if (!isBranch(n)) return;
    expect(n.children.length).toBeGreaterThanOrEqual(2);
    expect(n.sizes).toHaveLength(n.children.length);
    for (const s of n.sizes) expect(Number.isFinite(s) && s > 0).toBe(true);
    for (const c of n.children) walk(c);
  };
  const st = doc.windows;
  if (!st.list.length) {
    expect(st.active).toBe(0);
    return;
  }
  expect(
    Number.isInteger(st.active) && st.active >= 0 && st.active < st.list.length,
  ).toBe(true);
  for (const w of st.list) {
    uniq(w.id);
    walk(w.root);
    const panes = panesOf(w);
    expect(panes.length).toBeGreaterThan(0);
    expect(panes.length).toBeLessThanOrEqual(MAX_PANES);
    expect(panes.map((p) => p.pid)).toContain(w.focus);
    for (const p of panes) {
      uniq(p.pid);
      expect(p.tabs.length).toBeGreaterThan(0);
      expect(p.tabs.map((t) => t.id)).toContain(p.active);
      const hostTabs = p.tabs.filter(isHostTab);
      if (hostTabs.length)
        expect(
          hostTabs.every((t) => t.host === p.host && p.host !== null),
        ).toBe(true);
      else expect(p.host).toBeNull();
      for (const t of p.tabs) uniq(t.id);
    }
  }
}

// ── 修复：手写的损坏输入 ──

const tab = (id: string, type: string, extra: object = {}) => ({
  id,
  type,
  ...extra,
});
const pane = (pid: string, tabs: unknown[], extra: object = {}) => ({
  pid,
  host: null,
  tabs,
  active: "",
  ...extra,
});
const win = (root: unknown, extra: object = {}) => ({
  id: "w1",
  focus: "",
  root,
  ...extra,
});
const withWindows = (list: unknown[], active: unknown = 0) => ({
  version: LAYOUT_VERSION,
  windows: { list, active },
});
const row = (...children: unknown[]) => ({
  dir: "row",
  sizes: children.map(() => 1),
  children,
});
const fixed = (raw: unknown): LayoutDoc => {
  const d = val(loadLayout(raw));
  assertValid(d);
  return d;
};
const panesIn = (d: LayoutDoc, idx = 0) =>
  panesOf(d.windows.list[idx] as never) as Pane[];

describe("修复：任意输入都不抛、落到合法布局", () => {
  it("顶层垃圾 → 空布局", () => {
    for (const raw of [
      null,
      undefined,
      0,
      "str",
      [],
      true,
      {},
      { version: 3 },
      { windows: 5 },
      { version: LAYOUT_VERSION, windows: "x" },
    ]) {
      expect(fixed(raw)).toEqual(emptyLayout());
    }
  });

  it("读属性就抛的对象 / 自引用结构也不抛", () => {
    const boom = {
      get wins(): never {
        throw new Error("boom");
      },
    };
    expect(fixed(boom)).toEqual(emptyLayout());
    const cyc: Record<string, unknown> = { dir: "row", sizes: [1, 1] };
    cyc.children = [cyc, cyc];
    expect(() => fixed(withWindows([win(cyc)]))).not.toThrow();
  });

  it("嵌套过深的树被截断，不爆栈", () => {
    // 每层只留一个坏孩子和更深的枝条：超过 MAX_DEPTH 的枝条整支丢掉，窗口随之消失
    let deep: unknown = pane("pdeep", [tab("tdeep", "chat")]);
    for (let i = 0; i < 200; i++) deep = row({ junk: 1 }, deep);
    expect(fixed(withWindows([win(deep)])).windows.list).toEqual([]);
  });

  it("坏标签 / 无标签的窗格 / 无窗格的窗口 都被丢弃", () => {
    const d = fixed(
      withWindows([
        win(pane("p1", [tab("t1", "nope"), null, 5, tab("t2", "chat")]), {
          id: "w1",
        }),
        win(pane("p2", [tab("t3", "nope")]), { id: "w2" }),
        win({ junk: 1 }, { id: "w3" }),
        win(pane("p4", [tab("t4", "chat")]), { id: "w4" }),
      ]),
    );
    expect(d.windows.list.map((w) => w.id)).toEqual(["w1", "w4"]);
    expect(panesIn(d)[0]?.tabs.map((t) => t.id)).toEqual(["t2"]);
  });

  it("一个分支里坏孩子被丢，剩一个则提升；sizes 缺失或非正数补 1", () => {
    const d = fixed(
      withWindows([
        win({
          dir: "col",
          sizes: [0, "x"],
          children: [pane("p1", [tab("t1", "chat")]), { junk: 1 }],
        }),
        win({
          dir: "weird",
          sizes: [-1, 3, null],
          children: [
            pane("p2", [tab("t2", "chat")]),
            pane("p3", [tab("t3", "chat")]),
            pane("p4", [tab("t4", "chat")]),
          ],
        }),
      ]),
    );
    const [a, b] = (d.windows.list ?? []).map((w) => w.root);
    expect(a && isBranch(a)).toBe(false);
    if (!b || !isBranch(b)) throw new Error("第二个窗口的根应是分支");
    expect(b.dir).toBe("row");
    expect(b.sizes).toEqual([1, 3, 1]);
  });

  it("id 重复（跨窗格 / 跨窗口）→ 后来者换新 id，对象都保留", () => {
    const dup = () =>
      win(
        row(
          pane("p1", [tab("t1", "chat"), tab("t1", "chat")]),
          pane("p1", [tab("t1", "chat")]),
        ),
      );
    const d = fixed(withWindows([dup(), dup()]));
    expect(d.windows.list).toHaveLength(2);
    expect(panesIn(d, 0)).toHaveLength(2);
    expect(panesIn(d, 0)[0]?.tabs).toHaveLength(2);
    const pids = d.windows.list.flatMap((w) => panesOf(w).map((p) => p.pid));
    expect(new Set(pids).size).toBe(4);
    const tids = d.windows.list.flatMap((w) =>
      panesOf(w).flatMap((p) => p.tabs.map((t) => t.id)),
    );
    expect(new Set(tids).size).toBe(6);
  });

  it("缺失的 id 补发新的", () => {
    const d = fixed(withWindows([{ root: { tabs: [{ type: "chat" }] } }]));
    const [p] = panesIn(d);
    expect(p?.tabs).toHaveLength(1);
    expect(d.windows.list[0]?.id).toBeTruthy();
    expect(p?.pid).toBeTruthy();
    expect(p?.tabs[0]?.id).toBeTruthy();
  });

  it("窗格主机隔离：混入的另一台主机的标签被丢弃，对话标签保留", () => {
    const a = fixed(
      withWindows([
        win(
          pane(
            "p1",
            [
              tab("t1", "term", { host: "A" }),
              tab("t2", "files", { host: "B" }),
              tab("t3", "chat"),
            ],
            { host: "A" },
          ),
        ),
      ]),
    );
    expect(panesIn(a)[0]?.tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(panesIn(a)[0]?.host).toBe("A");
    // 声明的主机不存在 / 没声明 → 取第一个主机级标签的主机
    const b = fixed(
      withWindows([
        win(
          pane(
            "p1",
            [
              tab("t1", "files", { host: "B" }),
              tab("t2", "term", { host: "A" }),
            ],
            { host: "Z" },
          ),
        ),
      ]),
    );
    expect(panesIn(b)[0]?.host).toBe("B");
    expect(panesIn(b)[0]?.tabs.map((t) => t.id)).toEqual(["t1"]);
    // 只有对话标签却声明了主机 → 解绑
    expect(
      panesIn(
        fixed(
          withWindows([win(pane("p1", [tab("t1", "chat")], { host: "A" }))]),
        ),
      )[0]?.host,
    ).toBeNull();
  });

  it("窗格超过上限 → 截到 MAX_PANES；focus / active 指向不存在 → 落到第一个", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      pane(`p${i}`, [tab(`t${i}`, "chat")], { active: "ghost" }),
    );
    const d = fixed(withWindows([win(row(...many), { focus: "ghost" })]));
    expect(panesIn(d)).toHaveLength(MAX_PANES);
    expect(d.windows.list[0]?.focus).toBe("p0");
    expect(panesIn(d)[0]?.active).toBe("t0");
    const ok2 = fixed(
      withWindows([
        win(
          row(
            pane("pa", [tab("ta", "chat"), tab("tb", "chat")], {
              active: "tb",
            }),
            pane("pb", [tab("tc", "chat")]),
          ),
          { focus: "pb" },
        ),
      ]),
    );
    expect(ok2.windows.list[0]?.focus).toBe("pb");
    expect(panesIn(ok2)[0]?.active).toBe("tb");
  });

  it("窗口 active 夹回范围；非整数 / 非数字 → 0", () => {
    const list = [
      win(pane("p1", [tab("t1", "chat")]), { id: "w1" }),
      win(pane("p2", [tab("t2", "chat")]), { id: "w2" }),
    ];
    expect(fixed(withWindows(list, 99)).windows.active).toBe(1);
    expect(fixed(withWindows(list, -3)).windows.active).toBe(0);
    expect(fixed(withWindows(list, 1.5)).windows.active).toBe(0);
    expect(fixed(withWindows(list, "1")).windows.active).toBe(0);
    expect(fixed(withWindows(list, 1)).windows.active).toBe(1);
  });

  it("标签字段按类型过滤：termId 只属于 term，termEnded 依附 termId", () => {
    const d = fixed(
      withWindows([
        win(
          pane(
            "p1",
            [
              tab("t1", "term", { host: "A", termId: "x1", termEnded: true }),
              tab("t2", "term", { host: "A", termEnded: true }),
              tab("t3", "term", { host: "A", termId: "x3", termEnded: "yes" }),
              tab("t4", "files", { host: "A", termId: "no", path: 5 }),
              tab("t5", "web", { host: "A", page: "p1", cwd: "" }),
              tab("t6", "term", { termId: 42 }),
            ],
            { host: "A" },
          ),
        ),
      ]),
    );
    const t = Object.fromEntries(
      (panesIn(d)[0]?.tabs ?? []).map((x) => [x.id, x]),
    );
    expect(t.t1).toMatchObject({ termId: "x1", termEnded: true });
    expect(t.t2?.termEnded).toBeUndefined(); // 没有 termId 的「已结束」没有意义
    expect(t.t3?.termEnded).toBeUndefined();
    expect(t.t6).toBeUndefined(); // host 缺省为 server，与窗格 A 不同被隔离掉
    expect(t.t4).toMatchObject({ path: "" });
    expect(t.t4?.termId).toBeUndefined();
    expect(t.t5).toMatchObject({ page: "p1" });
    expect(t.t5?.cwd).toBeUndefined();
  });

  it("主机三档：浏览器不留 host 且不被窗格主机隔离掉，画布留 host 也不被隔离", () => {
    const d = fixed(
      withWindows([
        win(
          pane(
            "p1",
            [
              tab("t1", "term", { host: "A" }),
              tab("t2", "web", { host: "B", page: "p1" }),
              tab("t3", "canvas", { host: "B", path: "/w" }),
              tab("t4", "files", { host: "B" }),
            ],
            { host: "A" },
          ),
        ),
      ]),
    );
    const t = Object.fromEntries(
      (panesIn(d)[0]?.tabs ?? []).map((x) => [x.id, x]),
    );
    expect(t.t2 && "host" in t.t2).toBe(false);
    expect(t.t2?.page).toBe("p1");
    expect(t.t3?.host).toBe("B");
    expect(t.t4).toBeUndefined(); // 按主机隔离的类型仍然按窗格主机兜底
    expect(panesIn(d)[0]?.host).toBe("A");
  });

  it("chat 标签没有 sid 就不写 sid；ctab 只认 chat / audit", () => {
    const d = fixed(
      withWindows([
        win(
          pane("p1", [
            tab("t1", "chat", { ctab: "audit" }),
            tab("t2", "chat", { ctab: "zzz", sid: "other" }),
            tab("t3", "sub"),
          ]),
        ),
      ]),
    );
    const [a, b, c] = panesIn(d)[0]?.tabs ?? [];
    expect(a).toMatchObject({ ctab: "audit" });
    expect(a?.sid).toBeUndefined();
    expect(b).toMatchObject({ ctab: "chat", sid: "other" });
    expect(c).toMatchObject({ type: "sub" });
    expect(c?.sid).toBeUndefined();
  });

  it("afx：只留类型合法的字段，全空则整个字段消失", () => {
    const afx = {
      subAll: "yes",
      subOpen: ["a", 3, "b"],
      subSeen: [],
      filter: 5,
      mode: "json",
      w: 280,
      fold: { a: true, b: "x", c: false },
      extra: 1,
    };
    const d = fixed(
      withWindows([
        win(
          pane("p1", [
            tab("t1", "chat", { afx }),
            tab("t2", "chat", { afx: { w: 0, junk: 1 } }),
          ]),
        ),
      ]),
    );
    const [a, b] = panesIn(d)[0]?.tabs ?? [];
    expect(a?.afx).toEqual({
      subOpen: ["a", "b"],
      mode: "json",
      w: 280,
      fold: { a: true, c: false },
    });
    expect(b && "afx" in b).toBe(false);
  });

  it("afx：画布标签的浏览历史（cv）：只留字符串条目，当前位置夹进范围，空的丢弃", () => {
    const d = fixed(
      withWindows([
        win(
          pane("p1", [
            tab("t1", "canvas", {
              afx: { cv: { stack: ["board:想法", 3, "", "note:a.md"], at: 9 } },
            }),
            tab("t2", "canvas", { afx: { cv: { stack: [], at: 0 } } }),
            tab("t3", "canvas", { afx: { cv: { stack: ["board:x"] } } }),
          ]),
        ),
      ]),
    );
    const [a, b, c] = panesIn(d)[0]?.tabs ?? [];
    expect(a?.afx).toEqual({
      cv: { stack: ["board:想法", "note:a.md"], at: 1 },
    });
    expect(b && "afx" in b).toBe(false);
    expect(c && "afx" in c).toBe(false);
  });

  it("afx：审计的筛选档与搜索词是合法字符串就原样保留，空串丢弃", () => {
    const d = fixed(
      withWindows([
        win(
          pane("p1", [
            tab("t1", "chat", { afx: { filter: "tool", q: "bash" } }),
            tab("t2", "chat", { afx: { filter: "", q: "", mode: "json" } }),
          ]),
        ),
      ]),
    );
    const [a, b] = panesIn(d)[0]?.tabs ?? [];
    expect(a?.afx).toEqual({ filter: "tool", q: "bash" });
    expect(b?.afx).toEqual({ mode: "json" });
  });
});

// ── 种子模糊：把合法布局随机弄坏，解析必须不抛、结果合法、再解析不变 ──

function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK: unknown[] = [
  null,
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "x",
  [],
  {},
  true,
  [null],
  { children: [] },
];

function corrupt(v: unknown, rnd: () => number, rate: number): unknown {
  if (rnd() < rate) {
    const r = rnd();
    if (r < 0.6) return JUNK[Math.floor(rnd() * JUNK.length)];
    if (r < 0.8 && Array.isArray(v)) return [...v, ...v];
    return undefined;
  }
  if (Array.isArray(v)) return v.map((x) => corrupt(x, rnd, rate));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = corrupt(x, rnd, rate);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return v;
}

describe("修复：种子模糊", () => {
  it("随机损坏 400 次：不抛、结果满足全部不变式、幂等", () => {
    const base = JSON.parse(serializeLayout(rich()));
    let kept = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = prng(seed);
      const mangled = corrupt(base, rnd, 0.04 + (seed % 5) * 0.03);
      const out = fixed(mangled);
      expect(val(loadLayout(out))).toEqual(out);
      if (out.windows.list.length > 0) kept++;
    }
    // 不是每次都被弄成空布局：模糊确实走到了深处的修复分支
    expect(kept).toBeGreaterThan(200);
  });
});

// ── parseWindowState / 标签归属：按工作区的布局文档复用这些解析 ──

describe("parseWindowState", () => {
  const winState = (raw: unknown, owner: string | undefined) =>
    parseWindowState(raw, owner, newIdPool());

  it("list → 窗口列表，active 夹回范围；空列表 / 不是对象 → null", () => {
    const good = {
      list: [
        win(pane("p1", [tab("t1", "chat")]), { id: "w1" }),
        win(pane("p2", [tab("t2", "chat")]), { id: "w2" }),
      ],
      active: 9,
    };
    expect(winState(good, undefined)?.active).toBe(1);
    expect(winState(good, undefined)?.list).toHaveLength(2);
    expect(winState({ ...good, active: -1 }, undefined)?.active).toBe(0);
    for (const raw of [null, 5, {}, { list: [] }, { list: [{ junk: 1 }] }]) {
      expect(winState(raw, undefined)).toBeNull();
    }
  });

  it("owner 为 undefined 时 chat / sub 不写 sid", () => {
    const st = winState(
      {
        list: [
          win(
            pane("p1", [
              tab("t1", "chat"),
              tab("t2", "sub", { sub: "x" }),
              tab("t3", "chat", { sid: "own" }),
            ]),
          ),
        ],
      },
      undefined,
    );
    const [p] = panesOf(st?.list[0] as never) as Pane[];
    const [a, b, c] = p?.tabs ?? [];
    expect(a && "sid" in a).toBe(false);
    expect(b && "sid" in b).toBe(false);
    expect(c?.sid).toBe("own");
  });

  it("job 标签：任务 id 与所属会话原样读回，缺任务 id 的也保留（载入时显示「任务不存在」）", () => {
    const st = winState(
      {
        list: [
          win(
            pane("p1", [
              tab("t1", "job", { job: "j1", sid: "c" }),
              tab("t2", "job"),
              tab("t3", "sub", { sub: "x", job: "j1" }),
            ]),
          ),
        ],
      },
      "s9",
    );
    const [p] = panesOf(st?.list[0] as never) as Pane[];
    const [a, b, c] = p?.tabs ?? [];
    expect(a).toMatchObject({ type: "job", job: "j1", sid: "c" });
    expect(b).toMatchObject({ type: "job", sid: "s9" });
    expect(b && "job" in b).toBe(false);
    expect(c && "job" in c).toBe(false);
  });

  it("owner 有值时 chat / sub 的 sid 回落到 owner", () => {
    const st = winState(
      { list: [win(pane("p1", [tab("t1", "chat"), tab("t2", "sub")]))] },
      "s9",
    );
    const [p] = panesOf(st?.list[0] as never) as Pane[];
    expect(p?.tabs.map((t) => t.sid)).toEqual(["s9", "s9"]);
  });

  it("temp 只在 chat 与 preview 标签上保留", () => {
    const st = winState(
      {
        list: [
          win(
            pane("p1", [
              tab("t1", "chat", { sid: "a", temp: true }),
              tab("t2", "chat", { sid: "b", temp: false }),
              tab("t3", "sub", { sid: "c", temp: true }),
              tab("t4", "term", { host: "server", temp: true }),
              tab("t5", "preview", {
                host: "server",
                path: "a.md",
                temp: true,
              }),
            ]),
          ),
        ],
      },
      undefined,
    );
    const [p] = panesOf(st?.list[0] as never) as Pane[];
    const [a, b, c, d, e] = p?.tabs ?? [];
    expect(a?.temp).toBe(true);
    expect(b && "temp" in b).toBe(false);
    expect(c && "temp" in c).toBe(false);
    expect(d && "temp" in d).toBe(false);
    expect(e?.temp).toBe(true);
  });

  it("web 标签保留当前页面 id，其余标签忽略；旧的 sid 不再带进来", () => {
    const st = winState(
      {
        list: [
          win(
            pane("p1", [
              tab("t1", "web", { host: "server", page: "a", sid: "s" }),
              tab("t2", "term", { host: "server", page: "b" }),
              tab("t3", "web", { host: "server" }),
            ]),
          ),
        ],
      },
      undefined,
    );
    const [p] = panesOf(st?.list[0] as never) as Pane[];
    const [a, b, c] = p?.tabs ?? [];
    expect(a?.page).toBe("a");
    expect(a && "sid" in a).toBe(false);
    expect(b && "page" in b).toBe(false);
    expect(c && "page" in c).toBe(false);
  });
});
