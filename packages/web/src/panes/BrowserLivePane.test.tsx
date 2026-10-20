import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PaneBinding } from "../layout/types";
import { type BrowserLiveConfig, BrowserLivePane } from "./BrowserLivePane";

afterEach(() => {
  cleanup();
  FakeWebSocket.all = [];
});

// WebSocket 全局桩，避免真实连接。
class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  constructor() {
    FakeWebSocket.all.push(this);
  }
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  binaryType = "arraybuffer";
  on = vi.fn();
  onmessage: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
}
global.WebSocket = FakeWebSocket as never;

function mount(
  config: BrowserLiveConfig,
  binding: PaneBinding = { mode: "follow" },
) {
  render(
    <BrowserLivePane
      paneId="p1"
      config={config}
      focused={false}
      binding={binding}
      onUpdateConfig={vi.fn()}
    />,
  );
}

test("未绑定会话时显示空状态提示", () => {
  mount({}, { mode: "fixed", sessionId: null, host: null });
  expect(screen.getByText(/钉住到会话/)).toBeTruthy();
});

test("绑定会话但未打开页面时显示等待态", async () => {
  mount({}, { mode: "fixed", sessionId: "s1", host: null });
  await waitFor(() =>
    expect(screen.queryByText(/等待 agent 调用/)).toBeTruthy(),
  );
});

const push = (n: Record<string, unknown>) =>
  act(() => {
    FakeWebSocket.all.at(-1)?.onmessage?.({
      data: JSON.stringify({ type: "state", ...n }),
    });
  });

const BOUND = { mode: "fixed" as const, sessionId: "s1", host: null };

test("浏览器不可用：显示安装提示", async () => {
  mount({}, BOUND);
  await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
  push({
    available: false,
    hint: "未找到 Chromium，请安装后重试",
    active: false,
    url: "",
    title: "",
    loading: false,
  });
  expect(screen.getByText("浏览器不可用")).toBeTruthy();
  expect(screen.getByText(/未找到 Chromium/)).toBeTruthy();
});

test("页面已打开：显示标题与地址，加载中有文字提示", async () => {
  mount({}, BOUND);
  await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
  push({
    available: true,
    hint: null,
    active: true,
    url: "http://example.test/",
    title: "示例页",
    loading: true,
  });
  expect(screen.getByText(/示例页/)).toBeTruthy();
  expect(screen.getByText(/http:\/\/example.test\//)).toBeTruthy();
  expect(screen.getByText("加载中…")).toBeTruthy();
});

test("连接断开：提示重连中", async () => {
  mount({}, BOUND);
  await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
  push({
    available: true,
    hint: null,
    active: true,
    url: "http://example.test/",
    title: "示例页",
    loading: false,
  });
  act(() => {
    FakeWebSocket.all.at(-1)?.onclose?.();
  });
  expect(screen.getByText("连接已断开，重连中…")).toBeTruthy();
});
