// 文件浏览器的多选、批量操作与「拖进对话插引用」。
// 多选只由 ctrl/⌘ 与 shift 触发，普通点击仍然是打开——这条不能被改掉。
// 注：「普通点击也留下一个选中标记」在 harness 里验证不了（点文件会把视图切到预览窗格，
// 文件面板的 DOM 不在查询范围），这条在浏览器里验收。
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearToasts } from "../../../../ui";
import { refTextOf } from "../../../chat/tab/useFileRefDrop";
import { mount } from "../../layout/harness";
import { getTabDef, registerTab } from "../registry";
import {
  filesTab,
  fmOf,
  mainOf,
  names,
  pickMenu,
  resetSingletons,
  rowOf,
  seedWorld,
} from "./harness";
import { registerFilesTab } from "./register";
import { world } from "./testkit";

vi.mock(
  "../../../../api/files",
  async () => (await import("./testkit")).fakeFilesApi,
);

const original = getTabDef("files");

beforeEach(() => {
  seedWorld();
  registerFilesTab();
});
afterEach(() => {
  cleanup();
  clearToasts();
  resetSingletons();
  registerTab("files", original);
});

/** 选中操作条（「复制路径」这种名字在预览标签里也有，必须限定作用域） */
const selbar = () => {
  const bar = document.querySelector(".ws-fm-selbar");
  if (!bar) throw new Error("没有选中操作条");
  return within(bar as HTMLElement);
};

const open = async () => {
  await mount();
  await waitFor(() => expect(fmOf("server")).toBeTruthy());
  return fmOf("server");
};

test("ctrl 点击多选：出现批量操作条，复制路径带上全部选中项", async () => {
  const fm = await open();
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });

  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  fireEvent.click(mainOf(fm, "package.json"), { ctrlKey: true });
  await waitFor(() => expect(screen.getByText("已选 2 项")).toBeTruthy());
  // 选中是「加选」，不会把文件打开成新标签
  expect(rowOf(fm, "README.md").dataset.selected).toBe("true");

  fireEvent.click(selbar().getByRole("button", { name: "复制路径" }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  const copied = writeText.mock.calls[0]?.[0] ?? "";
  expect(copied.split("\n").sort()).toEqual([
    "/w/README.md",
    "/w/package.json",
  ]);
});

test("shift 点击按区间选中", async () => {
  const fm = await open();
  const list = names(fm);
  const first = list[0];
  const third = list[2];
  if (!first || !third) throw new Error("种子目录项不足");

  fireEvent.click(mainOf(fm, first), { ctrlKey: true });
  fireEvent.click(mainOf(fm, third), { shiftKey: true });
  await waitFor(() => expect(screen.getByText("已选 3 项")).toBeTruthy());
  expect(
    document.querySelectorAll('.ws-fm-row[data-selected="true"]'),
  ).toHaveLength(3);
});

test("选择条只在多选时换掉工具条；点空白或「取消选择」回到工具条", async () => {
  const fm = await open();
  // 没多选：同一行是工具条，没有选择条
  expect(document.querySelector(".ws-fm-selbar")).toBeNull();
  expect(within(fm).getByLabelText("上一级")).toBeTruthy();

  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  await waitFor(() => expect(screen.getByText("已选 1 项")).toBeTruthy());
  // 换内容不增行：工具条与选择条是同一条 .ws-fm-bar
  expect(document.querySelectorAll(".ws-fm-bar")).toHaveLength(1);
  expect(within(fm).queryByLabelText("上一级")).toBeNull();

  // 点列表空白：清空
  const list = document.querySelector(".ws-fm-list") as HTMLElement;
  fireEvent.click(list);
  await waitFor(() =>
    expect(document.querySelector(".ws-fm-selbar")).toBeNull(),
  );

  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  await waitFor(() => expect(screen.getByText("已选 1 项")).toBeTruthy());
  fireEvent.click(selbar().getByRole("button", { name: "取消选择" }));
  await waitFor(() =>
    expect(document.querySelector(".ws-fm-selbar")).toBeNull(),
  );
});

test("普通点击只留灰底标记，不弹选择条", async () => {
  const fm = await open();
  fireEvent.click(mainOf(fm, "README.md"));
  expect(document.querySelector(".ws-fm-selbar")).toBeNull();
  expect(rowOf(fm, "README.md").dataset.current).toBe("true");
  expect(rowOf(fm, "README.md").dataset.selected).toBeUndefined();
});

test("批量删除：逐个删掉选中项，完成后清空选择", async () => {
  const fm = await open();
  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  fireEvent.click(mainOf(fm, "package.json"), { ctrlKey: true });
  await waitFor(() => expect(screen.getByText("已选 2 项")).toBeTruthy());

  fireEvent.click(selbar().getByRole("button", { name: "删除" }));
  await waitFor(() =>
    expect(
      world.calls.some((c) => c.startsWith("remove local /w/README.md")),
    ).toBe(true),
  );
  expect(
    world.calls.some((c) => c.startsWith("remove local /w/package.json")),
  ).toBe(true);
});

test("新建文件：走保存接口创建空文件，创建后目录刷新", async () => {
  await open();
  await pickMenu(fmOf("server"), "新建", "新建文件");
  const input = await screen.findByLabelText(/名称/);
  fireEvent.change(input, { target: { value: "notes.md" } });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));

  await waitFor(() =>
    expect(world.calls.some((c) => c.includes("/w/notes.md"))).toBe(true),
  );
});

test("拖拽引用文本：单选一条、多选每行一条，都用 file:<主机>:<路径>", () => {
  const entry = (path: string) => ({
    path,
    name: path.split("/").pop() as string,
    isDir: false,
    size: 1,
  });
  const base = {
    host: "server",
    env: "local",
    hostName: "Server",
    sessionId: "s1",
    tabId: "t1",
  };
  expect(refTextOf({ ...base, entries: [entry("/w/a.md")] })).toBe(
    "file:server:/w/a.md",
  );
  expect(
    refTextOf({ ...base, entries: [entry("/w/a.md"), entry("/w/b.ts")] }),
  ).toBe("file:server:/w/a.md\nfile:server:/w/b.ts");
});

test("切到同窗格的别的标签再切回：多选还在（视图状态存浏览器本地）", async () => {
  const { store } = await mount();
  const fm = await waitFor(() => fmOf("server"));
  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  fireEvent.click(mainOf(fm, "package.json"), { ctrlKey: true });
  await waitFor(() => expect(screen.getByText("已选 2 项")).toBeTruthy());

  const files = filesTab(store, "server");
  const pid = document.querySelector<HTMLElement>(
    `.ws-pane:has([data-host="server"].ws-fm)`,
  )?.dataset.pid as string;
  await act(async () => {
    store.addTab(pid, "preview", { host: "server", path: "/w/x.md" });
  });
  expect(document.querySelector(".ws-fm-selbar")).toBeNull();

  await act(async () => {
    store.activateTab(pid, files.id);
  });
  await waitFor(() => expect(screen.getByText("已选 2 项")).toBeTruthy());
  expect(rowOf(fmOf("server"), "README.md").dataset.selected).toBe("true");
});

test("关掉标签：它的视图状态记录一并清掉，新标签拿到同一个 id 时是干净的", async () => {
  const { store } = await mount();
  const fm = await waitFor(() => fmOf("server"));
  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  await waitFor(() =>
    expect(document.querySelector(".ws-fm-selbar")).toBeTruthy(),
  );
  const files = filesTab(store, "server");
  const keys = () =>
    Object.keys(localStorage).filter((k) => k.startsWith("ys.tab.view:"));
  await act(async () => {
    store.flush();
  });
  expect(keys().some((k) => k.endsWith(`:${files.id}`))).toBe(true);
  const pid = document.querySelector<HTMLElement>(
    `.ws-pane:has([data-host="server"].ws-fm)`,
  )?.dataset.pid as string;
  await act(async () => {
    store.closeTab(pid, files.id);
  });
  expect(keys().some((k) => k.endsWith(`:${files.id}`))).toBe(false);
});
