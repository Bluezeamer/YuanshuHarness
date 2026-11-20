// 本机文件拖入文件浏览器（B40）：落点（当前目录 / 目录行 / 文件行）、同名三选、文件夹递归、失败汇总。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearToasts, ToastHost } from "../../../../ui";
import { getTabDef, registerTab } from "../registry";
import {
  mountBoth as both,
  calls,
  dropFiles,
  fmOf,
  listOf,
  names,
  overFiles,
  resetSingletons,
  rowOf,
  seedDndWorld,
} from "./harness";
import { registerFilesTab } from "./register";
import { world } from "./testkit";

vi.mock(
  "../../../../api/files",
  async () => (await import("./testkit")).fakeFilesApi,
);

const original = getTabDef("files");

beforeEach(() => {
  seedDndWorld();
  registerFilesTab();
  render(<ToastHost />);
});
afterEach(() => {
  cleanup();
  clearToasts();
  resetSingletons();
  registerTab("files", original);
});

// ── 落点 ──

test("拖到列表空白：高亮当前目录，落下去上传到当前目录并刷新列表", async () => {
  await both();
  const fm = fmOf("server");
  expect(overFiles(listOf(fm), { "notes.txt": "hello" })).toBe(true);
  expect(listOf(fm).dataset.dz).toBe("上传");

  dropFiles(listOf(fm), { "notes.txt": "hello" });
  await waitFor(() => expect(world.has("local", "/w/notes.txt")).toBe(true));
  expect(calls("upload")).toEqual([
    expect.stringContaining("upload local /w/notes.txt 5B"),
  ]);
  // 不覆盖也不建目录：普通上传不该带 overwrite，也不该有 mkdir
  expect(calls("upload")[0]).not.toContain("overwrite");
  expect(calls("mkdir")).toEqual([]);
  // 结束后目录重取，新文件出现在列表里
  await within(fmOf("server")).findByText("notes.txt");
  // 落点标记随落下清掉
  expect(listOf(fmOf("server")).dataset.dz).toBeUndefined();
});

test("拖到子目录行：高亮那一行，上传到该目录而不是当前目录", async () => {
  await both();
  const fm = fmOf("server");
  expect(overFiles(rowOf(fm, "docs"), { "a.txt": "x" })).toBe(true);
  expect(rowOf(fm, "docs").dataset.dz).toBe("上传");
  expect(listOf(fm).dataset.dz).toBeUndefined();

  dropFiles(rowOf(fm, "docs"), { "a.txt": "x" });
  await waitFor(() => expect(world.has("local", "/w/docs/a.txt")).toBe(true));
  expect(world.has("local", "/w/a.txt")).toBe(false);
  // 新文件在别的目录，当前目录不刷新出新行
  expect(names(fmOf("server"))).not.toContain("a.txt");
});

test("拖到文件行：按资源管理器的手感落到当前目录，不是拒绝", async () => {
  await both();
  const fm = fmOf("server");
  expect(overFiles(rowOf(fm, "README.md"), { "b.txt": "bb" })).toBe(true);
  // 落到文件行时高亮的是列表（当前目录），行本身不标
  expect(listOf(fm).dataset.dz).toBe("上传");
  expect(rowOf(fm, "README.md").dataset.dz).toBeUndefined();

  dropFiles(rowOf(fm, "README.md"), { "b.txt": "bb" });
  await waitFor(() => expect(world.has("local", "/w/b.txt")).toBe(true));
  expect(world.has("local", "/w/README.md/b.txt")).toBe(false);
});

test("拖到另一台主机的目录行：文件写进那台主机", async () => {
  await both();
  const gpu = fmOf("gpu");
  dropFiles(rowOf(gpu, "docs"), { "g.txt": "ggg" });
  await waitFor(() => expect(world.has("gpu", "/g/docs/g.txt")).toBe(true));
  expect(world.has("local", "/w/docs/g.txt")).toBe(false);
});

// ── 同名冲突 ──

test("同名冲突先问用户：弹窗三选，选覆盖才写进去（带 overwrite）", async () => {
  await both();
  const fm = fmOf("server");
  dropFiles(listOf(fm), { "README.md": "new" });

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("已存在同名文件")).toBeTruthy();
  expect(within(dialog).getByText("README.md")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "跳过" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "重命名" })).toBeTruthy();
  // 还没选之前一个字节都不写
  expect(calls("upload")).toEqual([]);

  fireEvent.click(within(dialog).getByRole("button", { name: "覆盖" }));
  await waitFor(() => expect(calls("upload")).toHaveLength(1));
  expect(calls("upload")[0]).toContain(
    "upload local /w/README.md 3B overwrite",
  );
  expect(world.node("local", "/w/README.md")).toEqual({
    type: "file",
    size: 3,
  });
  await screen.findByText(/已上传 1 个文件到 \/w/);
});

test("同名冲突选跳过：不写文件，提示跳过数量", async () => {
  await both();
  dropFiles(listOf(fmOf("server")), { "README.md": "new" });
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "跳过" }));
  await screen.findByText(/跳过 1 项/);
  expect(calls("upload")).toEqual([]);
  expect(world.node("local", "/w/README.md")).toEqual({
    type: "file",
    size: 120,
  });
});

test("同名冲突选重命名：自动加 (2)，原文件不动，批量上传时一次问完整批", async () => {
  await both();
  const fm = fmOf("server");
  // 一次拖两个都撞名的文件：只弹一次窗，按钮是「全部…」
  dropFiles(listOf(fm), { "README.md": "new", "package.json": "{}" });
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("2 个同名文件已存在")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "全部重命名" }),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "覆盖全部" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "跳过全部" })).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "全部重命名" }));
  await waitFor(() =>
    expect(world.has("local", "/w/README (2).md")).toBe(true),
  );
  expect(world.has("local", "/w/package (2).json")).toBe(true);
  expect(world.node("local", "/w/README.md")).toEqual({
    type: "file",
    size: 120,
  });
  await screen.findByText(/2 项重名已改名/);
});

test("同名冲突弹窗取消：整批都不写", async () => {
  await both();
  dropFiles(listOf(fmOf("server")), { "README.md": "new" });
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls("upload")).toEqual([]);
});

// ── 文件夹 ──

test("拖入文件夹：递归建目录并按相对路径逐个上传", async () => {
  await both();
  const fm = fmOf("server");
  dropFiles(listOf(fm), {
    proj: { "a.txt": "aa", sub: { "b.txt": "bbb" } },
  });

  await waitFor(() =>
    expect(world.has("local", "/w/proj/sub/b.txt")).toBe(true),
  );
  expect(world.has("local", "/w/proj/a.txt")).toBe(true);
  expect(world.node("local", "/w/proj")).toEqual({ type: "dir" });
  expect(world.node("local", "/w/proj/sub")).toEqual({ type: "dir" });
  // 先建目录再写文件，父目录先于子目录
  const order = world.calls.filter(
    (c) => c.startsWith("mkdir") || c.startsWith("upload"),
  );
  expect(order).toEqual([
    "mkdir local /w/proj",
    "mkdir local /w/proj/sub",
    expect.stringContaining("upload local /w/proj/a.txt 2B"),
    expect.stringContaining("upload local /w/proj/sub/b.txt 3B"),
  ]);
  await screen.findByText(/已上传 2 个文件到 \/w/);
});

test("文件夹里的文件撞名也算冲突：弹窗按相对路径列出", async () => {
  world.seed("local", { "/w/proj/a.txt": 1 });
  await both();
  dropFiles(listOf(fmOf("server")), { proj: { "a.txt": "aa" } });
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("proj/a.txt")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "重命名" }));
  await waitFor(() =>
    expect(world.has("local", "/w/proj/a (2).txt")).toBe(true),
  );
  expect(world.node("local", "/w/proj/a.txt")).toEqual({
    type: "file",
    size: 1,
  });
});

// ── 失败与权限 ──

test("上传失败汇总提示：成功的照写，失败的把原因说出来", async () => {
  world.uploadFail.set("local:/w/bad.txt", "forbidden");
  await both();
  dropFiles(listOf(fmOf("server")), { "bad.txt": "x", "good.txt": "yy" });

  await screen.findByText(/1 个文件已上传，1 个失败/);
  // 失败原因同时出现在 toast 与作业卡片里，两处都算对
  expect(screen.getAllByText(/没有权限写入这个目录/).length).toBeGreaterThan(0);
  expect(world.has("local", "/w/good.txt")).toBe(true);
  expect(world.has("local", "/w/bad.txt")).toBe(false);
});

test("目标目录不可写：写文件被拒时明确报错，不假装成功", async () => {
  await both();
  const fm = fmOf("server");
  world.uploadFail.set("local:/w/ro/a.txt", "forbidden");
  world.uploadFail.set("local:/w/ro/b.txt", "forbidden");
  dropFiles(listOf(fm), { ro: { "a.txt": "a", "b.txt": "b" } });

  await screen.findByText(/0 个文件已上传，2 个失败/);
  expect(screen.getAllByText(/没有权限写入这个目录/).length).toBeGreaterThan(0);
  expect(world.has("local", "/w/ro/a.txt")).toBe(false);
});

test("目录建不出来：整批直接报错，不再逐个文件白跑", async () => {
  world.mkdirFail.set("local:/w/ro", "forbidden");
  await both();
  dropFiles(listOf(fmOf("server")), { ro: { "a.txt": "a", "b.txt": "b" } });

  await screen.findByText(/0 个文件已上传，2 个失败/);
  // 父目录建失败后不再往它下面写文件
  expect(calls("upload")).toEqual([]);
  expect(world.has("local", "/w/ro")).toBe(false);
});

test("上传期间在共用作业卡片里显示进度，结束后变成结果并自动收起", async () => {
  await both();
  let release: () => void = () => {};
  world.uploadGate = new Promise<void>((r) => {
    release = r;
  });
  dropFiles(listOf(fmOf("server")), { "slow.txt": "zz" });

  // 与主机间互传共用同一套作业卡片（.ws-xfer），不再另造进度组件
  await screen.findByText("上传到 Server");
  expect(screen.getByText(/0\/1 个文件|1\/1 个文件/)).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "进度" })).toBeTruthy();
  world.uploadGate = null;
  release();
  // 传完先变成结果卡片，随后自动收起，不留一条常驻的假状态
  await screen.findByText("已上传到 Server");
  await waitFor(() => expect(screen.queryByText("已上传到 Server")).toBeNull());
  expect(world.has("local", "/w/slow.txt")).toBe(true);
});

test("拖进来的不是文件（没有可读条目）时给提示，不发请求", async () => {
  await both();
  dropFiles(listOf(fmOf("server")), {});
  await screen.findByText("没有找到可上传的文件");
  expect(calls("upload")).toEqual([]);
  expect(calls("mkdir")).toEqual([]);
});

test("并发上传：多个文件同时在飞，不是逐个等", async () => {
  await both();
  // 用一个不放行的闸门卡住所有上传，观察并发进来的请求数
  let release: () => void = () => {};
  world.uploadGate = new Promise<void>((r) => {
    release = r;
  });
  dropFiles(listOf(fmOf("server")), {
    "a.txt": "1",
    "b.txt": "2",
    "c.txt": "3",
    "d.txt": "4",
    "e.txt": "5",
  });
  // 串行实现下这里只会看到 1 个请求；并发实现应当一次进 4 个（上限 UPLOAD_CONCURRENCY）
  await waitFor(() => expect(world.uploading).toBeGreaterThan(1));
  world.uploadGate = null;
  release();
  await screen.findByText(/已上传到 Server/);
});
