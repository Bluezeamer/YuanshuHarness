// 手机设置页的退出：设备令牌要服务端真删掉才算退出；全局令牌退出也要清会话 Cookie；身份没读到之前不能点。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearToasts, ToastHost } from "../../ui";
import { NavProvider } from "../nav/NavProvider";
import { createNav } from "../nav/nav";
import { SettingsPage } from "./SettingsPage";

const api = vi.hoisted(() => ({
  whoami: vi.fn(),
  removeSelf: vi.fn(),
  closeSession: vi.fn(),
}));
vi.mock("../../api/devices", async (orig) => ({
  ...(await orig<typeof import("../../api/devices")>()),
  whoami: api.whoami,
  removeSelf: api.removeSelf,
}));
vi.mock("../../api/auth", () => ({ closeSession: api.closeSession }));
// 通知与安装两块有自己的测试，这里不去碰浏览器的推送接口
vi.mock("../pwa/usePush", () => ({
  usePush: () => ({
    state: { phase: "unavailable", why: "insecure" },
    busy: false,
  }),
}));

const device = {
  kind: "device",
  device: { id: "d1", name: "测试手机", createdAt: "t", lastUsedAt: null },
};

beforeEach(() => {
  sessionStorage.setItem("yuanshu.token", "tok");
  for (const fn of Object.values(api)) fn.mockReset();
  api.closeSession.mockResolvedValue({ ok: true, data: undefined });
  api.removeSelf.mockResolvedValue({ ok: true, data: undefined });
});
afterEach(() => {
  cleanup();
  clearToasts();
  sessionStorage.clear();
});

const mount = () => {
  const onSignedOut = vi.fn();
  render(
    <NavProvider nav={createNav()}>
      <SettingsPage onSignedOut={onSignedOut} />
      <ToastHost />
    </NavProvider>,
  );
  return onSignedOut;
};
const confirm = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(screen.getByRole("button", { name: "再点一次确认退出" }));
};

test("设备：先清会话 Cookie，再让服务端删掉自己，成功后清本地令牌并回到令牌门", async () => {
  api.whoami.mockResolvedValue({ ok: true, data: device });
  const onSignedOut = mount();
  await screen.findByText("测试手机");
  confirm("退出此设备");
  await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  expect(api.closeSession).toHaveBeenCalledWith("tok");
  expect(api.removeSelf).toHaveBeenCalledWith("tok");
  expect(sessionStorage.getItem("yuanshu.token")).toBeNull();
});

test("设备：服务端没删成（断网、限流）就不退出，令牌还在，提示重试", async () => {
  api.whoami.mockResolvedValue({ ok: true, data: device });
  api.removeSelf.mockResolvedValue({ ok: false, kind: "network" });
  const onSignedOut = mount();
  await screen.findByText("测试手机");
  confirm("退出此设备");
  await waitFor(() =>
    expect(document.querySelector(".u-toast")?.textContent).toContain(
      "退出没有成功",
    ),
  );
  expect(onSignedOut).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("yuanshu.token")).toBe("tok");
});

test("设备：已经被电脑撤销了（401）照样退出", async () => {
  api.whoami.mockResolvedValue({ ok: true, data: device });
  api.removeSelf.mockResolvedValue({ ok: false, kind: "unauthorized" });
  const onSignedOut = mount();
  await screen.findByText("测试手机");
  confirm("退出此设备");
  await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
});

test("全局令牌：只清会话 Cookie 与本地令牌，不调设备接口", async () => {
  api.whoami.mockResolvedValue({ ok: true, data: { kind: "global" } });
  const onSignedOut = mount();
  await screen.findByText("全局令牌登录");
  confirm("退出登录");
  await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  expect(api.closeSession).toHaveBeenCalledWith("tok");
  expect(api.removeSelf).not.toHaveBeenCalled();
});

test("身份还没读到之前退出按钮不可点（否则会漏掉服务端的撤销）", async () => {
  api.whoami.mockReturnValue(new Promise(() => {}));
  mount();
  const btn = screen.getByRole("button", { name: "退出登录" });
  expect((btn as HTMLButtonElement).disabled).toBe(true);
});
