import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installApi, installPaneApi, type PaneApi, paneEnv } from "../fakes";
import { EnvContext } from "../layout/env";
import type { PaneBinding } from "../layout/types";
import { type AuditConfig, AuditPane } from "./AuditPane";

let api: PaneApi;

beforeEach(() => {
  sessionStorage.clear();
  installApi();
  api = installPaneApi();
  api.audit = [
    {
      id: 3,
      ts: "2026-01-02T03:04:05Z",
      sessionId: "s1",
      actor: "agent",
      kind: "file",
      environmentId: "local",
      summary: "写入 a.txt",
      detail: { path: "/work/proj/a.txt" },
    },
    {
      id: 2,
      ts: "2026-01-02T03:04:04Z",
      sessionId: "s1",
      actor: "user",
      kind: "terminal",
      environmentId: "local",
      summary: "打开终端",
      detail: null,
    },
    {
      id: 1,
      ts: "2026-01-02T03:04:03Z",
      sessionId: "s2",
      actor: "system",
      kind: "env",
      environmentId: "ssh1",
      summary: "连接 dev-box",
      detail: null,
    },
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(
  config: AuditConfig = { kind: null },
  binding: PaneBinding = { mode: "follow" },
  onUpdateConfig = vi.fn(),
) {
  const env = paneEnv("s1");
  render(
    <EnvContext value={env}>
      <AuditPane
        paneId="a1"
        config={config}
        focused={false}
        binding={binding}
        onUpdateConfig={onUpdateConfig}
      />
    </EnvContext>,
  );
  return { env, onUpdateConfig };
}

const urls = () =>
  api.calls
    .filter((c) => c.path.startsWith("/api/v1/audit"))
    .map((c) => c.path);

test("跟随模式只取当前会话的记录", async () => {
  mount();
  await screen.findByText("写入 a.txt");
  expect(screen.getByText("打开终端")).toBeTruthy();
  expect(screen.queryByText("连接 dev-box")).toBeNull();
  expect(urls()[0]).toContain("session=s1");
  expect(screen.getByText("当前会话")).toBeTruthy();
});

test("钉住别的会话时取那个会话的记录", async () => {
  mount({ kind: null }, { mode: "fixed", sessionId: "s2", host: null });
  await screen.findByText("连接 dev-box");
  expect(screen.queryByText("写入 a.txt")).toBeNull();
});

test("按 kind 筛选：点芯片更新配置，配置变化后带上 kind 重取", async () => {
  const { onUpdateConfig } = mount();
  await screen.findByText("写入 a.txt");
  fireEvent.click(screen.getByRole("button", { name: "终端" }));
  expect(onUpdateConfig).toHaveBeenCalledWith({ kind: "terminal" });
  cleanup();
  mount({ kind: "terminal" });
  await screen.findByText("打开终端");
  expect(screen.queryByText("写入 a.txt")).toBeNull();
  expect(urls().at(-1)).toContain("kind=terminal");
  expect(
    screen.getByRole("button", { name: "终端" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

test("点开一条显示 detail，再点收起", async () => {
  mount();
  fireEvent.click(await screen.findByText("写入 a.txt"));
  expect(screen.getByText(/"path": "\/work\/proj\/a\.txt"/)).toBeTruthy();
  fireEvent.click(screen.getByText("写入 a.txt"));
  expect(screen.queryByText(/"path": "\/work\/proj\/a\.txt"/)).toBeNull();
});

test("有更早的记录时可以继续加载", async () => {
  api.auditPage = 1;
  mount();
  await screen.findByText("写入 a.txt");
  expect(screen.queryByText("打开终端")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "加载更早的记录" }));
  await screen.findByText("打开终端");
  expect(urls().at(-1)).toContain("before=3");
  expect(screen.queryByRole("button", { name: "加载更早的记录" })).toBeNull();
});

test("没有记录时给空状态，读取失败时报错", async () => {
  api.audit = [];
  mount();
  await screen.findByText("还没有审计记录");
  cleanup();
  api.fail["GET /api/v1/audit"] = 500;
  mount();
  await screen.findByRole("alert");
});

test("401 通知登录失效", async () => {
  api.fail["GET /api/v1/audit"] = 401;
  const { env } = mount();
  await waitFor(() => expect(env.hub.onUnauthorized).toHaveBeenCalled());
});
