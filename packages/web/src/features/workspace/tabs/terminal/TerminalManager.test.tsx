import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../../../../api/http";
import { LayoutProvider } from "../../layoutContext";
import { createLayoutStore } from "../../store/layoutStore";
import { TerminalManager, type TerminalManagerProps } from "./TerminalManager";
import { bad, ok, status } from "./testkit";

const api = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  listTerminals: vi.fn(),
}));
vi.mock("../../../../api/terminals", () => api);

/** 终端管理要读当前工作区 id，所以挂在 LayoutProvider 里 */
function show(props: TerminalManagerProps) {
  const store = createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: null } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });
  return render(
    <LayoutProvider
      store={store}
      workspaceId="ws1"
      directories={null}
      sessions={null}
      hosts={[]}
    >
      <TerminalManager {...props} />
    </LayoutProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  saveToken("tok");
  api.listTerminals.mockResolvedValue(ok([]));
  api.closeTerminal.mockResolvedValue(ok(undefined));
});
afterEach(() => {
  cleanup();
  for (const f of Object.values(api)) f.mockReset();
});

test("展示终端列表：id、环境、目录、附着数、创建时间", async () => {
  api.listTerminals.mockResolvedValue(
    ok([
      status("t-a1b2c3d4", {
        environmentId: "ssh-1",
        cwd: "/srv/app",
        attached: 1,
        createdAt: "2026-10-25T10:30:00.000Z",
      }),
      status("t-2", { attached: 0 }),
    ]),
  );
  show({ referencedIds: new Set(["t-a1b2c3d4"]) });
  await screen.findByText(/共 2 个/);
  expect(screen.getByText(/#a1b2c3d4/)).toBeTruthy();
  expect(screen.getByText(/ssh-1 · \/srv\/app/)).toBeTruthy();
  expect(screen.getByText("1")).toBeTruthy();
  expect(screen.getAllByText(/10\/25/).length).toBeGreaterThan(0);
});

test("统计无引用终端数量", async () => {
  api.listTerminals.mockResolvedValue(
    ok([status("t-1"), status("t-2"), status("t-3")]),
  );
  show({ referencedIds: new Set(["t-1"]) });
  await screen.findByText(/共 3 个 · 2 个无引用/);
});

test("被 tab 引用的标记「使用中」不可关；孤儿可两步确认关闭", async () => {
  api.listTerminals.mockResolvedValue(ok([status("t-1"), status("t-2")]));
  show({ referencedIds: new Set(["t-1"]) });
  await screen.findByText(/共 2 个/);
  const rows = screen.getAllByRole("row");
  const usedRow = rows.find((r) => r.textContent?.includes("#t-1"));
  const orphanRow = rows.find((r) => r.textContent?.includes("#t-2"));
  expect(usedRow?.textContent).toContain("使用中");
  expect(orphanRow?.querySelector("button")?.textContent).toBe("关闭");

  // 两步确认：第一次上膛，第二次才关
  const btn = orphanRow?.querySelector("button");
  if (!btn) throw new Error("找不到关闭按钮");
  fireEvent.click(btn);
  expect(btn.textContent).toContain("确认");
  expect(api.closeTerminal).not.toHaveBeenCalled();
  fireEvent.click(btn);
  await waitFor(() =>
    expect(api.closeTerminal).toHaveBeenCalledWith("tok", "t-2"),
  );
});

test("busy 终端的确认文案变成「确认（有进程）」", async () => {
  api.listTerminals.mockResolvedValue(ok([status("t-1", { busy: true })]));
  show({ referencedIds: new Set() });
  await screen.findByText(/共 1 个/);
  const btn = screen.getByRole("button", { name: "关闭" });
  fireEvent.click(btn);
  expect(btn.textContent).toContain("确认（有进程）");
});

test("关闭成功后刷新列表并通知调用方", async () => {
  api.listTerminals
    .mockResolvedValueOnce(ok([status("t-1"), status("t-2")]))
    .mockResolvedValueOnce(ok([status("t-2")]));
  const onClosed = vi.fn();
  show({ referencedIds: new Set(), onClosed });
  await screen.findByText(/共 2 个/);
  const rows = screen.getAllByRole("row");
  const btn = rows
    .find((r) => r.textContent?.includes("#t-1"))
    ?.querySelector("button");
  if (!btn) throw new Error("找不到按钮");
  fireEvent.click(btn);
  fireEvent.click(btn);
  await waitFor(() => expect(onClosed).toHaveBeenCalledWith("t-1"));
  await waitFor(() => expect(api.listTerminals).toHaveBeenCalledTimes(2));
});

test("关闭失败：不通知调用方", async () => {
  api.listTerminals.mockResolvedValue(ok([status("t-1")]));
  api.closeTerminal.mockResolvedValue(bad("server"));
  const onClosed = vi.fn();
  show({ referencedIds: new Set(), onClosed });
  await screen.findByText(/共 1 个/);
  const btn = screen.getByRole("button", { name: "关闭" });
  fireEvent.click(btn);
  fireEvent.click(btn);
  await waitFor(() => expect(api.closeTerminal).toHaveBeenCalled());
  expect(onClosed).not.toHaveBeenCalled();
});

test("服务端没有终端时显示空态", async () => {
  show({ referencedIds: new Set() });
  await screen.findByText("服务端没有终端");
  expect(screen.getByText(/新建终端标签后会出现在这里/)).toBeTruthy();
});

test("列表接口失败：显示错误提示", async () => {
  api.listTerminals.mockResolvedValue(bad("network"));
  show({ referencedIds: new Set() });
  await screen.findByText("无法获取终端列表");
});

test("不列出别的工作区的终端：它们既不算孤儿也不用管", async () => {
  api.listTerminals.mockResolvedValue(
    ok([
      status("t-mine", { workspaceId: "ws1" }),
      status("t-loose", { workspaceId: null }),
      status("t-other", { workspaceId: "ws2" }),
    ]),
  );
  show({ referencedIds: new Set(["t-mine"]) });
  await screen.findByText(/共 2 个 · 1 个无引用/);
  expect(screen.getByText("#t-mine")).toBeTruthy();
  expect(screen.getByText("#t-loose")).toBeTruthy();
  expect(screen.queryByText("#t-other")).toBeNull();
});

test("点刷新按钮：重新拉列表", async () => {
  api.listTerminals.mockResolvedValue(ok([status("t-1")]));
  show({ referencedIds: new Set() });
  await screen.findByText(/共 1 个/);
  expect(api.listTerminals).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(api.listTerminals).toHaveBeenCalledTimes(2));
});
