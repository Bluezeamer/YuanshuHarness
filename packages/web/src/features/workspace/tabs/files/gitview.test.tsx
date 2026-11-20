// 「版本」视图：只在 git 仓库里出现；显示分支与未提交改动；切分支前先问脏改动怎么处理。
// diff 视图由上层实现：这里只验证「点条目会把绝对路径交给打开 diff 的入口」。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearToasts } from "../../../../ui";
import { mount, q, qa } from "../../layout/harness";
import { getTabDef, registerTab } from "../registry";
import { GitView } from "./GitView";
import { filesTab, fmOf, resetSingletons, seedWorld } from "./harness";
import { registerFilesTab } from "./register";
import { gitWorld, world } from "./testkit";

vi.mock(
  "../../../../api/files",
  async () => (await import("./testkit")).fakeFilesApi,
);

vi.mock("../../../../api/git", async () => {
  const actual = await vi.importActual<typeof import("../../../../api/git")>(
    "../../../../api/git",
  );
  const { fakeGitApi } = await import("./testkit");
  // 只换取数的那三个；statusByPath / EMPTY_GIT 这类纯函数用真的
  return { ...actual, ...fakeGitApi };
});

const original = getTabDef("files");

beforeEach(() => {
  seedWorld();
  gitWorld.reset();
  registerFilesTab();
});
afterEach(() => {
  cleanup();
  clearToasts();
  resetSingletons();
  registerTab("files", original);
  vi.restoreAllMocks();
});

const openFiles = async () => {
  const mounted = await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  return { ...mounted, fm };
};

/** 工具条上的分支胶囊：只在 git 仓库里有，点它进 / 出版本视图 */
const chip = (fm: HTMLElement) => q(".ws-fm-branch", fm) as HTMLElement | null;

/** 点分支胶囊进「版本」视图 */
const openGitView = async () => {
  const mounted = await openFiles();
  const { fm } = mounted;
  await waitFor(() => expect(chip(fm)).toBeTruthy());
  fireEvent.click(chip(fm) as HTMLElement);
  await waitFor(() => expect(q(".ws-fm-gitview", fm)).toBeTruthy());
  return mounted;
};

const changeRows = (fm: HTMLElement) => qa(".ws-fm-grow", fm);
const rowAt = (fm: HTMLElement, abs: string) =>
  q(`.ws-fm-grow[data-path="${abs}"]`, fm) as HTMLElement;
const branchLabel = (fm: HTMLElement) => q(".ws-fm-gbranch", fm) as HTMLElement;

test("非 git 目录没有分支胶囊：保持原来的文件视图", async () => {
  const { fm } = await openFiles();
  // 目录不属于任何仓库时没有版本入口
  expect(chip(fm)).toBeNull();
  expect(q(".ws-fm-list", fm)).toBeTruthy();
});

test("git 目录多出「版本」：显示当前分支与按目录分组的变更文件", async () => {
  gitWorld.seedRepo({
    entries: [
      { path: "README.md", status: "modified" },
      { path: "src/index.ts", status: "added" },
    ],
  });
  const { fm } = await openFiles();
  await waitFor(() => expect(chip(fm)).toBeTruthy());
  // 胶囊上写着分支与未提交条数
  expect(chip(fm)?.textContent).toBe("master2");

  fireEvent.click(chip(fm) as HTMLElement);
  await waitFor(() => expect(q(".ws-fm-gitview", fm)).toBeTruthy());
  expect(chip(fm)?.getAttribute("aria-pressed")).toBe("true");

  expect(branchLabel(fm).textContent).toBe("master");
  // 文件列表让位给版本视图
  expect(q(".ws-fm-list", fm)).toBeNull();

  expect(
    changeRows(fm)
      .map((r) => r.dataset.path)
      .sort(),
  ).toEqual(["/w/README.md", "/w/src/index.ts"]);
  // 嵌套文件按仓库根相对路径分组显示：组头是目录，行里是文件名
  const dirs = qa(".ws-fm-gdir", fm).map((d) => d.textContent);
  expect(dirs).toEqual(["仓库根1", "src1"]);
  expect(rowAt(fm, "/w/src/index.ts").dataset.git).toBe("added");
  expect(
    rowAt(fm, "/w/src/index.ts").querySelector(".ws-fm-gstat")?.textContent,
  ).toBe("A");
  expect(world.calls.some((c) => c.startsWith("list local /w"))).toBe(true);
});

test("点变更文件把绝对路径交给 openDiff（turn 为 null 表示工作区）", async () => {
  gitWorld.seedRepo({
    entries: [{ path: "src/index.ts", status: "modified" }],
  });
  const { fm, store } = await openGitView();
  const spy = vi.spyOn(store, "openDiff");

  const main = q(".u-lrow-main", rowAt(fm, "/w/src/index.ts")) as HTMLElement;
  fireEvent.click(main);
  const [, tabId, turn, path] = spy.mock.calls[0] ?? [];
  expect({ tabId, turn, path }).toEqual({
    tabId: filesTab(store, "server").id,
    turn: null,
    path: "/w/src/index.ts",
  });
});

test("diff 入口没接线时条目禁用，并说明原因", async () => {
  // 直接渲染视图：注册表里注入的那个入口不传，模拟「上层还没接线」
  const git = {
    root: "/w",
    branch: "master",
    detached: false,
    entries: [{ path: "README.md", status: "modified" as const }],
    truncated: false,
  };
  render(
    <GitView
      env="local"
      sessionId="a"
      git={git}
      onOpenDiff={undefined}
      onChanged={() => {}}
    />,
  );
  const main = (await screen.findByText("README.md")).closest(
    ".u-lrow-main",
  ) as HTMLButtonElement;
  expect(main.disabled).toBe(true);
  expect(main.getAttribute("title")).toContain("diff 视图还没接上");
  // 点了也只是没反应，不会报错
  fireEvent.click(main);
});

test("脏工作区切分支：先给 stash / 携带 / 取消 三选一，选定后才发请求", async () => {
  gitWorld.seedRepo({
    locals: ["master", "feat/x"],
    entries: [{ path: "README.md", status: "modified" }],
  });
  const { fm } = await openGitView();

  // 分支菜单：当前分支打勾并置灰
  fireEvent.click(within(fm).getByRole("button", { name: "切换分支" }));
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((i) => i.textContent)).toEqual(["master ✓", "feat/x"]);
  expect((items[0] as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByRole("menuitem", { name: "feat/x" }));
  const dialog = await screen.findByRole("dialog");
  for (const label of ["取消", "暂存改动", "一起带走"])
    expect(within(dialog).getByRole("button", { name: label })).toBeTruthy();
  // 还没问完策略，一个切换请求都不该发出去
  expect(gitWorld.calls.filter((c) => c.startsWith("checkout"))).toEqual([]);

  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(gitWorld.calls.filter((c) => c.startsWith("checkout"))).toEqual([]);

  // 再来一次，这次选「一起带走」
  fireEvent.click(within(fm).getByRole("button", { name: "切换分支" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "feat/x" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "一起带走",
    }),
  );
  await waitFor(() =>
    expect(gitWorld.calls).toContain("checkout local /w feat/x carry"),
  );
  await waitFor(() => expect(branchLabel(fm).textContent).toBe("feat/x"));
});
