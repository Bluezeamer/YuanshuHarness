import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Gate } from "./Gate";

const sessions = [
  { id: "a", name: "甲", createdAt: "t", updatedAt: "t", running: false },
];

const reply = (status: number, body: unknown = {}, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const fetchMock = vi.fn();
const view = () => render(<Gate>{(s) => <p>就绪 {s.length}</p>}</Gate>);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("R3 200 进入外壳", async () => {
  fetchMock.mockResolvedValue(reply(200, { sessions }));
  view();
  expect(await screen.findByText("就绪 1")).toBeTruthy();
});

test("R3 401 显示令牌界面", async () => {
  fetchMock.mockResolvedValue(reply(401, { error: "unauthorized" }));
  view();
  expect(await screen.findByLabelText("访问令牌")).toBeTruthy();
});

test("R3 网络失败不进入外壳并可重试", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fail"));
  view();
  expect(await screen.findByText("无法连接 Server")).toBeTruthy();
  expect(screen.queryByText(/就绪/)).toBeNull();
  fetchMock.mockResolvedValueOnce(reply(200, { sessions }));
  fireEvent.click(screen.getByText("重试"));
  expect(await screen.findByText("就绪 1")).toBeTruthy();
});

test("R3 读响应体时连接中断：不卡在连接中，显示错误且不进入外壳", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.reject(new TypeError("terminated")),
  });
  view();
  expect(await screen.findByText("Server 返回了错误")).toBeTruthy();
  expect(screen.queryByText(/就绪/)).toBeNull();
});

test("R4 令牌成功才保存，且只进 sessionStorage 与 Authorization", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m),
  );
  fetchMock.mockResolvedValueOnce(reply(401));
  view();
  const input = await screen.findByLabelText("访问令牌");
  fetchMock.mockResolvedValueOnce(reply(200, { sessions }));
  fireEvent.change(input, { target: { value: "tok-ok" } });
  fireEvent.click(screen.getByText("进入"));
  expect(await screen.findByText("就绪 1")).toBeTruthy();
  const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect((init.headers as Record<string, string>).Authorization).toBe(
    "Bearer tok-ok",
  );
  expect(url).not.toContain("tok-ok");
  expect(sessionStorage.getItem("yuanshu.token")).toBe("tok-ok");
  expect(localStorage.length).toBe(0);
  for (const spy of spies)
    expect(JSON.stringify(spy.mock.calls)).not.toContain("tok-ok");
});

test("R4 令牌错误不保存并提示：全程没写过任何存储，也没进 URL 与控制台", async () => {
  const writes = vi.spyOn(Storage.prototype, "setItem");
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m),
  );
  fetchMock.mockResolvedValue(reply(401));
  view();
  fireEvent.change(await screen.findByLabelText("访问令牌"), {
    target: { value: "bad" },
  });
  fireEvent.click(screen.getByText("进入"));
  expect(await screen.findByText("令牌不正确")).toBeTruthy();
  expect(sessionStorage.getItem("yuanshu.token")).toBeNull();
  expect(writes).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  for (const [url] of fetchMock.mock.calls)
    expect(String(url)).not.toContain("bad");
  for (const spy of spies)
    expect(JSON.stringify(spy.mock.calls)).not.toContain("bad");
});

test("R5 429 提示等待秒数且不自动重试", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock.mockResolvedValue(reply(429, {}, { "Retry-After": "30" }));
  view();
  expect(await screen.findByText("尝试过多，请 30 秒后再试")).toBeTruthy();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("R5 403 提示来源不被允许", async () => {
  fetchMock.mockResolvedValue(reply(403, { error: "forbidden_source" }));
  view();
  expect(await screen.findByText("当前来源不被允许")).toBeTruthy();
});
