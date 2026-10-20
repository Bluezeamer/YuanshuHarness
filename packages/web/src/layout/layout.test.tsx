import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test } from "vitest";
import {
  addPane,
  addWindow,
  closeWindow,
  defaultDoc,
  instantiate,
  movePane,
  normalize,
  setPaneConfig,
  setTree,
} from "./doc";
import { PaneLayer } from "./PaneLayer";
import { Registry } from "./registry";
import { paneIds, resize, split } from "./tree";
import type { LayoutDoc, PaneBinding, PaneProps } from "./types";

afterEach(cleanup);

const mounts: Record<string, number> = {};
function Probe({ paneId }: PaneProps<{ n: number }>) {
  useEffect(() => {
    mounts[paneId] = (mounts[paneId] ?? 0) + 1;
  }, [paneId]);
  return <input aria-label={`in-${paneId}`} />;
}

const registry = new Registry().register({
  id: "probe",
  displayName: "探针",
  group: "主机" as const,
  code: "PB",
  tabbed: false,
  follow: "host" as const,
  component: Probe,
  defaultConfig: () => ({ n: 0 }),
  configVersion: 2,
  migrateConfig: (old: unknown, from) => {
    if (from === 1) return { n: (old as { n: number }).n };
    throw new Error("cannot migrate");
  },
});

const entry = () =>
  registry.newEntry("probe") as NonNullable<ReturnType<Registry["newEntry"]>>;

function twoPanes(): LayoutDoc {
  let d = defaultDoc();
  const w = d.activeWindowId;
  d = addPane(d, w, "a", entry());
  d = addPane(d, w, "b", entry(), { target: "a", dir: "h" });
  return d;
}

const view = (doc: LayoutDoc, focused: string | null = "a") => (
  <PaneLayer
    doc={doc}
    registry={registry}
    focusedPaneId={focused}
    onFocus={() => {}}
    onConfig={() => {}}
  />
);

test("R3 分割、调整尺寸、跨 window 移动、切换 window：pane 都不重挂载，输入框内容保留", () => {
  for (const k of Object.keys(mounts)) delete mounts[k];
  let d = twoPanes();
  const { rerender, getByLabelText } = render(view(d));
  const input = getByLabelText("in-a") as HTMLInputElement;
  input.value = "半截输入";
  const node = input;

  const w1 = d.activeWindowId;
  const w1Tree = d.windows[0]?.tree;
  if (!w1Tree) throw new Error("tree");
  d = setTree(d, w1, resize(w1Tree, [], 0, 0.1));
  rerender(view(d));
  d = addPane(d, w1, "c", entry(), { target: "b", dir: "v" });
  rerender(view(d));

  d = addWindow(d);
  const w2 = d.activeWindowId;
  rerender(view(d));
  d = movePane(d, "a", w2);
  rerender(view(d));
  d = { ...d, activeWindowId: w1 };
  rerender(view(d));
  d = { ...d, activeWindowId: w2 };
  rerender(view(d));

  expect(getByLabelText("in-a")).toBe(node);
  expect((getByLabelText("in-a") as HTMLInputElement).value).toBe("半截输入");
  expect(mounts).toEqual({ a: 1, b: 1, c: 1 });
});

test("R3 非活动 window 的 pane 保持挂载，visibility 隐藏且 inert，不用 display:none", () => {
  let d = twoPanes();
  d = addWindow(d);
  const { container } = render(view(d));
  const a = container.querySelector('[data-pane-id="a"]') as HTMLElement;
  expect(a).toBeTruthy();
  expect(a.style.visibility).toBe("hidden");
  expect(a.hasAttribute("inert")).toBe(true);
  expect(a.style.display).not.toBe("none");
});

test("R3 变异检验：把 pane 放进按 window 分组的容器会触发重挂载（计数增加）", () => {
  for (const k of Object.keys(mounts)) delete mounts[k];
  const d = twoPanes();
  const moved = addWindow(d);
  const w2 = moved.activeWindowId;
  const after = movePane(moved, "a", w2);
  const FOLLOW: PaneBinding = { mode: "follow" };
  const grouped = (doc: LayoutDoc) => (
    <div>
      {doc.windows.map((w) => (
        <div key={w.id}>
          {paneIds(w.tree).map((id) => (
            <Probe
              key={id}
              paneId={id}
              config={{ n: 0 }}
              focused={false}
              binding={FOLLOW}
              onUpdateConfig={() => {}}
            />
          ))}
        </div>
      ))}
    </div>
  );
  const { rerender } = render(grouped(moved));
  rerender(grouped(after));
  expect(mounts.a).toBe(2);
});

test("R9 未知类型与高版本配置：渲染占位，条目原样保留", () => {
  let d = defaultDoc();
  d = {
    ...d,
    panes: {
      x: { type: "from_the_future", configVersion: 7, config: { k: [1, 2] } },
      y: { type: "probe", configVersion: 9, config: { z: 1 } },
      z: { type: "probe", configVersion: 0, config: { n: 1 } },
    },
    windows: [
      {
        ...(d.windows[0] as LayoutDoc["windows"][number]),
        tree: split(
          split({ kind: "leaf", paneId: "x" }, "x", "h", "y"),
          "y",
          "h",
          "z",
        ),
      },
    ],
  };
  const before = structuredClone(d.panes);
  const { container } = render(view(d, null));
  const labels = [...container.querySelectorAll("section")].map((s) =>
    s.getAttribute("aria-label"),
  );
  expect(labels).toEqual(["未知 pane", "未知 pane", "未知 pane"]);
  expect(normalize(d).doc.panes).toEqual(before);
});

test("R9 配置版本较低且有迁移函数：迁移后渲染", () => {
  const d = defaultDoc();
  const doc: LayoutDoc = {
    ...d,
    panes: { m: { type: "probe", configVersion: 1, config: { n: 5 } } },
    windows: [
      {
        ...(d.windows[0] as LayoutDoc["windows"][number]),
        tree: { kind: "leaf", paneId: "m" },
      },
    ],
  };
  const { getByLabelText } = render(view(doc, null));
  expect(getByLabelText("in-m")).toBeTruthy();
});

test("R9 迁移函数抛错：按未知类型渲染占位，条目不丢", () => {
  const d = defaultDoc();
  const bad = { type: "probe", configVersion: 0, config: { n: 5 } };
  const doc: LayoutDoc = {
    ...d,
    panes: { m: bad },
    windows: [
      {
        ...(d.windows[0] as LayoutDoc["windows"][number]),
        tree: { kind: "leaf", paneId: "m" },
      },
    ],
  };
  const { container } = render(view(doc, null));
  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(
    "未知 pane",
  );
  expect(normalize(doc).doc.panes.m).toEqual(bad);
});

test("R8 新增类型只改注册表，布局代码不动", () => {
  const r = new Registry().register({
    id: "extra",
    displayName: "额外",
    group: "协作" as const,
    code: "EX",
    tabbed: false,
    follow: "none" as const,
    component: () => <p>额外内容</p>,
    defaultConfig: () => ({}),
    configVersion: 1,
  });
  const d = addPane(
    defaultDoc(),
    defaultDoc().activeWindowId,
    "q",
    r.newEntry("extra") as never,
  );
  expect(Object.keys(d.panes)).toEqual(["q"]);
});

test("R1 至少保留一个 window；关闭 window 时其 pane 条目一并删除", () => {
  let d = twoPanes();
  expect(closeWindow(d, d.activeWindowId)).toBe(d);
  const first = d.activeWindowId;
  d = addWindow(d);
  const closed = closeWindow(d, first);
  expect(closed.windows).toHaveLength(1);
  expect(closed.panes).toEqual({});
});

test("R22 套用已存布局：所有 pane 分配新 id，配置（会话绑定）保留", () => {
  const src = twoPanes();
  const chatCfg = { type: "probe", configVersion: 2, config: { n: 42 } };
  src.panes.a = chatCfg;
  const w = src.windows[0] as LayoutDoc["windows"][number];
  const d = instantiate(defaultDoc(), {
    name: "存",
    tree: w.tree,
    panes: src.panes,
  });
  const created = d.windows.at(-1) as LayoutDoc["windows"][number];
  const ids = paneIds(created.tree);
  expect(ids).toHaveLength(2);
  expect(ids).not.toContain("a");
  expect(d.panes[ids[0] as string]).toEqual(chatCfg);
  expect(d.panes[ids[0] as string]).not.toBe(chatCfg);
});

test("R16 读入时比例不合法按等分修复并报告", () => {
  const d = twoPanes();
  const w = d.windows[0] as LayoutDoc["windows"][number];
  if (!w.tree || w.tree.kind !== "split") throw new Error("split");
  const bad = setTree(d, w.id, { ...w.tree, ratios: [0.9, 0.9] });
  const n = normalize(bad);
  expect(n.repaired).toBe(true);
  const t = n.doc.windows[0]?.tree;
  expect(t && t.kind === "split" && t.ratios).toEqual([0.5, 0.5]);
});

test("R9 迁移后的配置写回时带上新配置版本，不会再按旧版本迁移一遍", () => {
  const d = defaultDoc();
  const doc: LayoutDoc = {
    ...d,
    panes: { m: { type: "probe", configVersion: 1, config: { n: 5 } } },
    windows: [
      {
        ...(d.windows[0] as LayoutDoc["windows"][number]),
        tree: { kind: "leaf", paneId: "m" },
      },
    ],
  };
  const resolved = registry.resolve(doc.panes.m as never);
  expect(resolved?.configVersion).toBe(2);
  const next = setPaneConfig(doc, "m", { n: 6 }, resolved?.configVersion);
  expect(next.panes.m?.configVersion).toBe(2);
  expect(setPaneConfig(doc, "m", { n: 6 }).panes.m?.configVersion).toBe(1);
});
