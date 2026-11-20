import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Field, SettingRow } from "./Field";
import { Input, SearchBox, Textarea } from "./Inputs";
import { Segmented } from "./Segmented";
import { Select } from "./Select";

afterEach(cleanup);

test("Field 函数形态：label 与 Input 关联，error 接入 aria-describedby 与 aria-invalid", () => {
  render(
    <Field label="基础 URL" hint="含 /v1" error="格式不对">
      {(c) => <Input {...c} />}
    </Field>,
  );
  const input = screen.getByLabelText("基础 URL");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const described = input.getAttribute("aria-describedby") ?? "";
  expect(described.split(" ")).toHaveLength(2);
  expect(screen.getByRole("alert").textContent).toBe("格式不对");
  expect(
    document.getElementById(described.split(" ")[0] ?? "")?.textContent,
  ).toBe("含 /v1");
});

test("Field 无错误时不带 aria-invalid，复合控件按 group 命名", () => {
  render(
    <Field label="方向">
      <Segmented
        aria-label="方向选项"
        options={[{ value: "x", label: "X" }]}
        value="x"
        onChange={() => {}}
      />
    </Field>,
  );
  expect(screen.getByRole("group", { name: "方向" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("SettingRow 标签列与说明渲染，控件通过 label 可达", () => {
  render(
    <SettingRow label="模型 id" description="provider/model 形式">
      {(c) => <Input {...c} defaultValue="gpt" />}
    </SettingRow>,
  );
  expect((screen.getByLabelText("模型 id") as HTMLInputElement).value).toBe(
    "gpt",
  );
  expect(screen.getByText("provider/model 形式")).toBeTruthy();
});

test("SettingRow 传节点时控件列按标签命名为 group", () => {
  render(
    <SettingRow label="协议兼容">
      <span>内容</span>
    </SettingRow>,
  );
  expect(screen.getByRole("group", { name: "协议兼容" })).toBeTruthy();
});

test("Input / Textarea 透传原生属性", () => {
  render(
    <>
      <Input aria-label="名称" mono placeholder="p" data-testid="i" />
      <Textarea aria-label="备注" defaultValue="x" />
    </>,
  );
  expect(screen.getByTestId("i").classList.contains("t-mono")).toBe(true);
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe(
    "x",
  );
});

test("Select：触发器显示当前项，点开选另一项才回调，选同一项不回调", () => {
  const onChange = vi.fn();
  render(
    <Select
      aria-label="格式"
      value="b"
      options={[
        { value: "a", label: "A", hint: "默认" },
        { value: "b", label: "B" },
        { value: "c", label: "C", disabled: true },
      ]}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "格式" });
  expect(trigger.textContent).toBe("B");
  fireEvent.click(trigger);
  expect(
    screen.getByRole("option", { name: "B" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    (screen.getByRole("option", { name: "C" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("option", { name: "B" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: /A/ }));
  expect(onChange).toHaveBeenCalledWith("a");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("Select：方向键打开并移动，回车选中", () => {
  const onChange = vi.fn();
  render(
    <Select
      aria-label="格式"
      value="a"
      options={[
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ]}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "格式" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const a = screen.getByRole("option", { name: "A" });
  expect(document.activeElement).toBe(a);
  fireEvent.keyDown(a, { key: "ArrowDown" });
  const b = screen.getByRole("option", { name: "B" });
  expect(document.activeElement).toBe(b);
  fireEvent.click(b);
  expect(onChange).toHaveBeenCalledWith("b");
});

const Search = () => {
  const [v, setV] = useState("abc");
  return <SearchBox aria-label="筛选" value={v} onChange={setV} />;
};

test("SearchBox 有内容时出现 ×，点击清空并把焦点还给输入框", () => {
  render(<Search />);
  const input = screen.getByLabelText("筛选") as HTMLInputElement;
  fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
});

test("SearchBox 有内容时 Esc 只清空且不外泄；空内容时 Esc 放行", () => {
  // 用 document 监听模拟外层弹层的 Esc 处理
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  render(<Search />);
  const input = screen.getByLabelText("筛选") as HTMLInputElement;
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("");
  expect(outer).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(outer).toHaveBeenCalledTimes(1);
  document.removeEventListener("keydown", outer);
});
