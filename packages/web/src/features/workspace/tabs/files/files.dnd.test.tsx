// 文件拖拽（同主机移动、落点、拒绝规则）。迁移自 mock 的 tests/fm.smoke.cjs，对照见各用例的 [fm#n]。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearToasts, ToastHost } from "../../../../ui";
import {
  dragEnd,
  dragStart,
  drop,
  over,
  paneByHost,
  q,
} from "../../layout/harness";
import { getTabDef, registerTab } from "../registry";
import {
  mountBoth as both,
  calls,
  crumbOf,
  dragOnto,
  filesTab,
  fmOf,
  ghost,
  listOf,
  mainOf,
  names,
  resetSingletons,
  rowOf,
  seedDndWorld,
  strip,
  tabsOf,
} from "./harness";
import { registerFilesTab } from "./register";
import { world } from "./testkit";

vi.mock(
  "../../../../api/files",
  async () => (await import("./testkit")).fakeFilesApi,
);
const audit = vi.hoisted(() => ({ reportAudit: vi.fn() }));
vi.mock("../../../../api/audit", () => audit);

const original = getTabDef("files");

beforeEach(() => {
  seedDndWorld();
  registerFilesTab();
  audit.reportAudit.mockReset();
  render(<ToastHost />);
});
afterEach(() => {
  cleanup();
  clearToasts();
  resetSingletons();
  registerTab("files", original);
});

// ── 结构 ──

test("[fm#2,3] 默认会话有两个不同主机的文件管理器", async () => {
  await both();
  expect(fmOf("server").dataset.host).toBe("server");
  expect(fmOf("gpu").dataset.host).toBe("gpu");
});

test("[fm#4] 文件行可拖动，且不是 button 元素（避免与窗格拖拽抢手势）", async () => {
  await both();
  const row = rowOf(fmOf("server"), "README.md");
  expect(row.getAttribute("draggable")).toBe("true");
  expect(row.tagName).toBe("DIV");
  // 行主体是标准列表行的按钮；可拖的是外层 div（会话行同做法）
  const main = mainOf(fmOf("server"), "README.md");
  expect(main.tagName).toBe("BUTTON");
});

test("[fm#5,6] 两台主机各自独立；主机色点跟随窗格主机", async () => {
  await both();
  expect(names(fmOf("server"))).toContain("src");
  expect(names(fmOf("gpu"))).toContain("train.py");
  expect(names(fmOf("gpu"))).not.toContain("src");
  for (const h of ["server", "gpu"]) {
    // 主机色由窗格以 --tone 传入，文件标签里的落点描边引用它
    expect(paneByHost(h).style.getPropertyValue("--tone")).toMatch(/--h[1-6]/);
  }
});

// ── 幽灵与落点标记 ──

test("[fm#7] 拖动时出现幽灵条（带条目名），结束时收起，源行恢复", async () => {
  await both();
  const row = rowOf(fmOf("server"), "package.json");
  dragStart(row);
  expect(ghost()).toBeTruthy();
  expect(ghost()?.querySelector(".ws-xg-name")?.textContent).toBe(
    "package.json",
  );
  expect(row.dataset.dragging).toBe("true");
  dragEnd(row);
  expect(ghost()).toBeNull();
  expect(row.dataset.dragging).toBeUndefined();
});

test("[fm#8] 悬停目标目录行出现「移动」标记，结束后清掉", async () => {
  await both();
  const fm = fmOf("server");
  const docs = rowOf(fm, "docs");
  const src = rowOf(fm, "package.json");
  dragStart(src);
  expect(over(docs, 10, 10)).toBe(true);
  expect(docs.dataset.dz).toBe("移动");
  dragEnd(src);
  expect(docs.dataset.dz).toBeUndefined();
});

test("落点：跨主机写「传输」、同主机写「移动」（同一套描边，不换色）；幽灵条写明判定", async () => {
  await both();
  dragStart(rowOf(fmOf("server"), "package.json"));
  over(rowOf(fmOf("gpu"), "docs"), 10, 10);
  const target = rowOf(fmOf("gpu"), "docs");
  expect(target.dataset.dz).toBe("传输");
  expect(ghost()?.querySelector(".ws-xg-to")?.textContent).toBe(
    "→ GPU 机:/g/docs",
  );
  // 移到同主机的目录行：换成「移动」
  over(rowOf(fmOf("server"), "docs"), 10, 10);
  expect(target.dataset.dz).toBeUndefined();
  expect(rowOf(fmOf("server"), "docs").dataset.dz).toBe("移动");
  expect(ghost()?.querySelector(".ws-xg-to")?.textContent).toBe(
    "移动到 Server:/w/docs",
  );
});

test("落点优先级：目录行 > 面包屑项 > 列表空白（当前目录）", async () => {
  await both();
  const fm = fmOf("server");
  dragStart(rowOf(fm, "package.json"));

  over(rowOf(fm, "docs"), 10, 10);
  expect(rowOf(fm, "docs").dataset.dz).toBe("移动");
  expect(listOf(fm).dataset.dz).toBeUndefined();

  over(crumbOf(fm, "/"), 10, 10);
  expect(crumbOf(fm, "/").dataset.dz).toBe("移动");
  expect(rowOf(fm, "docs").dataset.dz).toBeUndefined();

  // 当前目录的面包屑段与列表空白：已在目标目录，拒绝且不给底纹
  over(crumbOf(fm, "/w"), 10, 10);
  expect(crumbOf(fm, "/w").dataset.dz).toBeUndefined();
  over(listOf(fm), 10, 10);
  expect(listOf(fm).dataset.dz).toBeUndefined();

  // 跨主机时列表空白 = 对方的当前目录，可以落
  over(listOf(fmOf("gpu")), 10, 10);
  expect(listOf(fmOf("gpu")).dataset.dz).toBe("传输");
});

test("文件拖拽不和窗格/标签拖放冲突：悬停在窗格上不出落点，drop 也不改布局", async () => {
  const { store } = await both();
  const layout = () => JSON.stringify(store.getState().doc.windows);
  const before = layout();
  dragStart(rowOf(fmOf("server"), "package.json"));
  const pane = paneByHost("gpu");
  expect(over(pane, 10, 10)).toBe(false);
  expect(pane.dataset.dz).toBeUndefined();
  drop(pane, 10, 10);
  expect(layout()).toBe(before);
  // 反过来：拖标签时文件管理器的行也不接（它们没有文件拖拽物）
  dragEnd(rowOf(fmOf("server"), "package.json"));
});

// ── 拒绝规则与文案 ──

test("[fm#15] 拖到自身被拒绝：不给底纹，幽灵条写「不能移入自身」，数据不变", async () => {
  await both();
  const fm = fmOf("server");
  const before = names(fm).join(",");
  const src = rowOf(fm, "src");
  dragStart(src);
  expect(over(src, 10, 10)).toBe(true);
  expect(src.dataset.dz).toBeUndefined();
  expect(ghost()?.querySelector(".ws-xg-to")?.textContent).toBe("不能移入自身");
  expect(ghost()?.dataset.bad).toBe("true");
  drop(src, 10, 10);
  expect(await screen.findByText("不能移入自身")).toBeTruthy();
  expect(calls("rename")).toHaveLength(0);
  expect(names(fmOf("server")).join(",")).toBe(before);
});

test("[fm#16,17] 拖到当前目录被拒绝（已在目标目录），不出传输条", async () => {
  await both();
  const fm = fmOf("server");
  const before = names(fm).join(",");
  const row = rowOf(fm, "package.json");
  dragStart(row);
  over(listOf(fm), 10, 10);
  expect(ghost()?.querySelector(".ws-xg-to")?.textContent).toBe("已在目标目录");
  expect(listOf(fm).dataset.dz).toBeUndefined();
  drop(listOf(fm), 10, 10);
  expect(await screen.findByText("已在目标目录")).toBeTruthy();
  expect(calls("rename")).toHaveLength(0);
  expect(strip()).toBeNull();
  expect(names(fmOf("server")).join(",")).toBe(before);
});

test("文件行不是落点：悬停写明原因、不给底纹，drop 不执行", async () => {
  await both();
  const fm = fmOf("server");
  dragStart(rowOf(fm, "package.json"));
  const target = rowOf(fm, "README.md");
  over(target, 10, 10);
  expect(target.dataset.dz).toBeUndefined();
  expect(ghost()?.querySelector(".ws-xg-to")?.textContent).toBe(
    "文件不能作为目标",
  );
  drop(target, 10, 10);
  expect(await screen.findByText("文件不能作为目标")).toBeTruthy();
  expect(calls("rename")).toHaveLength(0);
});

test("Esc 取消拖拽：幽灵与标记立即消失，之后的 drop 是空操作", async () => {
  await both();
  const fm = fmOf("server");
  const row = rowOf(fm, "package.json");
  dragStart(row);
  over(rowOf(fm, "docs"), 10, 10);
  expect(rowOf(fm, "docs").dataset.dz).toBe("移动");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(ghost()).toBeNull();
  expect(rowOf(fm, "docs").dataset.dz).toBeUndefined();
  drop(rowOf(fm, "docs"), 10, 10);
  expect(calls("rename")).toHaveLength(0);
});

// ── 同主机：移动 ──

test("[fm#12,13] 同主机拖到目录行 = 移动：源消失、目标出现，toast 反馈，不写审计", async () => {
  const { store } = await both();
  const fm = fmOf("server");
  dragOnto(rowOf(fm, "README.md"), rowOf(fm, "docs"));
  await waitFor(() =>
    expect(world.has("local", "/w/docs/README.md")).toBe(true),
  );
  expect(world.has("local", "/w/README.md")).toBe(false);
  await waitFor(() => expect(names(fmOf("server"))).not.toContain("README.md"));
  expect(await screen.findByText(/已移动 README\.md/)).toBeTruthy();

  // 进 docs 能看到它
  fireEvent.click(mainOf(fmOf("server"), "docs"));
  await within(fmOf("server")).findByText("README.md");
  expect(filesTab(store, "server").cwd).toBe("/w/docs");

  // 不写调用审计：不走 UI 上报，请求也不挂到会话（sessionId 为 null）
  expect(audit.reportAudit).not.toHaveBeenCalled();
  expect(calls("rename")).toEqual([
    "rename local /w/README.md /w/docs/README.md sid=null",
  ]);
});

test("多选拖拽：幽灵条带 +N，整批一起移动，各自落到目标目录", async () => {
  await both();
  const fm = fmOf("server");
  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  fireEvent.click(mainOf(fm, "package.json"), { ctrlKey: true });
  dragStart(rowOf(fm, "README.md"));
  expect(ghost()?.querySelector(".ws-xg-name")?.textContent).toBe("README.md");
  expect(ghost()?.querySelector(".ws-xg-n")?.textContent).toBe("+1");
  expect(rowOf(fm, "package.json").dataset.dragging).toBe("true");
  over(rowOf(fm, "docs"), 10, 10);
  drop(rowOf(fm, "docs"), 10, 10);
  await waitFor(() => {
    expect(world.has("local", "/w/docs/README.md")).toBe(true);
    expect(world.has("local", "/w/docs/package.json")).toBe(true);
  });
  expect(world.has("local", "/w/README.md")).toBe(false);
  expect(world.has("local", "/w/package.json")).toBe(false);
  expect(await screen.findByText(/已移动 2 项 → \/w\/docs/)).toBeTruthy();
  expect(calls("rename")).toHaveLength(2);
});

test("多选拖拽：批量里落不下去的（目录进自身）跳过，其余照常移动", async () => {
  await both();
  const fm = fmOf("server");
  fireEvent.click(mainOf(fm, "docs"), { ctrlKey: true });
  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  dragStart(rowOf(fm, "README.md"));
  over(rowOf(fm, "docs"), 10, 10);
  // 整批里还有能落的，所以不拒绝
  expect(rowOf(fm, "docs").dataset.dz).toBe("移动");
  drop(rowOf(fm, "docs"), 10, 10);
  await waitFor(() =>
    expect(world.has("local", "/w/docs/README.md")).toBe(true),
  );
  expect(calls("rename")).toEqual([
    "rename local /w/README.md /w/docs/README.md sid=null",
  ]);
});

test("多选拖拽：整批都落不下去才拒绝", async () => {
  await both();
  const fm = fmOf("server");
  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  fireEvent.click(mainOf(fm, "package.json"), { ctrlKey: true });
  dragStart(rowOf(fm, "README.md"));
  over(listOf(fm), 10, 10);
  expect(ghost()?.querySelector(".ws-xg-to")?.textContent).toBe("已在目标目录");
  expect(listOf(fm).dataset.dz).toBeUndefined();
});

test("拖的不是选中项：只带这一行，不带选中的", async () => {
  await both();
  const fm = fmOf("server");
  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  fireEvent.click(mainOf(fm, "package.json"), { ctrlKey: true });
  dragOnto(rowOf(fm, "src"), rowOf(fm, "docs"));
  await waitFor(() => expect(world.has("local", "/w/docs/src")).toBe(true));
  expect(calls("rename")).toHaveLength(1);
  expect(world.has("local", "/w/README.md")).toBe(true);
});

test("[fm#14] 移动是移动不是复制：另一台主机不受影响", async () => {
  await both();
  const fm = fmOf("server");
  dragOnto(rowOf(fm, "README.md"), rowOf(fm, "docs"));
  await waitFor(() =>
    expect(world.has("local", "/w/docs/README.md")).toBe(true),
  );
  expect(world.has("gpu", "/g/README.md")).toBe(true);
  expect(names(fmOf("gpu"))).toContain("README.md");
});

test("同主机移动：重名文件自动加 (2)/(3)，保留扩展名，提示 N 项重名已改名", async () => {
  world.seed("local", { "/w/docs/README.md": 1, "/w/docs/README (2).md": 1 });
  await both();
  const fm = fmOf("server");
  dragOnto(rowOf(fm, "README.md"), rowOf(fm, "docs"));
  await waitFor(() =>
    expect(world.has("local", "/w/docs/README (3).md")).toBe(true),
  );
  expect(world.has("local", "/w/docs/README.md")).toBe(true);
  expect(await screen.findByText(/1 项重名已改名/)).toBeTruthy();
});

test("同主机移动：目录按 cp -r 合并，同名文件改名，源目录搬空后删除", async () => {
  world.seed("local", { "/w/docs/src/index.ts": 7, "/w/docs/src/keep.ts": 8 });
  await both();
  const fm = fmOf("server");
  dragOnto(rowOf(fm, "src"), rowOf(fm, "docs"));
  await waitFor(() => expect(world.has("local", "/w/src")).toBe(false));
  expect(world.names("local", "/w/docs/src")).toEqual([
    "auth",
    "index (2).ts",
    "index.ts",
    "keep.ts",
  ]);
  expect(await screen.findByText(/1 项重名已改名/)).toBeTruthy();
});

test("同主机移动失败时提示原因并刷新列表，不假装成功", async () => {
  await both();
  const fm = fmOf("server");
  world.listFail.set("local:/w/docs", "forbidden");
  // 同名文件存在才会列目标目录；这里制造一个需要列目录的场景
  world.seed("local", { "/w/docs/README.md": 1 });
  dragOnto(rowOf(fm, "README.md"), rowOf(fm, "docs"));
  expect(await screen.findByText("没有权限读取这个目录")).toBeTruthy();
  expect(world.has("local", "/w/README.md")).toBe(true);
});

test("[fm#18] 移动后已打开的预览标签跟着新路径走，旧路径的预览不再存在", async () => {
  const { store } = await both();
  const fm = fmOf("server");
  fireEvent.click(mainOf(fm, "package.json"));
  expect(
    tabsOf(store)
      .filter((t) => t.type === "preview")
      .map((t) => t.path),
  ).toEqual(["/w/package.json"]);
  // 预览与文件管理器同窗格时，回到文件标签再拖
  const pane = paneByHost("server");
  await act(async () => {
    fireEvent.click(within(pane).getByRole("tab", { name: /^文件/ }));
  });
  dragOnto(
    rowOf(fmOf("server"), "package.json"),
    rowOf(fmOf("server"), "docs"),
  );
  await waitFor(() =>
    expect(
      tabsOf(store)
        .filter((t) => t.type === "preview")
        .map((t) => t.path),
    ).toEqual(["/w/docs/package.json"]),
  );
});

test("移动目录时，其下已打开的预览标签按子树改写到新路径", async () => {
  const { store } = await both();
  const previews = () =>
    tabsOf(store)
      .filter((t) => t.type === "preview")
      .map((t) => t.path);
  fireEvent.click(mainOf(fmOf("server"), "src"));
  await within(fmOf("server")).findByText("index.ts");
  fireEvent.click(mainOf(fmOf("server"), "index.ts"));
  expect(previews()).toEqual(["/w/src/index.ts"]);
  // 回到文件标签，退到 /w 再把整个 src 拖进 docs
  const pane = paneByHost("server");
  await act(async () => {
    fireEvent.click(within(pane).getByRole("tab", { name: /^文件/ }));
  });
  fireEvent.click(crumbOf(fmOf("server"), "/w"));
  await within(fmOf("server")).findByText("README.md");
  dragOnto(rowOf(fmOf("server"), "src"), rowOf(fmOf("server"), "docs"));
  await waitFor(() => expect(previews()).toEqual(["/w/docs/src/index.ts"]));
});
