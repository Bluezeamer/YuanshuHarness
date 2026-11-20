import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Card } from "./Card";
import { InlineNotice } from "./InlineNotice";
import { ListRow } from "./ListRow";
import { SummaryRow } from "./SummaryRow";
import { TabStrip } from "./TabStrip";

afterEach(cleanup);

test("Card：给了 onOpen 标题就是按钮；没给就是纯文字，操作区照常渲染", () => {
  const onOpen = vi.fn();
  const { rerender } = render(
    <Card
      title="coder-full"
      description="完整的编码代理"
      meta="14 项能力"
      actions={<button type="button">复制</button>}
      onOpen={onOpen}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "coder-full" }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
  expect(screen.getByText("14 项能力")).toBeTruthy();

  rerender(<Card title="coder-full" />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("coder-full")).toBeTruthy();
});

test("ListRow：单击、双击各走各的回调；current 写 aria-current，有副标题时标记两行", () => {
  const onClick = vi.fn();
  const onDoubleClick = vi.fn();
  const { container } = render(
    <ListRow
      label="修复登录态"
      sub="待命"
      current
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      actions={<button type="button">更多</button>}
    />,
  );
  const main = screen.getByRole("button", { name: /修复登录态/ });
  fireEvent.click(main);
  fireEvent.doubleClick(main);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onDoubleClick).toHaveBeenCalledTimes(1);
  expect(main.getAttribute("aria-current")).toBe("true");
  const row = container.firstElementChild as HTMLElement;
  expect(row.dataset.sub).toBe("true");
  expect(row.dataset.actions).toBe("true");
  expect(screen.getByRole("button", { name: "更多" })).toBeTruthy();
});

test("ListRow：title 落在主按钮上，没给就没有", () => {
  const { rerender } = render(
    <ListRow label="很长很长的会话标题" title="完整标题" />,
  );
  expect(screen.getByRole("button").getAttribute("title")).toBe("完整标题");
  rerender(<ListRow label="很长很长的会话标题" />);
  expect(screen.getByRole("button").hasAttribute("title")).toBe(false);
});

test("SummaryRow：点整行展开；只有传了 onReset 才有「恢复跟随」", () => {
  const onOpen = vi.fn();
  const onReset = vi.fn();
  const { rerender } = render(
    <SummaryRow
      label="模型"
      value="Qwen3.8-27B"
      note="跟随默认"
      onOpen={onOpen}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /模型/ }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(screen.getByText("· 跟随默认")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "恢复跟随" })).toBeNull();

  rerender(
    <SummaryRow
      label="模型"
      value="Qwen3.8-27B"
      onOpen={onOpen}
      onReset={onReset}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "恢复跟随" }));
  expect(onReset).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("InlineNotice：提示是 status，警告与错误是 alert", () => {
  const { rerender } = render(<InlineNotice>已保存</InlineNotice>);
  expect(screen.getByRole("status").textContent).toBe("已保存");
  rerender(
    <InlineNotice tone="danger" strong>
      名称已被使用
    </InlineNotice>,
  );
  const alert = screen.getByRole("alert");
  expect(alert.dataset.tone).toBe("danger");
  expect(alert.dataset.strong).toBe("true");
});

test("TabStrip：标题带完整 title 提示，临时标签打标，关闭键只给可关闭的，双击固定", () => {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const onPin = vi.fn();
  const { container } = render(
    <TabStrip
      aria-label="标签"
      value="a"
      onChange={onChange}
      onClose={onClose}
      onPin={onPin}
      tabs={[
        { id: "a", title: "一个很长很长很长的会话标题" },
        { id: "b", title: "临时预览", temp: true },
        { id: "c", title: "终端", closable: false },
      ]}
    />,
  );
  const tabs = screen.getAllByRole("tab");
  expect(tabs).toHaveLength(3);
  expect(tabs[0]?.getAttribute("title")).toBe("一个很长很长很长的会话标题");
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  expect(container.querySelectorAll("[data-temp]")).toHaveLength(1);
  // 关闭键：a、b 有，c 没有
  expect(screen.getAllByRole("button", { name: /^关闭 / })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "关闭 临时预览" }));
  expect(onClose).toHaveBeenCalledWith("b");
  fireEvent.click(tabs[1] as HTMLElement);
  expect(onChange).toHaveBeenCalledWith("b");
  fireEvent.doubleClick(tabs[1] as HTMLElement);
  expect(onPin).toHaveBeenCalledWith("b");
});
