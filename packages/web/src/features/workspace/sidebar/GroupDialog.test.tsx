import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { GroupDialog } from "./GroupDialog";

afterEach(cleanup);

const mount = (onSubmit = vi.fn()) => {
  render(
    <GroupDialog
      spec={{ name: "主线", tone: 1, onSubmit }}
      onClose={() => {}}
    />,
  );
  return onSubmit;
};

test("带当前名称与颜色；改名换色后提交，名称去掉首尾空白", () => {
  const onSubmit = mount();
  expect(
    screen.getByRole("button", { name: "颜色 1" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.change(screen.getByLabelText("分组名称"), {
    target: { value: "  主干 " },
  });
  fireEvent.click(screen.getByRole("button", { name: "颜色 5" }));
  expect(
    screen.getByRole("button", { name: "颜色 1" }).getAttribute("aria-pressed"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(onSubmit).toHaveBeenCalledWith("主干", 5);
});

test("可以选「无色」；名称为空不能提交，回车也不行", () => {
  const onSubmit = mount();
  fireEvent.click(screen.getByRole("button", { name: "无色" }));
  fireEvent.change(screen.getByLabelText("分组名称"), {
    target: { value: "  " },
  });
  expect(
    (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.keyDown(screen.getByLabelText("分组名称"), { key: "Enter" });
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("分组名称"), {
    target: { value: "新名" },
  });
  fireEvent.keyDown(screen.getByLabelText("分组名称"), { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledWith("新名", 0);
});
