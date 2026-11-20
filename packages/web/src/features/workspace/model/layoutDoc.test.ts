// 按工作区的布局文档：空文档、版本规则、修复、往返、体积。
import { describe, expect, it } from "vitest";
import type { Ctx } from "./l2";
import { defaultWindow, idGenFrom, panesOf } from "./l2";
import {
  emptyLayout,
  hasWindows,
  LAYOUT_VERSION,
  layoutBytes,
  layoutIds,
  layoutWithinBudget,
  loadLayout,
  serializeLayout,
} from "./layoutDoc";
import { bad, val } from "./testkit";

const ctx = (used: Iterable<string> = []): Ctx => ({ ids: idGenFrom(used) });
const DIRS = [
  { host: "build-node-03", path: "/w/a" },
  { host: "gpu-04", path: "/w/b" },
];

/** 一个合法文档：两个窗口，第二份是默认窗口 */
const good = () => {
  const a = defaultWindow(ctx(), DIRS);
  const b = defaultWindow(
    ctx([
      a.id,
      ...panesOf(a).flatMap((p) => [p.pid, ...p.tabs.map((t) => t.id)]),
    ]),
    [],
  );
  return {
    version: LAYOUT_VERSION,
    windows: { list: [a, b], active: 1 },
  };
};

describe("emptyLayout / hasWindows", () => {
  it("空布局：有版本、没有窗口", () => {
    const d = emptyLayout();
    expect(d.version).toBe(LAYOUT_VERSION);
    expect(d.windows).toEqual({ list: [], active: 0 });
    expect(hasWindows(d)).toBe(false);
    expect(hasWindows(val(loadLayout(good())))).toBe(true);
  });
});

describe("loadLayout：版本规则", () => {
  it("没有文档 → 空布局", () => {
    for (const raw of [null, undefined]) {
      expect(val(loadLayout(raw))).toEqual(emptyLayout());
    }
  });

  it("比当前新 → too-new", () => {
    bad(loadLayout({ version: LAYOUT_VERSION + 1, windows: {} }), "too-new");
    bad(loadLayout({ version: 99 }), "too-new");
  });

  it("旧版本 / 没有版本 / 不是对象 → 当损坏，给空布局", () => {
    for (const raw of [
      { version: LAYOUT_VERSION - 1, windows: good().windows },
      { windows: good().windows },
      { version: "4", windows: good().windows },
      { version: 3.5 },
      [],
      "x",
      0,
    ]) {
      expect(val(loadLayout(raw))).toEqual(emptyLayout());
    }
  });
});

describe("loadLayout：修复", () => {
  it("坏结构丢弃、id 去重、焦点与 active 指向存在的对象、主机隔离", () => {
    const d = val(
      loadLayout({
        version: LAYOUT_VERSION,
        windows: {
          list: [
            {
              id: "w1",
              focus: "ghost",
              root: {
                dir: "row",
                sizes: [1, "x"],
                children: [
                  {
                    pid: "p1",
                    host: "A",
                    active: "ghost",
                    tabs: [
                      { id: "t1", type: "term", host: "A" },
                      { id: "t1", type: "chat", sid: "s1" },
                      { id: "t2", type: "files", host: "B" },
                    ],
                  },
                  { junk: 1 },
                ],
              },
            },
            { id: "w1", root: { pid: "p9", tabs: [{ type: "chat" }] } },
          ],
          active: 99,
        },
      }),
    );
    expect(d.windows.list).toHaveLength(2);
    expect(d.windows.active).toBe(1);
    const [w1, w2] = d.windows.list;
    expect(w1?.id).toBe("w1");
    expect(w2?.id).not.toBe("w1");
    expect(w1?.focus).toBe("p1");
    const [pane] = panesOf(w1 as NonNullable<typeof w1>);
    // 混入的第二台主机的标签被丢掉，重复 id 换新
    expect(pane?.tabs.map((t) => t.type)).toEqual(["term", "chat"]);
    expect(new Set([pane?.tabs[0]?.id, pane?.tabs[1]?.id]).size).toBe(2);
    expect(pane?.active).toBe(pane?.tabs[0]?.id);
  });

  it("没有 sid 的对话标签保持没有 sid（空对话标签），不会被凭空绑上会话", () => {
    const d = val(
      loadLayout({
        version: LAYOUT_VERSION,
        windows: {
          list: [
            {
              id: "w1",
              focus: "p1",
              root: {
                pid: "p1",
                host: null,
                active: "t1",
                tabs: [{ id: "t1", type: "chat", ctab: "chat", temp: true }],
              },
            },
          ],
          active: 0,
        },
      }),
    );
    const tab = panesOf(d.windows.list[0] as never)[0]?.tabs[0];
    expect(tab?.sid).toBeUndefined();
    expect(tab?.temp).toBe(true);
  });

  it("windows 解析为空（没有窗口 / 全是坏窗口）→ 空列表，active 归零", () => {
    for (const windows of [
      undefined,
      {},
      { list: [] },
      { list: [{ junk: 1 }, 5] },
    ]) {
      expect(
        val(loadLayout({ version: LAYOUT_VERSION, windows })).windows,
      ).toEqual({ list: [], active: 0 });
    }
  });
});

describe("往返与体积", () => {
  it("serializeLayout → JSON.parse → loadLayout 不变", () => {
    const d = val(loadLayout(good()));
    const back = val(loadLayout(JSON.parse(serializeLayout(d))));
    expect(back).toEqual(d);
    expect(serializeLayout(back)).toBe(serializeLayout(d));
  });

  it("layoutWithinBudget 按 UTF-8 字节计：中文路径的文档字节数大于字符数", () => {
    const cjk = val(
      loadLayout({
        version: LAYOUT_VERSION,
        windows: {
          list: [
            {
              id: "w1",
              focus: "p1",
              root: {
                pid: "p1",
                host: "server",
                active: "t1",
                tabs: [
                  {
                    id: "t1",
                    type: "files",
                    host: "server",
                    path: "/项目/文档",
                  },
                ],
              },
            },
          ],
          active: 0,
        },
      }),
    );
    expect(layoutBytes(cjk)).toBeGreaterThan(serializeLayout(cjk).length);

    const d = val(loadLayout(good()));
    expect(layoutBytes(d)).toBe(
      new TextEncoder().encode(serializeLayout(d)).length,
    );
    expect(layoutWithinBudget(d, layoutBytes(d))).toBe(true);
    expect(layoutWithinBudget(d, layoutBytes(d) - 1)).toBe(false);
    expect(layoutWithinBudget(emptyLayout(), layoutBytes(emptyLayout()))).toBe(
      true,
    );
    expect(layoutBytes(emptyLayout())).toBeLessThan(256 * 1024);
  });

  it("layoutIds 收齐窗口 / 窗格 / 标签 id", () => {
    const d = val(loadLayout(good()));
    const ids = layoutIds(d);
    for (const w of d.windows.list) {
      expect(ids).toContain(w.id);
      for (const p of panesOf(w)) {
        expect(ids).toContain(p.pid);
        for (const t of p.tabs) expect(ids).toContain(t.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
