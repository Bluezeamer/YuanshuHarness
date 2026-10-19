import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import { saveToken } from "../api";
import { type Fs, installApi, installFs } from "../fakes";
import { type DirChoice, DirPicker } from "./DirPicker";

let fs: Fs;
let onChange: Mock<(c: DirChoice | null) => void>;
beforeEach(() => {
  sessionStorage.clear();
  saveToken("tok");
  installApi([]);
  fs = installFs();
  onChange = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (jump?: { path: string }) =>
  render(
    <DirPicker jump={jump} onChange={onChange} onUnauthorized={() => {}} />,
  );
const list = () => screen.findByRole("list", { name: "子目录" });
const enter = async (name: string) =>
  fireEvent.click(within(await list()).getByRole("button", { name }));
const crumbs = () => screen.getByRole("navigation", { name: "路径" });

test("缺省从 home 开始，显示本机，并把可用目录交给父组件", async () => {
  show();
  await list();
  expect(screen.getByText("本机")).toBeTruthy();
  expect(crumbs().textContent).toContain("u");
  expect(screen.getByRole("status").textContent).toContain("可读写");
  expect(onChange).toHaveBeenLastCalledWith({
    path: "/home/u",
    usable: true,
  });
});

test("点目录进入，点面包屑上溯", async () => {
  show();
  await enter("proj");
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith({
      path: "/home/u/proj",
      usable: true,
    }),
  );
  fireEvent.click(within(crumbs()).getByRole("button", { name: "home" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith({ path: "/home", usable: true }),
  );
  expect(fs.calls.at(-1)).toContain("path=%2Fhome");
});

test("点目录默认隐藏，开关后带 hidden=1 并显示", async () => {
  show();
  const l = await list();
  expect(within(l).queryByRole("button", { name: ".cache" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "显示隐藏目录" }));
  await waitFor(() => expect(fs.calls.at(-1)).toContain("hidden=1"));
  expect(
    within(await list()).getByRole("button", { name: ".cache" }),
  ).toBeTruthy();
});

test("只读与不可读用文字标明，且 usable 为假", async () => {
  show({ path: "/home/u/proj/ro" });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("只读"),
  );
  expect(onChange).toHaveBeenLastCalledWith({
    path: "/home/u/proj/ro",
    usable: false,
  });
  cleanup();
  show({ path: "/home/u/proj/locked" });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("不可读"),
  );
  expect(onChange).toHaveBeenLastCalledWith({
    path: "/home/u/proj/locked",
    usable: false,
  });
});

test("截断时提示只显示了一部分", async () => {
  show({ path: "/big" });
  await screen.findByText(/仅显示前/);
});

test("空目录有提示", async () => {
  show({ path: "/home/u/empty" });
  await screen.findByText("没有子目录");
});

test("失败可重试；失败期间不给父组件可用目录", async () => {
  fs.failNext = 500;
  show();
  expect((await screen.findByRole("alert")).textContent).toContain("Server");
  expect(onChange).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await list();
  expect(onChange).toHaveBeenLastCalledWith({ path: "/home/u", usable: true });
});

test("目录不存在时提示并可重试", async () => {
  show({ path: "/nope" });
  expect((await screen.findByRole("alert")).textContent).toContain("不存在");
});
