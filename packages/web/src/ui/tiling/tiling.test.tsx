import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PaneFrame } from "./PaneFrame";
import { resizePair, TilingLayout } from "./TilingLayout";
import type { Tree } from "./tree";
import { WindowBar } from "./WindowBar";

afterEach(cleanup);

interface Leaf {
  k: string;
}
const tree: Tree<Leaf> = {
  dir: "row",
  sizes: [1, 1],
  children: [
    { k: "a" },
    { dir: "col", sizes: [1, 1], children: [{ k: "b" }, { k: "c" }] },
  ],
};

test("resizePair：只改相邻两格，总和不变，夹在 2%–98%", () => {
  expect(resizePair([1, 1, 2], 0, 300, 400)).toEqual([1.5, 0.5, 2]);
  const lo = resizePair([1, 1], 0, -50, 400);
  expect(lo[0]).toBeCloseTo(0.04);
  expect((lo[0] ?? 0) + (lo[1] ?? 0)).toBeCloseTo(2);
  expect(resizePair([1], 0, 10, 100)).toEqual([1]);
});

test("TilingLayout：每个叶子渲染一次，分支之间有分隔条，叶子格带 data-leaf", () => {
  render(
    <TilingLayout
      node={tree}
      handleLabel="调整大小"
      onSizes={() => {}}
      renderLeaf={(l) => <div data-testid="leaf">{l.k}</div>}
    />,
  );
  expect(screen.getAllByTestId("leaf").map((e) => e.textContent)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(screen.getAllByRole("separator", { name: "调整大小" })).toHaveLength(
    2,
  );
  const cells = document.querySelectorAll(".u-tile-cell");
  expect([...cells].filter((c) => c.hasAttribute("data-leaf"))).toHaveLength(3);
});

test("PaneFrame：头、内容与六个落点；亮的落点由 zone 决定，不可用的换文案", () => {
  render(
    <PaneFrame
      head={<div>头</div>}
      zone="center"
      blocked={(z) => z === "center"}
      zoneLabel={(z) => `放到 ${z}`}
      blockedLabel="不可并入"
    >
      <div>内容</div>
    </PaneFrame>,
  );
  const frame = document.querySelector(".u-pane") as HTMLElement;
  expect(frame.dataset.dz).toBe("center");
  expect(screen.getByText("头")).toBeTruthy();
  expect(screen.getByText("内容")).toBeTruthy();
  const zones = [...document.querySelectorAll<HTMLElement>(".u-dz")];
  expect(zones.map((z) => z.dataset.z)).toEqual([
    "left",
    "right",
    "top",
    "bottom",
    "center",
    "strip",
  ]);
  expect(zones.find((z) => z.dataset.z === "center")?.textContent).toBe(
    "不可并入",
  );
  expect(zones.find((z) => z.dataset.z === "left")?.textContent).toBe(
    "放到 left",
  );
});

function bar(over: Partial<Parameters<typeof WindowBar>[0]> = {}) {
  const fn = {
    onSwitch: vi.fn(),
    onAdd: vi.fn(),
    onClose: vi.fn(),
    onDropTo: vi.fn(),
  };
  render(
    <WindowBar
      aria-label="窗口"
      addLabel="新建窗口"
      labels={["窗口 1", "窗口 2"]}
      active={0}
      {...fn}
      {...over}
    />,
  );
  return fn;
}

test("WindowBar：点击切换、新增、关闭；←/→ 循环切换", () => {
  const fn = bar();
  fireEvent.click(screen.getByRole("tab", { name: "窗口 2" }));
  expect(fn.onSwitch).toHaveBeenLastCalledWith(1);
  fireEvent.click(screen.getByRole("button", { name: "新建窗口" }));
  expect(fn.onAdd).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭窗口 2" }));
  expect(fn.onClose).toHaveBeenCalledWith(1);
  fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" });
  expect(fn.onSwitch).toHaveBeenLastCalledWith(1);
});

test("WindowBar：没给 onClose 就没有 ×；可放时胶囊是落点，不可放时不接", () => {
  const fn = bar({ onClose: undefined, droppable: false });
  expect(screen.queryByRole("button", { name: /^关闭/ })).toBeNull();
  const chip = document.querySelectorAll(".u-wbar-tab")[1] as HTMLElement;
  const over = fireEvent.dragOver(chip);
  expect(over).toBe(true);
  fireEvent.drop(chip);
  expect(fn.onDropTo).not.toHaveBeenCalled();
});

test("WindowBar：可放时 dragover 高亮胶囊（取消默认），drop 回调下标", () => {
  const fn = bar({ droppable: true, hint: "拖到窗口标签上" });
  const chip = document.querySelectorAll(".u-wbar-tab")[1] as HTMLElement;
  expect(fireEvent.dragOver(chip, { dataTransfer: { dropEffect: "" } })).toBe(
    false,
  );
  expect(chip.hasAttribute("data-drop")).toBe(true);
  fireEvent.drop(chip);
  expect(fn.onDropTo).toHaveBeenCalledWith(1);
  expect(chip.hasAttribute("data-drop")).toBe(false);
  expect(screen.getByText("拖到窗口标签上")).toBeTruthy();
});
