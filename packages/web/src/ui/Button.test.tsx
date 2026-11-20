import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Button, IconButton } from "./Button";
import { CloseIcon } from "./icons";

afterEach(cleanup);

test("Button 默认 type=button，点击触发回调并透传 data-testid", () => {
  const onClick = vi.fn();
  render(
    <Button onClick={onClick} data-testid="b">
      保存
    </Button>,
  );
  const b = screen.getByTestId("b");
  expect(b.getAttribute("type")).toBe("button");
  fireEvent.click(b);
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("Button disabled 不触发点击，variant 与 size 写入 data 属性", () => {
  const onClick = vi.fn();
  render(
    <Button variant="primary" size="sm" disabled onClick={onClick}>
      提交
    </Button>,
  );
  const b = screen.getByRole("button", { name: "提交" });
  expect(b.getAttribute("data-variant")).toBe("primary");
  expect(b.getAttribute("data-size")).toBe("sm");
  fireEvent.click(b);
  expect(onClick).not.toHaveBeenCalled();
});

test("Button loading 视为禁用并标记 aria-busy", () => {
  const onClick = vi.fn();
  render(
    <Button loading onClick={onClick}>
      测试连接
    </Button>,
  );
  const b = screen.getByRole("button", {
    name: "测试连接",
  }) as HTMLButtonElement;
  expect(b.disabled).toBe(true);
  expect(b.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(b);
  expect(onClick).not.toHaveBeenCalled();
});

test("IconButton 以 label 作为可访问名，pressed 写入 aria-pressed", () => {
  const onClick = vi.fn();
  render(
    <IconButton
      label="关闭设置"
      icon={<CloseIcon />}
      pressed
      onClick={onClick}
    />,
  );
  const b = screen.getByRole("button", { name: "关闭设置" });
  expect(b.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(b);
  expect(onClick).toHaveBeenCalledTimes(1);
});
