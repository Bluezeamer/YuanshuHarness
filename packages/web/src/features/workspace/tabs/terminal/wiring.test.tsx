import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../../../../api/http";
import { mount, paneByHost, q, tabsIn } from "../../layout/harness";
import type { Tab, WindowState } from "../../model/types";
import { getTabDef, registerTab } from "../registry";
import { bad, ok, status } from "./testkit";
import { referencedTermIds, registerTerminalTab } from "./wiring";

const api = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  getTerminal: vi.fn(),
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  openTerminalSocket: vi.fn(),
}));
vi.mock("../../../../api/terminals", () => api);
// 接线测试只关心关闭守卫，终端内容用替身，避免拉起 xterm。
vi.mock("./TerminalTab", () => ({
  TerminalTab: ({ tab, onManage }: { tab: Tab; onManage?: () => void }) => (
    <div data-testid="term-body">
      <span data-testid="term-id">{tab.termId}</span>
      {onManage && (
        <button type="button" onClick={onManage}>
          管理终端
        </button>
      )}
    </div>
  ),
}));

const original = getTabDef("term");

beforeEach(() => {
  sessionStorage.clear();
  saveToken("tok");
  api.closeTerminal.mockResolvedValue(ok(undefined));
  api.listTerminals.mockResolvedValue(ok([]));
  registerTerminalTab();
});
afterEach(() => {
  cleanup();
  registerTab("term", original);
  for (const f of Object.values(api)) f.mockReset();
});

// 往 server 窗格里放一个终端标签
async function withTerm(termId = "t-1") {
  const m = await mount();
  const pane = paneByHost("server");
  await act(async () => {
    m.store.addTab(pane.dataset.pid as string, "term", {
      host: "server",
      termId,
    } as never);
  });
  return { ...m, pane: paneByHost("server") };
}

// 默认窗口自带标题为 cwd 目录名的终端标签；本测试加的标签没有 cwd，标题恰为「终端」，用精确名称区分。
const closeBtn = () =>
  screen.getByRole("button", { name: "关闭标签 终端" }) as HTMLButtonElement;

test("注册后 term 标签渲染终端内容，标题随 cwd", async () => {
  const { pane } = await withTerm();
  expect(q('[data-testid="term-id"]', pane)?.textContent).toBe("t-1");
  expect(getTabDef("term").title({ id: "x", type: "term" })).toBe("终端");
  expect(getTabDef("term").title({ id: "x", type: "term", cwd: "/a/b" })).toBe(
    "b",
  );
});

test("关闭空闲终端标签：不询问，先杀服务端终端再移除标签", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: false })));
  const { pane } = await withTerm();
  const before = tabsIn(pane).length;
  await act(async () => {
    fireEvent.click(closeBtn());
  });
  await waitFor(() =>
    expect(tabsIn(paneByHost("server")).length).toBe(before - 1),
  );
  expect(api.closeTerminal).toHaveBeenCalledWith("tok", "t-1");
  expect(screen.queryByText("关闭终端？")).toBeNull();
});

test("有前台进程：弹确认；取消后标签与终端都保留", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: true })));
  const { pane } = await withTerm();
  const before = tabsIn(pane).length;
  await act(async () => {
    fireEvent.click(closeBtn());
  });
  await screen.findByText("关闭终端？");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByText("关闭终端？")).toBeNull());
  expect(tabsIn(paneByHost("server")).length).toBe(before);
  expect(api.closeTerminal).not.toHaveBeenCalled();
});

test("有前台进程：确认后关闭终端并移除标签", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: true })));
  const { pane } = await withTerm();
  const before = tabsIn(pane).length;
  await act(async () => {
    fireEvent.click(closeBtn());
  });
  await screen.findByText("关闭终端？");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "关闭终端" }));
  });
  await waitFor(() =>
    expect(tabsIn(paneByHost("server")).length).toBe(before - 1),
  );
  expect(api.closeTerminal).toHaveBeenCalledWith("tok", "t-1");
});

test("服务端关不掉终端：标签保留，不留孤儿", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1", { busy: false })));
  api.closeTerminal.mockResolvedValue(bad("server"));
  const { pane } = await withTerm();
  const before = tabsIn(pane).length;
  await act(async () => {
    fireEvent.click(closeBtn());
  });
  await waitFor(() => expect(api.closeTerminal).toHaveBeenCalled());
  expect(tabsIn(paneByHost("server")).length).toBe(before);
});

test("已结束（termEnded）或 404 的终端标签：不问也不杀，直接移除", async () => {
  api.getTerminal.mockResolvedValue(bad("not_found"));
  const { pane } = await withTerm("gone");
  const before = tabsIn(pane).length;
  await act(async () => {
    fireEvent.click(closeBtn());
  });
  await waitFor(() =>
    expect(tabsIn(paneByHost("server")).length).toBe(before - 1),
  );
  expect(api.closeTerminal).not.toHaveBeenCalled();
});

test("终端标签的 onManage 打开终端管理弹层，并列出服务端终端", async () => {
  api.listTerminals.mockResolvedValue(ok([status("t-1"), status("orphan")]));
  const { pane } = await withTerm();
  expect(screen.queryByText("终端管理")).toBeNull();
  await act(async () => {
    fireEvent.click(within(pane).getByRole("button", { name: "管理终端" }));
  });
  await screen.findByText("终端管理");
  await waitFor(() => expect(api.listTerminals).toHaveBeenCalled());
});

test("referencedTermIds：收集当前工作区所有窗口、窗格里的 termId", () => {
  const tab = (id: string, termId?: string): Tab => ({
    id,
    type: "term",
    ...(termId ? { termId } : {}),
  });
  const pane = (pid: string, tabs: Tab[]) => ({
    pid,
    host: "server",
    tabs,
    active: tabs[0]?.id ?? "",
  });
  const st: WindowState = {
    active: 0,
    list: [
      {
        id: "w1",
        focus: "p1",
        root: {
          dir: "row",
          sizes: [1, 1],
          children: [
            pane("p1", [tab("t1", "T1"), tab("t2")]),
            pane("p2", [tab("t3", "T3")]),
          ],
        },
      },
      { id: "w2", focus: "p3", root: pane("p3", [tab("t4", "T4")]) },
    ],
  };
  expect([...referencedTermIds(st)].sort()).toEqual(["T1", "T3", "T4"]);
});
