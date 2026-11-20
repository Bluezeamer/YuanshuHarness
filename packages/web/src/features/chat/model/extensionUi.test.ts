import { expect, test } from "vitest";
import { TOAST_MAX, toastOf } from "./extensionUi";

test("notify：类型对应到 toast 的语气，缺省是 info", () => {
  expect(
    toastOf({ method: "notify", message: "好了", notifyType: "info" }),
  ).toEqual({
    message: "好了",
    tone: "info",
  });
  expect(
    toastOf({ method: "notify", message: "注意", notifyType: "warning" })?.tone,
  ).toBe("warn");
  expect(
    toastOf({ method: "notify", message: "坏了", notifyType: "error" })?.tone,
  ).toBe("danger");
  expect(toastOf({ method: "notify", message: "没写类型" })?.tone).toBe("info");
  expect(
    toastOf({ method: "notify", message: "没见过", notifyType: "weird" })?.tone,
  ).toBe("info");
});

test("没有正文的通知不弹；首尾空白去掉", () => {
  expect(toastOf({ method: "notify", message: "   " })).toBeNull();
  expect(toastOf({ method: "notify" })).toBeNull();
  expect(toastOf({ method: "notify", message: 3 })).toBeNull();
  expect(toastOf({ method: "notify", message: "  好 " })?.message).toBe("好");
});

test("太长的通知截断并加省略号", () => {
  const long = "x".repeat(TOAST_MAX + 50);
  const t = toastOf({ method: "notify", message: long });
  expect(t?.message.length).toBe(TOAST_MAX + 1);
  expect(t?.message.endsWith("…")).toBe(true);
  // 刚好等于上限不动
  expect(
    toastOf({ method: "notify", message: "y".repeat(TOAST_MAX) })?.message,
  ).toBe("y".repeat(TOAST_MAX));
});

test("只接 notify：状态条、小组件、标题、输入框预填这一批先丢弃", () => {
  expect(
    toastOf({ method: "setStatus", statusKey: "k", statusText: "忙" }),
  ).toBeNull();
  expect(
    toastOf({ method: "setWidget", widgetKey: "k", widgetLines: ["a"] }),
  ).toBeNull();
  expect(toastOf({ method: "setTitle", title: "t" })).toBeNull();
  expect(toastOf({ method: "set_editor_text", text: "t" })).toBeNull();
  expect(toastOf({})).toBeNull();
});
