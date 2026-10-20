import { expect, test } from "vitest";
import { addPane, defaultDoc } from "./doc";
import { defaultRegistry } from "./panes";
import { applyPreset, PRESETS } from "./presets";
import { paneIds } from "./tree";
import type { LayoutDoc } from "./types";

const registry = defaultRegistry();

function base(): LayoutDoc {
  const d = defaultDoc();
  return addPane(
    d,
    d.activeWindowId,
    "old",
    registry.newEntry("chat") as never,
  );
}
const active = (d: LayoutDoc) =>
  d.windows.find((w) => w.id === d.activeWindowId) as LayoutDoc["windows"][0];
const types = (d: LayoutDoc) =>
  paneIds(active(d).tree)
    .map((id) => d.panes[id]?.type)
    .sort();

test("每个预设都能落成树：叶子都已注册，比例每层和为 1", () => {
  for (const key of Object.keys(PRESETS)) {
    const d = applyPreset(base(), key, registry, "s1");
    const check = (n: LayoutDoc["windows"][0]["tree"]): void => {
      if (!n || n.kind === "leaf") return;
      expect(n.children.length).toBe(n.ratios.length);
      expect(n.ratios.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
      n.children.forEach(check);
    };
    check(active(d).tree);
    for (const id of paneIds(active(d).tree))
      expect(registry.get(d.panes[id]?.type ?? "")).toBeTruthy();
  }
});

test("hub 预设：四个面板，同向嵌套并入父节点", () => {
  const d = applyPreset(base(), "hub", registry, null);
  expect(types(d)).toEqual([
    "chat",
    "file_preview",
    "filediscovery",
    "terminal",
  ]);
  const t = active(d).tree;
  expect(t?.kind === "split" && t.dir).toBe("h");
  expect(t?.kind === "split" && t.children).toHaveLength(2);
});

test("同向嵌套被拉平：files 预设三列一层，比例按原二叉折算", () => {
  const t = active(applyPreset(base(), "files", registry, null)).tree;
  if (t?.kind !== "split") throw new Error("split");
  expect(t.children).toHaveLength(3);
  expect(t.ratios[0]).toBeCloseTo(0.32);
  expect(t.ratios[1]).toBeCloseTo(0.68 * 0.6);
  expect(t.ratios[2]).toBeCloseTo(0.68 * 0.4);
});

test("只替换当前 window：旧 pane 条目删除，其他 window 原样", () => {
  const d0 = base();
  const other = { id: "w2", name: "b", tree: null };
  const d = applyPreset(
    { ...d0, windows: [...d0.windows, other] },
    "duo",
    registry,
    null,
  );
  expect(d.panes.old).toBeUndefined();
  expect(d.windows[1]).toBe(other);
  expect(types(d)).toEqual(["chat", "file_preview"]);
});

test("multihost：pinned 叶子钉在应用时的活动会话上，其余跟随", () => {
  const d = applyPreset(base(), "multihost", registry, "s9");
  const modes = paneIds(active(d).tree).map((id) => d.panes[id]?.binding);
  expect(modes.filter((b) => b?.mode === "fixed")).toEqual([
    { mode: "fixed", sessionId: "s9", host: null },
  ]);
});

test("未知预设：文档原样返回", () => {
  const d = base();
  expect(applyPreset(d, "nope", registry, null)).toBe(d);
});
