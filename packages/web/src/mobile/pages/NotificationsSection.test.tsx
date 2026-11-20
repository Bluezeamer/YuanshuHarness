import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PushPrefs } from "../../api/push";
import type { PushState } from "../pwa/usePush";
import { NotificationsSection } from "./NotificationsSection";

afterEach(cleanup);

const prefs: PushPrefs = {
  blocked: true,
  error: true,
  done: false,
  policy: "unwatched",
  delaySec: 30,
};
const make = (state: PushState, busy = false) => {
  const push = {
    state,
    busy,
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    patch: vi.fn(async () => {}),
    test: vi.fn(async () => {}),
  };
  render(<NotificationsSection push={push} />);
  return push;
};

test("不能用时只说明原因，没有任何按钮", () => {
  for (const [why, text] of [
    ["insecure", "明文访问"],
    ["unsupported", "不支持"],
    ["ios-install", "添加到主屏幕"],
    ["global", "访问令牌登录的没有通知"],
  ] as const) {
    cleanup();
    make({ phase: "unavailable", why });
    expect(screen.getByText(new RegExp(text))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  }
});

test("没开：点「开启通知」才请求；权限被拒时按钮灰掉并说怎么办", () => {
  const push = make({ phase: "off", denied: false });
  fireEvent.click(screen.getByRole("button", { name: "开启通知" }));
  expect(push.enable).toHaveBeenCalledTimes(1);
  cleanup();
  const denied = make({ phase: "off", denied: true });
  expect(
    (screen.getByRole("button", { name: "开启通知" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/被拒绝/)).toBeTruthy();
  expect(denied.enable).not.toHaveBeenCalled();
});

test("开着：三个事件开关、策略分段各改各的字段；延迟档才出现延迟时长", () => {
  const push = make({ phase: "on", prefs });
  expect(
    screen
      .getByRole("switch", { name: "需要你处理时通知" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen
      .getByRole("switch", { name: "跑完时通知" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("switch", { name: "跑完时通知" }));
  expect(push.patch).toHaveBeenLastCalledWith({ done: true });
  fireEvent.click(screen.getByRole("switch", { name: "出错时通知" }));
  expect(push.patch).toHaveBeenLastCalledWith({ error: false });
  fireEvent.click(screen.getByRole("radio", { name: "总是" }));
  expect(push.patch).toHaveBeenLastCalledWith({ policy: "always" });
  expect(screen.queryByRole("radiogroup", { name: "延迟多久" })).toBeNull();
  cleanup();

  const d = make({
    phase: "on",
    prefs: { ...prefs, policy: "delay", delaySec: 30 },
  });
  fireEvent.click(screen.getByRole("radio", { name: "1 分钟" }));
  expect(d.patch).toHaveBeenLastCalledWith({ delaySec: 60 });
});

test("开着：测试通知、关闭通知；处理中全部禁用", () => {
  const push = make({ phase: "on", prefs });
  fireEvent.click(screen.getByRole("button", { name: "发一条测试通知" }));
  expect(push.test).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
  expect(push.disable).toHaveBeenCalledTimes(1);
  cleanup();
  make({ phase: "on", prefs }, true);
  expect(
    screen.getByRole("switch", { name: "跑完时通知" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "关闭通知" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
