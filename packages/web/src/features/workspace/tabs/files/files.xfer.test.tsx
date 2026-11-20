// 跨主机传输（传输条、重名、目录合并、一次一个）。迁移自 mock 的 tests/fm.smoke.cjs，对照见各用例的 [fm#n]。
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
import { q, qa } from "../../layout/harness";
import { getTabDef, registerTab } from "../registry";
import {
  mountBoth as both,
  calls,
  crumbOf,
  dragOnto,
  filesTab,
  fmOf,
  listOf,
  mainOf,
  names,
  resetSingletons,
  rowOf,
  seedDndWorld,
  strip,
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

// ── 跨主机：传输 ──

test("[fm#9] 跨主机拖拽走传输：先出传输条（不落盘），完成才出现在目标主机，源保留", async () => {
  await both();
  const gpuList = listOf(fmOf("gpu"));
  dragOnto(rowOf(fmOf("server"), "package.json"), gpuList);
  await waitFor(() => expect(strip()).toBeTruthy());
  const bar = strip() as HTMLElement;
  expect(bar.querySelector(".ws-xfer-t")?.textContent).toBe("传输到 GPU 机");
  expect(bar.querySelector(".ws-xfer-n")?.textContent).toBe("1 个文件 · 80 B");

  // 结束之前目标主机上什么都没有
  await waitFor(() => expect(calls("transfer")).toHaveLength(1));
  expect(calls("transfer")[0]).toBe(
    "transfer local:/w/package.json gpu:/g/package.json sid=null",
  );
  expect(world.has("gpu", "/g/package.json")).toBe(false);
  expect(names(fmOf("gpu"))).not.toContain("package.json");

  // 进度跟着任务走
  const id = world.lastJob()?.id as string;
  world.progress(id, 0, 40);
  await waitFor(() =>
    expect(
      q('[role="progressbar"]', strip() as HTMLElement)?.getAttribute(
        "aria-valuenow",
      ),
    ).toBe("50"),
  );

  world.finishJob(id);
  await waitFor(() =>
    expect(strip()?.querySelector(".ws-xfer-t")?.textContent).toBe(
      "已传输到 GPU 机",
    ),
  );
  expect(strip()?.dataset.phase).toBe("done");
  await waitFor(() => expect(names(fmOf("gpu"))).toContain("package.json"));
  // 源保留
  expect(world.has("local", "/w/package.json")).toBe(true);
  expect(names(fmOf("server"))).toContain("package.json");
  // 不写审计
  expect(audit.reportAudit).not.toHaveBeenCalled();
});

test("多选拖拽跨主机：逐项各起一个传输任务，重名各自改名，提示「N 项」", async () => {
  world.autoFinish = true;
  await both();
  const fm = fmOf("server");
  fireEvent.click(mainOf(fm, "README.md"), { ctrlKey: true });
  fireEvent.click(mainOf(fm, "package.json"), { ctrlKey: true });
  dragOnto(rowOf(fm, "README.md"), listOf(fmOf("gpu")));
  await waitFor(() => expect(world.has("gpu", "/g/package.json")).toBe(true));
  expect(world.has("gpu", "/g/README (2).md")).toBe(true);
  expect(calls("transfer")).toEqual([
    "transfer local:/w/README.md gpu:/g/README (2).md sid=null",
    "transfer local:/w/package.json gpu:/g/package.json sid=null",
  ]);
  expect(await screen.findByText(/已传输 2 项/)).toBeTruthy();
  // 源保留
  expect(world.has("local", "/w/README.md")).toBe(true);
});

test("[fm#10] 跨主机传输重名自动改名，不覆盖目标已有文件", async () => {
  world.autoFinish = true;
  await both();
  dragOnto(rowOf(fmOf("server"), "README.md"), listOf(fmOf("gpu")));
  await waitFor(() => expect(names(fmOf("gpu"))).toContain("README (2).md"));
  expect(names(fmOf("gpu"))).toContain("README.md");
  expect(world.node("gpu", "/g/README.md")).toEqual({ type: "file", size: 50 });
  expect(calls("transfer")[0]).toContain("gpu:/g/README (2).md");
  expect(await screen.findByText(/1 项重名已改名/)).toBeTruthy();
});

test("[fm#11] 目录整体传输：子树一并过去，落在目标主机的目录行里", async () => {
  world.autoFinish = true;
  await both();
  fireEvent.click(mainOf(fmOf("server"), "src"));
  await within(fmOf("server")).findByText("auth");
  dragOnto(rowOf(fmOf("server"), "auth"), rowOf(fmOf("gpu"), "docs"));
  await waitFor(() =>
    expect(world.names("gpu", "/g/docs/auth")).toEqual([
      "middleware.ts",
      "refresh.ts",
      "token.ts",
    ]),
  );
  // 源目录保留
  expect(world.names("local", "/w/src/auth")).toHaveLength(3);
});

test("[fm#11] 目录传输完成后，目标主机界面能逐级进入看到整棵子树，源标签仍在 src", async () => {
  world.autoFinish = true;
  const { store } = await both();
  fireEvent.click(mainOf(fmOf("server"), "src"));
  await within(fmOf("server")).findByText("auth");
  expect(filesTab(store, "server").cwd).toBe("/w/src");
  dragOnto(rowOf(fmOf("server"), "auth"), rowOf(fmOf("gpu"), "docs"));
  expect(await screen.findByText(/已传输 auth/)).toBeTruthy();

  // 目标主机：docs 里有 auth，再进 auth 能看到三个文件
  fireEvent.click(mainOf(fmOf("gpu"), "docs"));
  await within(fmOf("gpu")).findByText("auth");
  expect(filesTab(store, "gpu").cwd).toBe("/g/docs");
  fireEvent.click(mainOf(fmOf("gpu"), "auth"));
  await within(fmOf("gpu")).findByText("token.ts");
  expect(names(fmOf("gpu")).sort()).toEqual([
    "middleware.ts",
    "refresh.ts",
    "token.ts",
  ]);
  // 源主机原地不动
  expect(filesTab(store, "server").cwd).toBe("/w/src");
  expect(names(fmOf("server"))).toContain("auth");
});

test("[fm#19] 传输与移动各落各的主机：落盘结果互不串味，源不被动", async () => {
  world.autoFinish = true;
  await both();
  // 单文件、整个目录子树 → gpu；同主机移动 → server 自己的 docs
  dragOnto(rowOf(fmOf("server"), "package.json"), listOf(fmOf("gpu")));
  await waitFor(() => expect(world.has("gpu", "/g/package.json")).toBe(true));
  await waitFor(() => expect(strip()?.dataset.phase).toBe("done"));
  dragOnto(rowOf(fmOf("server"), "src"), rowOf(fmOf("gpu"), "docs"));
  await waitFor(() =>
    expect(world.has("gpu", "/g/docs/src/auth/token.ts")).toBe(true),
  );
  await waitFor(() => expect(strip()?.dataset.phase).toBe("done"));
  dragOnto(rowOf(fmOf("server"), "README.md"), rowOf(fmOf("server"), "docs"));
  await waitFor(() =>
    expect(world.has("local", "/w/docs/README.md")).toBe(true),
  );

  // gpu：收到传输的两项；server 的移动没有串到这里，它自己的 README 原样还在
  expect(world.has("gpu", "/g/docs/README.md")).toBe(false);
  expect(world.node("gpu", "/g/README.md")).toEqual({ type: "file", size: 50 });
  // server：移动结果在 docs；传输不动源，也没有把对方的东西带回来
  expect(world.has("local", "/w/README.md")).toBe(false);
  expect(world.has("local", "/w/package.json")).toBe(true);
  expect(world.has("local", "/w/src/auth/token.ts")).toBe(true);
  expect(world.has("local", "/w/docs/package.json")).toBe(false);
  expect(world.has("local", "/w/docs/src")).toBe(false);
});

test("跨主机目录传输遇到同名目录：按 cp -r 合并，同名文件改名", async () => {
  world.autoFinish = true;
  world.seed("gpu", { "/g/docs/auth/token.ts": 1, "/g/docs/auth/keep.ts": 2 });
  await both();
  fireEvent.click(mainOf(fmOf("server"), "src"));
  await within(fmOf("server")).findByText("auth");
  dragOnto(rowOf(fmOf("server"), "auth"), rowOf(fmOf("gpu"), "docs"));
  await waitFor(() =>
    expect(world.names("gpu", "/g/docs/auth")).toEqual([
      "keep.ts",
      "middleware.ts",
      "refresh.ts",
      "token (2).ts",
      "token.ts",
    ]),
  );
  // 原有的 token.ts 没被覆盖
  expect(world.node("gpu", "/g/docs/auth/token.ts")).toEqual({
    type: "file",
    size: 1,
  });
  expect(await screen.findByText(/1 项重名已改名/)).toBeTruthy();
});

test("同一时刻只允许一个跨主机传输：第二次被拒并提示，不排队；结束后可再传", async () => {
  await both();
  dragOnto(rowOf(fmOf("server"), "package.json"), listOf(fmOf("gpu")));
  await waitFor(() => expect(calls("transfer")).toHaveLength(1));

  dragOnto(rowOf(fmOf("server"), "README.md"), listOf(fmOf("gpu")));
  expect(await screen.findByText("前一次传输还没结束")).toBeTruthy();
  expect(calls("transfer")).toHaveLength(1);

  world.finishJob(world.lastJob()?.id as string);
  await waitFor(() => expect(strip()?.dataset.phase).toBe("done"));
  dragOnto(rowOf(fmOf("server"), "README.md"), listOf(fmOf("gpu")));
  await waitFor(() => expect(calls("transfer")).toHaveLength(2));
});

test("传输失败：传输条给出原因，不落盘，之后可以重试", async () => {
  world.startFail = "server";
  await both();
  dragOnto(rowOf(fmOf("server"), "package.json"), listOf(fmOf("gpu")));
  await waitFor(() => expect(strip()?.dataset.phase).toBe("failed"));
  expect(strip()?.textContent).toContain("Server 出错了");
  expect(strip()?.textContent).toContain("传输到 GPU 机 失败");
  expect(world.has("gpu", "/g/package.json")).toBe(false);

  world.startFail = null;
  dragOnto(rowOf(fmOf("server"), "package.json"), listOf(fmOf("gpu")));
  await waitFor(() => expect(calls("transfer")).toHaveLength(2));
});

test("传输中可以取消：发出取消请求，以轮询到的终态为准", async () => {
  await both();
  dragOnto(rowOf(fmOf("server"), "package.json"), listOf(fmOf("gpu")));
  await waitFor(() => expect(calls("transfer")).toHaveLength(1));
  fireEvent.click(await screen.findByRole("button", { name: "取消" }));
  await waitFor(() => expect(calls("cancel")).toHaveLength(1));
  await waitFor(() => expect(strip()?.dataset.phase).toBe("cancelled"));
  expect(world.has("gpu", "/g/package.json")).toBe(false);
});

test("跨主机拖到面包屑项：落到那台主机的该级目录", async () => {
  world.autoFinish = true;
  await both();
  dragOnto(rowOf(fmOf("server"), "package.json"), crumbOf(fmOf("gpu"), "/"));
  await waitFor(() => expect(world.has("gpu", "/package.json")).toBe(true));
  expect(calls("transfer")[0]).toContain("gpu:/package.json");
});

test("拖拽没有多余的列表请求之外的副作用：被拒绝的拖放不发任何写请求", async () => {
  await both();
  const fm = fmOf("server");
  dragOnto(rowOf(fm, "src"), rowOf(fm, "src"));
  dragOnto(rowOf(fm, "package.json"), listOf(fm));
  await Promise.resolve();
  for (const op of ["rename", "transfer", "mkdir", "remove"])
    expect(calls(op)).toHaveLength(0);
  expect(qa(".ws-xfer")).toHaveLength(0);
});
