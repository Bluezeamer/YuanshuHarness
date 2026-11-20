// 手机设备页：列表（名字、添加与最近使用时间）、撤销（点两下确认）、添加手机的弹窗（配对码、二维码、倒计时、过期、配对成功自动关闭）。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DeviceView } from "../../../api/devices";
import { clearToasts, ToastHost } from "../../../ui";
import { DevicesPage } from "./DevicesPage";

const api = vi.hoisted(() => ({
  listDevices: vi.fn(),
  createPairing: vi.fn(),
  removeDevice: vi.fn(),
}));
vi.mock("../../../api/devices", async (orig) => ({
  ...(await orig<typeof import("../../../api/devices")>()),
  ...api,
}));

const dev = (
  id: string,
  name: string,
  over: Partial<DeviceView> = {},
): DeviceView => ({
  id,
  name,
  createdAt: "2026-11-19T08:00:00.000Z",
  lastUsedAt: null,
  ...over,
});

beforeEach(() => {
  sessionStorage.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listDevices.mockResolvedValue({
    ok: true,
    data: [
      dev("d1", "Pixel 8", { lastUsedAt: "2026-11-19T09:30:00.000Z" }),
      dev("d2", "平板"),
    ],
  });
  api.removeDevice.mockResolvedValue({ ok: true, data: undefined });
  api.createPairing.mockImplementation(async () => ({
    ok: true,
    data: {
      code: "ABCD2345",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
  }));
});
afterEach(() => {
  cleanup();
  clearToasts();
  vi.useRealTimers();
});

const mount = async () => {
  render(
    <>
      <DevicesPage />
      <ToastHost />
    </>,
  );
  await screen.findByText("Pixel 8");
};

test("列出设备：名字、添加时间、最近使用（没用过的写没用过）", async () => {
  await mount();
  expect(screen.getByText(/最近使用 2026-11-19/)).toBeTruthy();
  expect(screen.getByText(/还没有使用过/)).toBeTruthy();
  expect(screen.getByText("平板")).toBeTruthy();
});

test("没有设备：说明怎么加；读取失败可重试", async () => {
  api.listDevices.mockResolvedValueOnce({ ok: true, data: [] });
  render(<DevicesPage />);
  await screen.findByText("还没有添加手机");
  cleanup();

  api.listDevices.mockResolvedValueOnce({ ok: false, kind: "server" });
  render(<DevicesPage />);
  await screen.findByText("读取设备失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("Pixel 8");
});

test("撤销：点两下才执行，成功后重新读列表；第一下不动", async () => {
  await mount();
  const btn = screen.getByRole("button", { name: "撤销 Pixel 8" });
  fireEvent.click(btn);
  expect(api.removeDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "撤销 Pixel 8" }));
  await waitFor(() =>
    expect(api.removeDevice).toHaveBeenCalledWith(null, "d1"),
  );
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  expect(document.querySelector(".u-toast")?.textContent).toContain(
    "已撤销「Pixel 8」",
  );
});

test("撤销失败要告诉用户；设备已经不在（404）当作撤销成功", async () => {
  await mount();
  api.removeDevice.mockResolvedValueOnce({ ok: false, kind: "server" });
  fireEvent.click(screen.getByRole("button", { name: "撤销 Pixel 8" }));
  fireEvent.click(screen.getByRole("button", { name: "撤销 Pixel 8" }));
  await waitFor(() =>
    expect(document.querySelector(".u-toast")?.textContent).toContain(
      "撤销失败",
    ),
  );
  clearToasts();
  api.removeDevice.mockResolvedValueOnce({ ok: false, kind: "not_found" });
  fireEvent.click(screen.getByRole("button", { name: "撤销 平板" }));
  fireEvent.click(screen.getByRole("button", { name: "撤销 平板" }));
  await waitFor(() =>
    expect(document.querySelector(".u-toast")?.textContent).toContain(
      "已撤销「平板」",
    ),
  );
});

test("添加手机：出配对码与二维码、倒计时；地址是本机时提示改成局域网地址", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "添加手机" }));
  await screen.findByRole("img", { name: "配对二维码" });
  expect(api.createPairing).toHaveBeenCalledTimes(1);
  // jsdom 里的 origin 是 localhost：二维码仍画，但提示这个地址手机打不开
  expect(screen.getByText(/本机地址，手机打不开/)).toBeTruthy();
  expect(screen.getByText(/\/m\/\?pair=ABCD2345/)).toBeTruthy();
  expect(screen.getByText(/分 \d{2} 秒后失效/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText("手机访问的地址"), {
    target: { value: "192.168.1.20:7431" },
  });
  expect(screen.queryByText(/本机地址，手机打不开/)).toBeNull();
  expect(
    screen.getByText("http://192.168.1.20:7431/m/?pair=ABCD2345"),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("手机访问的地址"), {
    target: { value: "" },
  });
  expect(screen.getByText(/地址不对/)).toBeTruthy();
  expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull();
});

test("码过期：二维码收起、提示重新生成；重新生成换一张新码", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "添加手机" }));
  await screen.findByRole("img", { name: "配对二维码" });
  await act(async () => {}); // 先让定时器的 effect 挂上，再快进
  await act(async () => {
    vi.advanceTimersByTime(301_000);
  });
  expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull();
  expect(screen.getByText(/配对码已失效/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  await screen.findByRole("img", { name: "配对二维码" });
  expect(api.createPairing).toHaveBeenCalledTimes(2);
});

test("生成配对码失败：给出提示；配对成功（多出一台设备）弹窗自己关掉并提示", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.createPairing.mockResolvedValueOnce({ ok: false, kind: "server" });
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "添加手机" }));
  await screen.findByText("生成配对码失败，请重试。");
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  await screen.findByRole("img", { name: "配对二维码" });

  await act(async () => {}); // 先让轮询的 effect 挂上，再快进
  api.listDevices.mockResolvedValue({
    ok: true,
    data: [dev("d1", "Pixel 8"), dev("d2", "平板"), dev("d3", "新手机")],
  });
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("新手机")).toBeTruthy();
  expect(document.querySelector(".u-toast")?.textContent).toContain(
    "手机已添加",
  );
});
