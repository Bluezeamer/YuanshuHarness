import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../../../../api/http";
import type { Tab } from "../../model/types";
import { closeTerminalTabs, useTerminalCloseGuard } from "./close";
import { bad, ok, status } from "./testkit";

const api = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  getTerminal: vi.fn(),
}));
vi.mock("../../../../api/terminals", () => api);

beforeEach(() => {
  sessionStorage.clear();
  saveToken("tok");
  api.closeTerminal.mockResolvedValue(ok(undefined));
});
afterEach(() => {
  cleanup();
  for (const f of Object.values(api)) f.mockReset();
});

const term = (termId: string, over: Partial<Tab> = {}): Tab => ({
  id: `tab-${termId}`,
  type: "term",
  termId,
  cwd: "/w",
  ...over,
});

test("空闲终端：不询问，直接关", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: false })));
  const ask = vi.fn();
  expect(await closeTerminalTabs([term("t-1")], ask)).toBe(true);
  expect(ask).not.toHaveBeenCalled();
  expect(api.closeTerminal).toHaveBeenCalledWith("tok", "t-1");
});

test("有前台进程：确认后才关；取消则一个都不关", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: true })));
  const no = vi.fn().mockResolvedValue(false);
  expect(await closeTerminalTabs([term("t-1")], no)).toBe(false);
  expect(api.closeTerminal).not.toHaveBeenCalled();

  const yes = vi.fn().mockResolvedValue(true);
  expect(await closeTerminalTabs([term("t-1")], yes)).toBe(true);
  expect(yes).toHaveBeenCalledWith([{ termId: "t-1", cwd: "/w", busy: true }]);
  expect(api.closeTerminal).toHaveBeenCalledWith("tok", "t-1");
});

test("busy 为 null（ssh 无法判断）：按有风险处理，确认里标为无法判断", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: null })));
  const ask = vi.fn().mockResolvedValue(true);
  await closeTerminalTabs([term("t-1")], ask);
  expect(ask).toHaveBeenCalledWith([{ termId: "t-1", cwd: "/w", busy: null }]);
});

test("一批标签只问一次，且只列有风险的", async () => {
  api.getTerminal.mockImplementation(async (_t: string, id: string) =>
    ok(status(id, { busy: id === "t-2" })),
  );
  const ask = vi.fn().mockResolvedValue(true);
  await closeTerminalTabs([term("t-1"), term("t-2")], ask);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls[0]?.[0]).toEqual([
    { termId: "t-2", cwd: "/w", busy: true },
  ]);
  expect(api.closeTerminal).toHaveBeenCalledTimes(2);
});

test("服务端已经没有（404）或标签已结束：不问也不关，视为可移除", async () => {
  api.getTerminal.mockResolvedValue(bad("not_found"));
  const ask = vi.fn();
  expect(await closeTerminalTabs([term("t-1")], ask)).toBe(true);
  expect(await closeTerminalTabs([term("t-2", { termEnded: true })], ask)).toBe(
    true,
  );
  expect(ask).not.toHaveBeenCalled();
  expect(api.closeTerminal).not.toHaveBeenCalled();
});

test("非终端标签自动忽略", async () => {
  const ask = vi.fn();
  const files: Tab = { id: "f", type: "files" };
  expect(await closeTerminalTabs([files], ask)).toBe(true);
  expect(api.getTerminal).not.toHaveBeenCalled();
});

test("关闭请求失败：返回 false，标签应保留", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: false })));
  api.closeTerminal.mockResolvedValue(bad("server"));
  expect(await closeTerminalTabs([term("t-1")], vi.fn())).toBe(false);
});

function Harness({ tabs, onDone }: { tabs: Tab[]; onDone(ok: boolean): void }) {
  const { confirmClose, dialog } = useTerminalCloseGuard();
  return (
    <>
      <button
        type="button"
        onClick={() => void confirmClose(tabs).then(onDone)}
      >
        关标签
      </button>
      {dialog}
    </>
  );
}

test("hook：busy 时弹出确认框，点「关闭终端」后才真正关", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-abcdef12", { busy: true })));
  const onDone = vi.fn();
  render(<Harness tabs={[term("t-abcdef12")]} onDone={onDone} />);
  fireEvent.click(screen.getByText("关标签"));

  await screen.findByText("关闭终端？");
  expect(api.closeTerminal).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "关闭终端" }));
  });
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
  expect(api.closeTerminal).toHaveBeenCalledWith("tok", "t-abcdef12");
});

test("hook：点取消返回 false，不关终端", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: true })));
  const onDone = vi.fn();
  render(<Harness tabs={[term("t-1")]} onDone={onDone} />);
  fireEvent.click(screen.getByText("关标签"));
  await screen.findByText("关闭终端？");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
  });
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  expect(api.closeTerminal).not.toHaveBeenCalled();
});
