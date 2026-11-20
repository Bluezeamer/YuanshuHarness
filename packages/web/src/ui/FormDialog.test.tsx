import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FormDialog } from "./FormDialog";

afterEach(cleanup);

const mount = (over: Partial<Parameters<typeof FormDialog>[0]> = {}) => {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <FormDialog
      open
      title="新建卡片"
      onSubmit={onSubmit}
      onClose={onClose}
      {...over}
    >
      <input aria-label="名称" />
    </FormDialog>,
  );
  return { onSubmit, onClose };
};

test("主按钮提交，回车也提交；取消只关闭不提交", () => {
  const { onSubmit, onClose } = mount({ confirmLabel: "新建" });
  fireEvent.click(screen.getByRole("button", { name: "新建" }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  fireEvent.submit(screen.getByLabelText("名称"));
  expect(onSubmit).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

test("没填完（canSubmit 为 false）或提交中：主按钮不可点，回车也不提交", () => {
  const { onSubmit } = mount({ canSubmit: false });
  expect(
    (screen.getByRole("button", { name: "确定" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.submit(screen.getByLabelText("名称"));
  expect(onSubmit).not.toHaveBeenCalled();
  cleanup();
  const busy = mount({ busy: true });
  fireEvent.submit(screen.getByLabelText("名称"));
  expect(busy.onSubmit).not.toHaveBeenCalled();
});

test("只读：没有主按钮，取消改叫关闭，回车不提交", () => {
  const { onSubmit } = mount({ readOnly: true });
  expect(screen.queryByRole("button", { name: "确定" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "关闭" }).length).toBe(2);
  fireEvent.submit(screen.getByLabelText("名称"));
  expect(onSubmit).not.toHaveBeenCalled();
});

test("失败文案留在弹窗里；页脚左侧可放次要操作；点遮罩不关闭", () => {
  const { onClose } = mount({
    error: "保存失败，请稍后重试",
    aside: <button type="button">复制一份</button>,
  });
  expect(screen.getByText("保存失败，请稍后重试")).toBeTruthy();
  expect(screen.getByRole("button", { name: "复制一份" })).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
  expect(onClose).not.toHaveBeenCalled();
});
