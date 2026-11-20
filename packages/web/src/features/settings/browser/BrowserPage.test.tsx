// 浏览器设置页：下载镜像（草稿 + 保存条）、已保存登录状态的列表、允许开关、删除（点两下确认）、清空（确认弹窗）。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LoginMeta } from "../../../api/browser";
import { ApiError } from "../../../api/http";
import { clearToasts, ToastHost } from "../../../ui";
import { BrowserPage } from "./BrowserPage";

const api = vi.hoisted(() => ({
  listLogins: vi.fn(),
  setLoginEnabled: vi.fn(),
  removeLogin: vi.fn(),
  clearLogins: vi.fn(),
}));
vi.mock("../../../api/browser", async (orig) => ({
  ...(await orig<typeof import("../../../api/browser")>()),
  ...api,
}));
const defaultsApi = vi.hoisted(() => ({
  getDefaults: vi.fn(),
  putDefaults: vi.fn(),
}));
vi.mock("../../../api/defaults", async (orig) => ({
  ...(await orig<typeof import("../../../api/defaults")>()),
  ...defaultsApi,
}));

const meta = (site: string, over: Partial<LoginMeta> = {}): LoginMeta => ({
  site,
  enabled: true,
  savedAt: "2026-11-13T08:05:00.000Z",
  cookies: 4,
  origins: 1,
  ...over,
});

beforeEach(() => {
  sessionStorage.clear();
  for (const fn of [...Object.values(api), ...Object.values(defaultsApi)])
    fn.mockReset();
  defaultsApi.getDefaults.mockResolvedValue({ browserMirror: "" });
  api.listLogins.mockResolvedValue({
    ok: true,
    data: [meta("github.com"), meta("google.com", { enabled: false })],
  });
});
afterEach(() => {
  cleanup();
  clearToasts();
});

const toastText = () => document.querySelector(".u-toast")?.textContent ?? "";

const page = () => (
  <>
    <BrowserPage />
    <ToastHost />
  </>
);

async function mount() {
  render(page());
  await screen.findByText("github.com");
}

test("列出已保存的站点：条数与保存时间，开关反映是否允许 agent 使用", async () => {
  await mount();
  expect(screen.getByText("google.com")).toBeTruthy();
  expect(screen.getAllByText(/4 个 cookie · 1 个站点存储/)).toHaveLength(2);
  expect(
    (
      screen.getByRole("switch", {
        name: "允许 agent 使用 github.com 的登录状态",
      }) as HTMLElement
    ).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen
      .getByRole("switch", { name: "允许 agent 使用 google.com 的登录状态" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("没有保存过：给说明，不出「清空全部」", async () => {
  api.listLogins.mockResolvedValue({ ok: true, data: [] });
  render(page());
  expect(await screen.findByText("还没有保存登录状态")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "清空全部" })).toBeNull();
});

test("读取失败：给原因和「重试」，重试后显示列表", async () => {
  api.listLogins.mockResolvedValueOnce({ ok: false, kind: "network" });
  render(page());
  expect(await screen.findByText("读取登录状态失败")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("github.com")).toBeTruthy();
});

test("切换开关：请求服务端，成功后以服务端的列表为准", async () => {
  await mount();
  api.setLoginEnabled.mockResolvedValue({
    ok: true,
    data: { site: "google.com", enabled: true },
  });
  api.listLogins.mockResolvedValue({
    ok: true,
    data: [meta("github.com"), meta("google.com", { enabled: true })],
  });
  fireEvent.click(
    screen.getByRole("switch", {
      name: "允许 agent 使用 google.com 的登录状态",
    }),
  );
  await waitFor(() =>
    expect(api.setLoginEnabled).toHaveBeenCalledWith(null, "google.com", true),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("switch", { name: "允许 agent 使用 google.com 的登录状态" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("切换失败：弹出原因，开关保持原样", async () => {
  await mount();
  api.setLoginEnabled.mockResolvedValue({
    ok: false,
    status: 404,
    message: "操作失败，请重试",
  });
  fireEvent.click(
    screen.getByRole("switch", {
      name: "允许 agent 使用 github.com 的登录状态",
    }),
  );
  await waitFor(() => expect(toastText()).toContain("操作失败，请重试"));
  expect(
    screen
      .getByRole("switch", { name: "允许 agent 使用 github.com 的登录状态" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("删除一个站点：点两下才执行（第一下只是上膛）", async () => {
  await mount();
  api.removeLogin.mockResolvedValue({ ok: true, data: undefined });
  api.listLogins.mockResolvedValue({ ok: true, data: [meta("google.com")] });
  const del = screen.getByRole("button", {
    name: "删除 github.com 的登录状态",
  });
  fireEvent.click(del);
  expect(api.removeLogin).not.toHaveBeenCalled();
  fireEvent.click(del);
  await waitFor(() =>
    expect(api.removeLogin).toHaveBeenCalledWith(null, "github.com"),
  );
  await waitFor(() => expect(screen.queryByText("github.com")).toBeNull());
  expect(screen.getByText("google.com")).toBeTruthy();
});

test("清空全部：先弹确认并说明影响，确认后才请求", async () => {
  await mount();
  api.clearLogins.mockResolvedValue({ ok: true, data: 2 });
  api.listLogins.mockResolvedValue({ ok: true, data: [] });
  fireEvent.click(screen.getByRole("button", { name: "清空全部" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/删除 2 个站点保存的登录状态/)).toBeTruthy();
  expect(api.clearLogins).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "清空" }));
  await waitFor(() => expect(api.clearLogins).toHaveBeenCalledWith(null));
  expect(await screen.findByText("还没有保存登录状态")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

const mirrorInput = () => screen.getByLabelText("下载镜像") as HTMLInputElement;

test("下载镜像：显示已保存的值，改了出保存条，粘贴带进来的空白当场去掉，保存后保存条消失", async () => {
  defaultsApi.getDefaults.mockResolvedValue({
    browserMirror: "https://old.example/pw",
  });
  await mount();
  expect(mirrorInput().value).toBe("https://old.example/pw");
  expect(screen.queryByRole("region", { name: "保存" })).toBeNull();

  defaultsApi.putDefaults.mockResolvedValue({
    browserMirror: "https://mirror.example/pw",
  });
  fireEvent.change(mirrorInput(), {
    target: { value: "  https://mirror.example/pw " },
  });
  fireEvent.click(
    within(screen.getByRole("region", { name: "保存" })).getByRole("button", {
      name: "保存",
    }),
  );
  await waitFor(() =>
    expect(defaultsApi.putDefaults).toHaveBeenCalledWith(null, {
      browserMirror: "https://mirror.example/pw",
    }),
  );
  await waitFor(() => expect(toastText()).toContain("已保存"));
  expect(mirrorInput().value).toBe("https://mirror.example/pw");
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "保存" })).toBeNull(),
  );
});

test("下载镜像：不是 http(s) 地址时行内报错，保存不发请求并弹出原因", async () => {
  await mount();
  fireEvent.change(mirrorInput(), { target: { value: "mirror.example" } });
  expect(screen.getByText(/以 http 或 https 开头/)).toBeTruthy();
  fireEvent.click(
    within(screen.getByRole("region", { name: "保存" })).getByRole("button", {
      name: "保存",
    }),
  );
  await waitFor(() => expect(toastText()).toContain("保存失败"));
  expect(defaultsApi.putDefaults).not.toHaveBeenCalled();
});

test("下载镜像：服务端拒绝时弹出原因，草稿保留", async () => {
  await mount();
  defaultsApi.putDefaults.mockRejectedValue(
    new ApiError(400, { error: "invalid_browser_mirror" }),
  );
  fireEvent.change(mirrorInput(), { target: { value: "https://a.b/c" } });
  fireEvent.click(
    within(screen.getByRole("region", { name: "保存" })).getByRole("button", {
      name: "保存",
    }),
  );
  await waitFor(() => expect(toastText()).toContain("最长 512"));
  expect(mirrorInput().value).toBe("https://a.b/c");
});

test("读取设置失败：给原因和「重试」，重试后显示页面", async () => {
  defaultsApi.getDefaults.mockRejectedValueOnce(new Error("boom"));
  render(page());
  expect(await screen.findByText("读取浏览器设置失败")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("github.com")).toBeTruthy();
});
