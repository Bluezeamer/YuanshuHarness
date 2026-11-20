import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BarSlotsProvider } from "./BarSlots";
import { HtmlInBrowser } from "./HtmlInBrowser";

const layout = vi.hoisted(() => ({
  state: { workspaceId: "w1" as string | null },
  openInBrowser: vi.fn(),
}));
const api = vi.hoisted(() => ({ openPage: vi.fn() }));
const ui = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("../../layoutContext", () => ({
  useLayoutStore: () => ({
    getState: () => layout.state,
    openInBrowser: layout.openInBrowser,
  }),
}));
vi.mock("../../../../api/browser", () => ({ openPage: api.openPage }));
vi.mock("../../../../ui", async (orig) => ({
  ...(await orig<typeof import("../../../../ui")>()),
  toast: ui.toast,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  layout.state.workspaceId = "w1";
});

const view = () => (
  <BarSlotsProvider value={{ lead: document.body, tail: null }}>
    <HtmlInBrowser host="server" path="/w/p.html" fromPid="p3" />
  </BarSlotsProvider>
);

test("点击：以「主机名:绝对路径」开页面，再让布局显示它（焦点跟过去）", async () => {
  api.openPage.mockResolvedValue({ ok: true, data: { page: { id: "pg1" } } });
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
  await waitFor(() =>
    expect(layout.openInBrowser).toHaveBeenCalledWith("p3", "pg1"),
  );
  expect(api.openPage).toHaveBeenCalledWith(null, "w1", "server:/w/p.html");
});

test("打开失败：用提示报服务端给的原因，不动布局", async () => {
  api.openPage.mockResolvedValue({
    ok: false,
    status: 409,
    message: "最多同时激活 12 个页面",
  });
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
  await waitFor(() =>
    expect(ui.toast).toHaveBeenCalledWith("最多同时激活 12 个页面", {
      tone: "danger",
    }),
  );
  expect(layout.openInBrowser).not.toHaveBeenCalled();
});

test("没有工作区时什么也不做", async () => {
  layout.state.workspaceId = null;
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
  expect(api.openPage).not.toHaveBeenCalled();
});
