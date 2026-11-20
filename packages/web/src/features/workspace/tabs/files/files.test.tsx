import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ui from "../../../../ui";
import { clearToasts } from "../../../../ui";
import { mount, q, qa } from "../../layout/harness";
import { findPane, panesOf } from "../../model/l2";
import type { LayoutStore } from "../../store/layoutStore";
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
  showGpuFiles,
  tabsOf,
} from "./harness";
import { registerFilesTab } from "./register";
import { retargetPreviews } from "./retarget";
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
  vi.unstubAllGlobals();
});

test("文件标签列出 cwd 的内容：目录在前，带大小与时间，头部是面包屑", async () => {
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  expect(names(fm)).toEqual(["docs", "src", "README.md", "package.json"]);
  const crumbs = qa(".ws-fm-crumb button", fm).map((b) => b.dataset.path);
  expect(crumbs).toEqual(["/", "/w"]);
  expect(rowOf(fm, "README.md").textContent).toContain("120 B");
  expect(
    rowOf(fm, "README.md").querySelector(".ws-fm-time")?.textContent,
  ).toMatch(/\d\d:\d\d|\d{2}-\d{2}/);
  // Server 本机用的是服务端环境 id local
  expect(world.calls).toContain("list local /w");
});

test("文件按名字挑图标：特殊文件名、扩展名、目录名各走各的，未知的退回通用文件", async () => {
  world.seed("local", {
    "/w/app.ts": 10,
    "/w/app.test.ts": 20,
    "/w/logo.png": 30,
    "/w/README.md": 40,
    "/w/package.json": 50,
    "/w/Dockerfile": 60,
    "/w/bundle.zip": 70,
    "/w/noext": 80,
  });
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("app.ts");
  // 图标标识挂在单元格上，与图标同源；顺带确认真的画了 svg
  const kindOf = (name: string) => {
    const ic = mainOf(fm, name).querySelector(".ws-fm-ic");
    expect(ic?.querySelector("svg"), name).toBeTruthy();
    return ic?.querySelector("svg")?.getAttribute("data-icon");
  };

  expect(kindOf("src")).toBe("folder-src");
  expect(kindOf("app.ts")).toBe("typescript");
  expect(kindOf("app.test.ts")).toBe("typescript-test");
  expect(kindOf("logo.png")).toBe("image");
  expect(kindOf("README.md")).toBe("readme");
  expect(kindOf("package.json")).toBe("package-json");
  expect(kindOf("Dockerfile")).toBe("docker");
  expect(kindOf("bundle.zip")).toBe("zip");
  expect(kindOf("noext")).toBe("file");
});

test("点目录进入并把 cwd 写回标签；面包屑每段可点；上一级", async () => {
  const { store } = await mount();
  const fm = fmOf("server");
  await within(fm).findByText("src");
  fireEvent.click(mainOf(fm, "src"));
  await within(fmOf("server")).findByText("index.ts");
  expect(filesTab(store, "server").cwd).toBe("/w/src");
  expect(
    qa(".ws-fm-crumb button", fmOf("server")).map((b) => b.dataset.path),
  ).toEqual(["/", "/w", "/w/src"]);

  fireEvent.click(screen.getAllByLabelText("上一级")[0] as HTMLElement);
  await within(fmOf("server")).findByText("README.md");
  expect(filesTab(store, "server").cwd).toBe("/w");

  fireEvent.click(
    q('.ws-fm-crumb button[data-path="/"]', fmOf("server")) as HTMLElement,
  );
  await within(fmOf("server")).findByText("w");
  expect(filesTab(store, "server").cwd).toBe("/");
  // 根目录没有上一级
  expect(
    (screen.getAllByLabelText("上一级")[0] as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("点文件走打开路由：开出预览标签，同一文件再点只聚焦", async () => {
  const { store } = await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  fireEvent.click(mainOf(fm, "README.md"));
  const previews = () => tabsOf(store).filter((t) => t.type === "preview");
  expect(previews()).toHaveLength(1);
  expect(previews()[0]).toMatchObject({ host: "server", path: "/w/README.md" });

  // 回到文件标签再点一次：不重复开
  const st = store.getState().doc.windows;
  const win = st.list[st.active];
  const pane = (win ? panesOf(win) : []).find((p) => p.host === "server");
  await act(async () => {
    store.activateTab(pane?.pid as string, filesTab(store, "server").id);
  });
  fireEvent.click(mainOf(fmOf("server"), "README.md"));
  expect(previews()).toHaveLength(1);
  expect(
    findPane(win as NonNullable<typeof win>, pane?.pid as string),
  ).toBeTruthy();
});

test("键盘：Enter 打开（目录进入）；上下键在行之间移动焦点；空格是按钮自己的点击", async () => {
  const { store } = await mount();
  const fm = fmOf("server");
  await within(fm).findByText("src");
  expect(mainOf(fm, "src").tagName).toBe("BUTTON");
  expect(mainOf(fm, "src").tabIndex).toBe(0);

  mainOf(fm, "docs").focus();
  fireEvent.keyDown(mainOf(fm, "docs"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(mainOf(fm, "src"));
  fireEvent.keyDown(mainOf(fm, "src"), { key: "ArrowUp" });
  expect(document.activeElement).toBe(mainOf(fm, "docs"));

  fireEvent.keyDown(mainOf(fm, "src"), { key: "Enter" });
  await within(fmOf("server")).findByText("index.ts");
  expect(filesTab(store, "server").cwd).toBe("/w/src");
});

const previewTabs = (store: LayoutStore) =>
  tabsOf(store)
    .filter((t) => t.type === "preview")
    .map((t) => [t.path, t.temp === true]);

test("单击文件开临时预览，再单击别的文件就地替换；双击固定", async () => {
  const { store } = await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  fireEvent.click(mainOf(fm, "README.md"));
  expect(previewTabs(store)).toEqual([["/w/README.md", true]]);
  fireEvent.click(mainOf(fm, "package.json"));
  expect(previewTabs(store)).toEqual([["/w/package.json", true]]);

  // 双击 = 单击 + dblclick：同一文件被固定，不新增标签
  fireEvent.click(mainOf(fm, "package.json"));
  fireEvent.doubleClick(mainOf(fm, "package.json"));
  expect(previewTabs(store)).toEqual([["/w/package.json", false]]);

  // 之后单击别的文件另开一个临时预览，固定的那个留着
  fireEvent.click(mainOf(fm, "README.md"));
  expect(previewTabs(store)).toEqual([
    ["/w/package.json", false],
    ["/w/README.md", true],
  ]);
});

test("Enter 直接固定预览；双击目录行不会开预览", async () => {
  const { store } = await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  fireEvent.keyDown(mainOf(fm, "README.md"), { key: "Enter" });
  expect(previewTabs(store)).toEqual([["/w/README.md", false]]);
  fireEvent.doubleClick(mainOf(fm, "docs"));
  expect(previewTabs(store)).toEqual([["/w/README.md", false]]);
});

test("双击临时预览的标签：固定", async () => {
  const { store } = await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  fireEvent.click(mainOf(fm, "README.md"));
  const tab = qa(".ws-pn-tab").find(
    (t) => t.dataset.temp === "true" && t.dataset.type === "preview",
  );
  expect(tab).toBeTruthy();
  fireEvent.doubleClick(q(".ws-pn-tab-btn", tab as HTMLElement) as HTMLElement);
  expect(previewTabs(store)).toEqual([["/w/README.md", false]]);
});

test("隐藏文件开关：默认不列，点眼睛带 hidden 参数重取，再点收回", async () => {
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  expect(names(fm)).not.toContain(".env");
  const eye = () =>
    within(fmOf("server")).getByRole("button", { name: "显示隐藏文件" });
  expect(eye().getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(eye());
  await within(fmOf("server")).findByText(".env");
  expect(world.calls).toContain("list local /w hidden");
  expect(eye().getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(eye());
  await waitFor(() => expect(names(fmOf("server"))).not.toContain(".env"));
});

test("右键下载：文件走原文件接口、文件夹走打包接口，拿到后另存，传输条给出结果", async () => {
  const save = vi.spyOn(ui, "saveBlob").mockImplementation(() => {});
  world.put("local", "/w/README.md", "hello");
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  const download = async (name: string) => {
    fireEvent.contextMenu(rowOf(fm, name));
    fireEvent.click(await screen.findByRole("menuitem", { name: "下载" }));
  };

  await download("README.md");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]?.[1]).toBe("README.md");
  expect(world.calls).toContain("download local /w/README.md");

  await download("docs");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[1]).toBe("docs.zip");
  expect(world.calls).toContain("archive local /w/docs");
  save.mockRestore();
});

test("右键下载失败：传输条写明原因，不另存", async () => {
  const save = vi.spyOn(ui, "saveBlob").mockImplementation(() => {});
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  // 种子里的 README.md 没有内容，读下载接口得到「不存在」
  fireEvent.contextMenu(rowOf(fm, "README.md"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "下载" }));
  const card = await waitFor(() => {
    const c = document.querySelector<HTMLElement>(".ws-xfer");
    expect(c?.dataset.phase).toBe("failed");
    return c as HTMLElement;
  });
  expect(card.textContent).toContain("下载 README.md 失败");
  expect(card.textContent).toContain("文件不存在");
  expect(save).not.toHaveBeenCalled();
  save.mockRestore();
});

test("新建文件夹：成功后出现在列表；重名在对话框里报错且不关闭", async () => {
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  await pickMenu(fm, "新建", "新建文件夹");
  const input = await screen.findByLabelText("名称");
  fireEvent.change(input, { target: { value: "docs" } });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "已存在同名项",
  );
  expect(screen.getByLabelText("名称")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "a/b" } });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  expect((await screen.findByRole("alert")).textContent).toContain("不能有 /");

  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "build" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  await within(fmOf("server")).findByText("build");
  expect(world.has("local", "/w/build")).toBe(true);
  expect(screen.queryByLabelText("名称")).toBeNull();
});

test("重命名：改名后列表刷新，重名被拒绝", async () => {
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  const open = async (name: string) => {
    fireEvent.click(
      within(rowOf(fmOf("server"), name)).getByLabelText(`${name} 的操作`),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
  };
  await open("README.md");
  fireEvent.change(await screen.findByLabelText("名称"), {
    target: { value: "package.json" },
  });
  fireEvent.click(screen.getByRole("button", { name: "重命名" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "已存在同名项",
  );

  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "READ.md" },
  });
  fireEvent.click(screen.getByRole("button", { name: "重命名" }));
  await within(fmOf("server")).findByText("READ.md");
  expect(world.has("local", "/w/README.md")).toBe(false);
});

test("删除要二次确认：取消不动数据，确认后目录带 recursive", async () => {
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  const open = async (name: string) => {
    fireEvent.click(
      within(rowOf(fmOf("server"), name)).getByLabelText(`${name} 的操作`),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
  };
  await open("src");
  expect(await screen.findByText("删除 src？")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(world.has("local", "/w/src")).toBe(true);
  expect(world.calls.some((c) => c.startsWith("remove"))).toBe(false);

  await open("src");
  // 确认按钮在弹窗里（选中条上也有个「删除」，必须限定作用域）
  const modal = await waitFor(() => {
    const el = document.querySelector(".u-modal");
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  fireEvent.click(await within(modal).findByRole("button", { name: "删除" }));
  await waitFor(() => expect(names(fmOf("server"))).not.toContain("src"));
  expect(world.calls).toContain("remove local /w/src -r sid=a");
  expect(world.has("local", "/w/src/index.ts")).toBe(false);
});

test("加载态：请求未返回时显示读取中，不显示空目录", async () => {
  let release = () => {};
  world.listGate = new Promise<void>((r) => {
    release = r;
  });
  await mount();
  const fm = fmOf("server");
  expect(within(fm).getByRole("status").textContent).toContain("正在读取");
  expect(within(fm).queryByText("空目录")).toBeNull();
  await act(async () => release());
  await within(fm).findByText("README.md");
});

test("空目录有明确状态", async () => {
  world.seed("local", { "/w/empty": null });
  const { store } = await mount();
  await within(fmOf("server")).findByText("README.md");
  await act(async () => {
    store.patchTab(filesTab(store, "server").id, { cwd: "/w/empty" });
  });
  await within(fmOf("server")).findByText("空目录");
});

test("权限错误与网络错误各有说明，可重试；不存在的目录可回上一级", async () => {
  world.listFail.set("local:/w", "forbidden");
  const { store } = await mount();
  const fm = fmOf("server");
  await within(fm).findByText("无法读取目录");
  expect(within(fm).getByText("没有权限读取这个目录")).toBeTruthy();

  world.listFail.set("local:/w", "network");
  fireEvent.click(within(fm).getByRole("button", { name: "重试" }));
  await within(fm).findByText("网络不通，连不上 Server");

  world.listFail.delete("local:/w");
  fireEvent.click(within(fm).getByRole("button", { name: "重试" }));
  await within(fmOf("server")).findByText("README.md");

  await act(async () => {
    store.patchTab(filesTab(store, "server").id, { cwd: "/w/gone" });
  });
  await within(fmOf("server")).findByText(/目录不存在/);
  fireEvent.click(
    within(fmOf("server")).getByRole("button", { name: "回到上一级" }),
  );
  await within(fmOf("server")).findByText("README.md");
  expect(filesTab(store, "server").cwd).toBe("/w");
});

test("每台主机各持一份文件树：互不影响，各用各的环境 id", async () => {
  const { store } = await mount();
  await within(fmOf("server")).findByText("README.md");
  const gpu = await showGpuFiles();
  expect(names(gpu)).toEqual(["data", "train.py"]);
  expect(world.calls).toContain("list gpu /g");

  fireEvent.click(mainOf(fmOf("server"), "src"));
  await within(fmOf("server")).findByText("index.ts");
  expect(filesTab(store, "server").cwd).toBe("/w/src");
  expect(filesTab(store, "gpu").cwd).toBe("/g");
  expect(names(fmOf("gpu"))).toEqual(["data", "train.py"]);
});

test("复制路径写入剪贴板", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount();
  const fm = fmOf("server");
  await within(fm).findByText("README.md");
  await pickMenu(fm, "更多", "复制路径");
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("/w"));
});

test("标签标题取当前目录名", async () => {
  const { store } = await mount();
  await within(fmOf("server")).findByText("README.md");
  const def = getTabDef("files");
  expect(def.title(filesTab(store, "server"))).toBe("w");
  expect(def.title({ id: "x", type: "files", host: "server", cwd: "/" })).toBe(
    "文件",
  );
});

test("retargetPreviews 只改当前窗口：别的窗口里的预览留在原路径", () => {
  const patchTab = vi.fn(() => true);
  const windows = {
    active: 0,
    list: [
      {
        id: "w1",
        focus: "p1",
        root: {
          pid: "p1",
          host: "server" as const,
          tabs: [
            {
              id: "t1",
              type: "preview" as const,
              host: "server",
              path: "/w/docs/a.md",
            },
            {
              id: "t2",
              type: "preview" as const,
              host: "gpu",
              path: "/w/docs/a.md",
            },
          ],
          active: "t1",
        },
      },
      {
        id: "w2",
        focus: "p2",
        root: {
          pid: "p2",
          host: "server" as const,
          tabs: [
            {
              id: "t3",
              type: "preview" as const,
              host: "server",
              path: "/w/docs/a.md",
            },
          ],
          active: "t3",
        },
      },
    ],
  };
  const store = {
    getState: () => ({ doc: { version: 4, windows } }),
    patchTab,
  } as unknown as LayoutStore;
  expect(retargetPreviews(store, "server", "/w/docs", "/w/docs2")).toBe(1);
  // 另一台主机的预览、另一个窗口里的预览都不动
  expect(patchTab).toHaveBeenCalledWith("t1", { path: "/w/docs2/a.md" });
});
