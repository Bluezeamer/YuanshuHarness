import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LoginDialog } from "./LoginDialog";
import { builtin, type FakeApi, fakeApi, loginState, reply } from "./testkit";

let api: FakeApi;
const onClose = vi.fn();
const onDone = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  onClose.mockReset();
  onDone.mockReset();
  api = fakeApi([builtin("anthropic", { method: "oauth" })]);
  vi.stubGlobal("fetch", api.fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const open = async () => {
  render(
    <LoginDialog
      id="anthropic"
      name="Anthropic"
      onClose={onClose}
      onDone={onDone}
    />,
  );
  await flush();
};
const calls = (suffix: string) =>
  api.calls.filter((c) => c.path.endsWith(suffix));

const paste = loginState({
  link: {
    url: "https://auth.example/authorize?x=1",
    instructions: "用浏览器打开",
  },
  prompt: { id: "p1", type: "manual_code", message: "把授权码粘贴到这里" },
});

test("授权码流程：摆出授权链接和输入框，提交后回答服务端提示，轮询到完成就收尾", async () => {
  api.setLogin([
    paste,
    loginState({ message: "正在换取令牌" }),
    loginState({ status: "done" }),
  ]);
  await open();
  expect(screen.getByText("https://auth.example/authorize?x=1")).toBeTruthy();
  expect(screen.getByText("用浏览器打开")).toBeTruthy();
  const done = screen.getByRole("button", {
    name: "完成登录",
  }) as HTMLButtonElement;
  expect(done.disabled).toBe(true);
  fireEvent.change(
    screen.getByRole("textbox", { name: "把授权码粘贴到这里" }),
    {
      target: { value: " code-123 " },
    },
  );
  fireEvent.click(done);
  await flush();
  expect(api.answers).toEqual([{ promptId: "p1", value: "code-123" }]);
  await flush(1000);
  expect(onDone).not.toHaveBeenCalled();
  await flush(1000);
  expect(onDone).toHaveBeenCalledTimes(1);
  // 走完了就不再轮询，也不发取消
  await flush(5000);
  expect(calls("/L1").filter((c) => c.method === "GET").length).toBe(2);
  expect(api.cancelled).toEqual([]);
});

test("设备码流程：显示设备码和网址，不要输入框，授权完自动结束", async () => {
  api.setLogin([
    loginState({
      device: {
        userCode: "WDJB-MJHT",
        verificationUri: "https://example.com/device",
      },
    }),
    loginState({ status: "done" }),
  ]);
  await open();
  expect(screen.getByText("WDJB-MJHT")).toBeTruthy();
  expect(screen.getByText("https://example.com/device")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText(/等待你在网页上完成授权/)).toBeTruthy();
  await flush(1000);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("选项提示：点哪个就回答哪个的 id", async () => {
  api.setLogin([
    loginState({
      prompt: {
        id: "p9",
        type: "select",
        message: "选一个账号类型",
        options: [
          { id: "pro", label: "Pro" },
          { id: "team", label: "Team" },
        ],
      },
    }),
  ]);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Team" }));
  await flush();
  expect(api.answers).toEqual([{ promptId: "p9", value: "team" }]);
});

test("登录失败：显示服务端给的原因，不算完成；关闭不再发取消", async () => {
  api.setLogin([
    paste,
    loginState({ status: "failed", error: "授权码无效或已过期" }),
  ]);
  await open();
  await flush(1000);
  expect(screen.getByText("授权码无效或已过期")).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getAllByRole("button", { name: "关闭" }).pop() as HTMLElement,
  );
  expect(onClose).toHaveBeenCalled();
  cleanup();
  expect(api.cancelled).toEqual([]);
});

test("没走完就关掉：告诉服务端取消，免得一直挂着", async () => {
  api.setLogin([paste]);
  await open();
  cleanup();
  await flush();
  expect(api.cancelled).toEqual(["anthropic"]);
});

test("发起失败：显示原因，不会一直转圈", async () => {
  api.on("POST /api/v1/providers/anthropic/login", () =>
    reply(400, { error: "oauth_unsupported" }),
  );
  await open();
  expect(screen.getByText(/不支持订阅登录/)).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

test("回答被服务端拒绝：提示留在弹窗里，可以重填", async () => {
  api.setLogin([paste]);
  api.on("POST /api/v1/providers/anthropic/login/L1/answer", () =>
    reply(404, { error: "not_found" }),
  );
  await open();
  fireEvent.change(
    screen.getByRole("textbox", { name: "把授权码粘贴到这里" }),
    {
      target: { value: "x" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "完成登录" }));
  await flush();
  expect(
    screen.getByRole("textbox", { name: "把授权码粘贴到这里" }),
  ).toBeTruthy();
  expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
});
