import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FakeWS,
  installChatApi,
  msgs,
  snapshot,
} from "../../../test/chatFakes";
import type { Tab } from "../../workspace/model/types";
import { ChatProvider } from "../context";
import { AuditToggle } from "./AuditToggle";

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  installChatApi(msgs(0, 1));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tab = (over: Partial<Tab> = {}): Tab => ({
  id: "t1",
  type: "chat",
  sid: "s1",
  ...over,
});

function mount(t: Tab) {
  const patchTab = vi.fn();
  render(
    <ChatProvider token="tok" onUnauthorized={() => {}}>
      <AuditToggle tab={t} patchTab={patchTab} />
    </ChatProvider>,
  );
  return patchTab;
}

test("对话里是「审计 N」，N 取自会话用量的调用数；点它切到审计", async () => {
  const api = installChatApi(msgs(0, 1));
  api.usage = {
    turns: 1,
    steps: 11,
    tokensPerSecond: null,
    modelMs: null,
    toolMs: null,
    ttftMs: null,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    cacheHitRate: null,
    context: null,
  };
  api.calls = [];
  const patchTab = mount(tab());
  await act(async () => {
    FakeWS.last.serve(
      snapshot(1, msgs(0, 1), {
        usage: {
          turns: 1,
          steps: 11,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    );
  });
  const btn = screen.getByRole("button", { name: /审计/ });
  expect(btn.textContent).toBe("审计 11");
  fireEvent.click(btn);
  expect(patchTab).toHaveBeenCalledWith({ ctab: "audit" });
});

test("没有用量记录时 N 是 0", () => {
  mount(tab());
  expect(screen.getByRole("button", { name: /审计/ }).textContent).toBe(
    "审计 0",
  );
});

test("审计里换成「对话」，点它回到对话", () => {
  const patchTab = mount(tab({ ctab: "audit" }));
  expect(screen.queryByRole("button", { name: /审计/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "对话" }));
  expect(patchTab).toHaveBeenCalledWith({ ctab: "chat" });
});

test("空对话标签（没有绑会话）不出现", () => {
  const { sid: _sid, ...bare } = tab();
  mount(bare as Tab);
  expect(screen.queryByRole("button")).toBeNull();
});
