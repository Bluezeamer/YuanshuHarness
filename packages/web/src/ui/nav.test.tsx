import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConfirmButton } from "./ConfirmButton";
import { SplitHandle } from "./SplitHandle";
import { DetailRow, Table, Td, Th } from "./Table";
import { TabPanel, Tabs } from "./Tabs";
import { clearToasts, ToastHost, toast } from "./Toast";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.useRealTimers();
});

const TABS = [
  { id: "a", label: "连接", count: 2 },
  { id: "b", label: "模型" },
  { id: "c", label: "外观" },
];

function TabsHost() {
  const [v, setV] = useState("a");
  return (
    <>
      <Tabs
        aria-label="设置"
        idBase="s"
        tabs={TABS}
        value={v}
        onChange={setV}
      />
      {TABS.map((t) => (
        <TabPanel key={t.id} idBase="s" id={t.id} value={v}>
          面板-{t.id}
        </TabPanel>
      ))}
    </>
  );
}

test("Tabs 暴露 tablist/tab/tabpanel 关联，只有选中项在 Tab 序列里", () => {
  render(<TabsHost />);
  expect(screen.getByRole("tablist", { name: "设置" })).toBeTruthy();
  const [a, b] = screen.getAllByRole("tab");
  expect(a?.getAttribute("aria-selected")).toBe("true");
  expect(a?.getAttribute("tabindex")).toBe("0");
  expect(b?.getAttribute("tabindex")).toBe("-1");
  const panel = screen.getByRole("tabpanel", { name: /连接/ });
  expect(panel.id).toBe(a?.getAttribute("aria-controls"));
  expect(screen.queryByText("面板-b")).toBeNull();
});

test("Tabs 方向键循环切换并移动焦点，Home/End 跳到首尾", () => {
  render(<TabsHost />);
  const list = screen.getByRole("tablist");
  fireEvent.keyDown(list, { key: "ArrowRight" });
  const tabs = screen.getAllByRole("tab");
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[1]);
  fireEvent.keyDown(list, { key: "End" });
  expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(list, { key: "ArrowRight" });
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(list, { key: "ArrowLeft" });
  expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("面板-c")).toBeTruthy();
});

test("Tabs 点击切换面板", () => {
  render(<TabsHost />);
  fireEvent.click(screen.getByRole("tab", { name: "模型" }));
  expect(screen.getByText("面板-b")).toBeTruthy();
});

test("Table 渲染 caption、按百分比分列，DetailRow 横跨整行", () => {
  render(
    <Table caption="连接列表" widths={["40%", "60%"]}>
      <thead>
        <tr>
          <Th>名称</Th>
          <Th align="end">地址</Th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <Td truncate>a</Td>
          <Td align="end" mono>
            b
          </Td>
        </tr>
        <DetailRow colSpan={2}>展开内容</DetailRow>
      </tbody>
    </Table>,
  );
  expect(screen.getByRole("table", { name: "连接列表" })).toBeTruthy();
  expect(
    screen.getByRole("columnheader", { name: "名称" }).getAttribute("scope"),
  ).toBe("col");
  const cols = document.querySelectorAll("col");
  expect((cols[0] as HTMLElement).style.width).toBe("40%");
  expect((cols[1] as HTMLElement).style.width).toBe("60%");
  expect(screen.getByText("展开内容").getAttribute("colspan")).toBe("2");
});

beforeEach(() => {
  vi.useFakeTimers();
});

test("ConfirmButton 第一次点击上膛并改文案，第二次才执行", () => {
  const onConfirm = vi.fn();
  render(<ConfirmButton onConfirm={onConfirm}>删除</ConfirmButton>);
  const b = screen.getByRole("button", { name: "删除" });
  fireEvent.click(b);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(b.getAttribute("data-armed")).toBe("true");
  expect(b.textContent).toBe("确认…");
  fireEvent.click(b);
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(b.getAttribute("data-armed")).toBeNull();
  expect(b.textContent).toBe("删除");
});

test("ConfirmButton 超时自动解除上膛，不执行", () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmButton onConfirm={onConfirm} timeoutMs={1000}>
      删除
    </ConfirmButton>,
  );
  fireEvent.click(screen.getByRole("button"));
  act(() => {
    vi.advanceTimersByTime(1001);
  });
  expect(screen.getByRole("button").textContent).toBe("删除");
  expect(onConfirm).not.toHaveBeenCalled();
});

test("ConfirmButton 上膛后 Esc 只解除且不冒泡", () => {
  const outer = vi.fn();
  render(
    // biome-ignore lint/a11y/noStaticElementInteractions: 测试用外层监听，模拟弹窗的 Esc 处理
    <div onKeyDown={outer}>
      <ConfirmButton onConfirm={() => {}}>删除</ConfirmButton>
    </div>,
  );
  const b = screen.getByRole("button");
  fireEvent.click(b);
  fireEvent.keyDown(b, { key: "Escape" });
  expect(b.textContent).toBe("删除");
  expect(outer).not.toHaveBeenCalled();
});

function Split({ reverse = false }: { reverse?: boolean }) {
  const [w, setW] = useState(200);
  return (
    <SplitHandle
      aria-label="调整宽度"
      value={w}
      onChange={setW}
      min={100}
      max={300}
      defaultValue={200}
      reverse={reverse}
    />
  );
}

test("SplitHandle 暴露 separator 语义与取值范围", () => {
  render(<Split />);
  const s = screen.getByRole("separator", { name: "调整宽度" });
  expect(s.getAttribute("aria-valuenow")).toBe("200");
  expect(s.getAttribute("aria-valuemin")).toBe("100");
  expect(s.getAttribute("aria-valuemax")).toBe("300");
  expect(s.getAttribute("aria-orientation")).toBe("vertical");
});

test("SplitHandle 方向键按步长调整并夹在范围内，Shift 为大步长，Home/End 到边界", () => {
  render(<Split />);
  const s = screen.getByRole("separator");
  fireEvent.keyDown(s, { key: "ArrowRight" });
  expect(s.getAttribute("aria-valuenow")).toBe("216");
  fireEvent.keyDown(s, { key: "ArrowLeft", shiftKey: true });
  expect(s.getAttribute("aria-valuenow")).toBe("168");
  fireEvent.keyDown(s, { key: "End" });
  expect(s.getAttribute("aria-valuenow")).toBe("300");
  fireEvent.keyDown(s, { key: "ArrowRight" });
  expect(s.getAttribute("aria-valuenow")).toBe("300");
  fireEvent.keyDown(s, { key: "Home" });
  expect(s.getAttribute("aria-valuenow")).toBe("100");
});

test("SplitHandle reverse 时方向键取反；双击复位到默认值", () => {
  render(<Split reverse />);
  const s = screen.getByRole("separator");
  fireEvent.keyDown(s, { key: "ArrowRight" });
  expect(s.getAttribute("aria-valuenow")).toBe("184");
  fireEvent.doubleClick(s);
  expect(s.getAttribute("aria-valuenow")).toBe("200");
});

test("SplitHandle 指针拖动按位移调整，松开后停止", () => {
  render(<Split />);
  const s = screen.getByRole("separator");
  fireEvent.pointerDown(s, { button: 0, clientX: 100, pointerId: 1 });
  expect(s.getAttribute("data-dragging")).toBe("true");
  fireEvent.pointerMove(s, { clientX: 130, pointerId: 1 });
  expect(s.getAttribute("aria-valuenow")).toBe("230");
  fireEvent.pointerMove(s, { clientX: 500, pointerId: 1 });
  expect(s.getAttribute("aria-valuenow")).toBe("300");
  fireEvent.pointerUp(s, { pointerId: 1 });
  expect(s.getAttribute("data-dragging")).toBeNull();
  fireEvent.pointerMove(s, { clientX: 0, pointerId: 1 });
  expect(s.getAttribute("aria-valuenow")).toBe("300");
});

test("Toast 在 ToastHost 中显示，danger 用 alert，到时自动消失", () => {
  render(<ToastHost />);
  act(() => {
    toast("已保存", { tone: "ok" });
    toast("连接失败", { tone: "danger" });
  });
  expect(screen.getByRole("status").textContent).toBe("已保存");
  expect(screen.getByRole("alert").textContent).toBe("连接失败");
  act(() => {
    vi.advanceTimersByTime(3300);
  });
  expect(screen.queryByText("已保存")).toBeNull();
  expect(screen.getByText("连接失败")).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(screen.queryByText("连接失败")).toBeNull();
});

test("Toast 带按钮且 durationMs 为 0 时不自动消失，点按钮先关掉再执行", () => {
  const view = vi.fn();
  const skip = vi.fn();
  render(<ToastHost />);
  act(() => {
    toast("agent 展示了一个页面", {
      durationMs: 0,
      actions: [
        { label: "查看", onClick: view },
        { label: "忽略", onClick: skip },
      ],
    });
  });
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByText("agent 展示了一个页面")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看" }));
  expect(view).toHaveBeenCalledTimes(1);
  expect(skip).not.toHaveBeenCalled();
  expect(screen.queryByText("agent 展示了一个页面")).toBeNull();
});
