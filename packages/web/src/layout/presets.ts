import { newId } from "./doc";
import type { Registry } from "./registry";
import { paneIds } from "./tree";
import type { LayoutDoc, TreeNode } from "./types";

// 预设用二叉描述（与 mock 的 PRESETS 同形）：叶子是类型标识；pinned 叶子钉在应用时的活动会话上；
// 落成树时同向嵌套并入父节点。
interface Branch {
  dir: "h" | "v";
  ratio: number;
  a: Spec;
  b: Spec;
}
type Spec = string | { pinned: string } | Branch;

const hv = (dir: "h" | "v", ratio: number, a: Spec, b: Spec): Branch => ({
  dir,
  ratio,
  a,
  b,
});

export const PRESETS = {
  hub: {
    name: "中枢 · 四面板",
    spec: hv(
      "h",
      0.5,
      "chat",
      hv("v", 0.42, "filediscovery", hv("h", 0.5, "terminal", "file_preview")),
    ),
  },
  files: {
    name: "文件工作台",
    spec: hv("h", 0.32, "filediscovery", hv("h", 0.6, "file_preview", "chat")),
  },
  term: {
    name: "终端主导",
    spec: hv("v", 0.56, "terminal", hv("h", 0.5, "chat", "web_preview")),
  },
  duo: { name: "双栏开发", spec: hv("h", 0.5, "chat", "file_preview") },
  multihost: {
    name: "跨会话 · 双文件",
    spec: hv(
      "h",
      0.44,
      "chat",
      hv(
        "v",
        0.5,
        "filediscovery",
        hv("h", 0.62, { pinned: "filediscovery" }, "audit"),
      ),
    ),
  },
} satisfies Record<string, { name: string; spec: Spec }>;

export type PresetKey = keyof typeof PRESETS;

const isPreset = (k: string): k is PresetKey => k in PRESETS;

// 用预设替换当前 window：原有 pane 条目一并删除（与 mock 一致），其他 window 不动。
export function applyPreset(
  d: LayoutDoc,
  key: string,
  registry: Registry,
  activeSessionId: string | null,
): LayoutDoc {
  const w = d.windows.find((x) => x.id === d.activeWindowId);
  if (!w || !isPreset(key)) return d;
  const panes = { ...d.panes };
  for (const id of paneIds(w.tree)) delete panes[id];

  const leaf = (type: string, pin: boolean): TreeNode => {
    const e = registry.newEntry(type);
    if (!e) throw new Error(`预设引用了未注册的类型：${type}`);
    const id = newId("p");
    panes[id] = pin
      ? {
          ...e,
          binding: { mode: "fixed", sessionId: activeSessionId, host: null },
        }
      : e;
    return { kind: "leaf", paneId: id };
  };
  const build = (s: Spec): TreeNode => {
    if (typeof s === "string") return leaf(s, false);
    if ("pinned" in s) return leaf(s.pinned, true);
    const a = build(s.a);
    const b = build(s.b);
    if (b.kind === "split" && b.dir === s.dir)
      return {
        kind: "split",
        dir: s.dir,
        children: [a, ...b.children],
        ratios: [s.ratio, ...b.ratios.map((r) => r * (1 - s.ratio))],
      };
    return {
      kind: "split",
      dir: s.dir,
      children: [a, b],
      ratios: [s.ratio, 1 - s.ratio],
    };
  };
  const tree = build(PRESETS[key].spec);
  return {
    ...d,
    panes,
    windows: d.windows.map((x) => (x.id === w.id ? { ...x, tree } : x)),
  };
}
