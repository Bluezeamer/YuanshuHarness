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
import { clearToasts } from "../../../../ui";
import { mount, paneByHost, q, qa } from "../../layout/harness";
import { panesOf } from "../../model/l2";
import type { LayoutStore } from "../../store/layoutStore";
import { resetSingletons, seedWorld, tabsOf } from "../files/harness";
import { registerFilesTab } from "../files/register";
import { world } from "../files/testkit";
import { getTabDef, registerTab } from "../registry";
import { PREVIEW_LIMIT } from "./kind";
import { TEXT_MAX } from "./limits";
import { registerPreviewTab } from "./register";

vi.mock(
  "../../../../api/files",
  async () => (await import("../files/testkit")).fakeFilesApi,
);

const turnApi = vi.hoisted(() => ({ readTurnDiff: vi.fn() }));
vi.mock("../../../../api/turnChanges", () => turnApi);
const teamApi = vi.hoisted(() => ({ readTeamDiff: vi.fn() }));
vi.mock("../../../../api/team", () => teamApi);

// pdf.js 在 jsdom 里跑不起来：换成只记录「渲染了哪一页、用什么缩放、文字层建在哪」的替身。
const pdf = vi.hoisted(() => ({
  numPages: 3,
  invalid: false,
  rendered: [] as number[],
  scales: [] as number[],
  textLayers: [] as unknown[],
  // 书签树与命名目标：目录跳转靠它们解析页号
  outline: [] as { title: string; dest: string; items: unknown[] }[],
  dests: {} as Record<string, unknown[]>,
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {
    constructor(args: { container: HTMLElement }) {
      pdf.textLayers.push(args.container);
      args.container.append(
        Object.assign(document.createElement("span"), {
          textContent: "pdf 文字",
        }),
      );
    }
    render() {
      return Promise.resolve();
    }
    cancel() {}
  },
  getDocument: () => ({
    promise: pdf.invalid
      ? Promise.reject(new Error("invalid"))
      : Promise.resolve({
          numPages: pdf.numPages,
          getOutline: async () => pdf.outline,
          getDestination: async (name: string) => pdf.dests[name] ?? null,
          getPageIndex: async (ref: { n: number }) => ref.n - 1,
          getPage: async (n: number) => ({
            getViewport: ({ scale }: { scale: number }) => {
              pdf.scales.push(scale);
              return { width: 100 * scale, height: 140 * scale, scale };
            },
            render: () => {
              pdf.rendered.push(n);
              return { promise: Promise.resolve(), cancel: () => {} };
            },
            streamTextContent: () => ({}),
          }),
        }),
    destroy: async () => {},
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "worker.js",
}));

const mermaid = vi.hoisted(() => ({
  render: vi.fn(async (_id: string, _code: string) => ({
    svg: '<svg data-testid="mm"></svg>',
  })),
  initialize: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

const originals = {
  files: getTabDef("files"),
  preview: getTabDef("preview"),
};

beforeEach(() => {
  seedWorld();
  pdf.numPages = 3;
  pdf.invalid = false;
  pdf.outline = [];
  pdf.dests = {};
  pdf.rendered = [];
  pdf.scales = [];
  pdf.textLayers = [];
  mermaid.render.mockClear();
  registerFilesTab();
  registerPreviewTab();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  cleanup();
  clearToasts();
  resetSingletons();
  turnApi.readTurnDiff.mockReset();
  teamApi.readTeamDiff.mockReset();
  registerTab("files", originals.files);
  registerTab("preview", originals.preview);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 从文件管理器点开一个文件，预览标签在同窗格里成为当前标签 */
async function openFile(
  name: string,
  host = "server",
): Promise<{ store: LayoutStore; pane: HTMLElement }> {
  const { store } = await mount();
  const fm = q(".ws-fm", paneByHost(host)) as HTMLElement;
  await within(fm).findByText(name);
  const row = qa(".ws-fm-row", fm).find((r) => r.dataset.name === name);
  fireEvent.click(q(".u-lrow-main", row as HTMLElement) as HTMLElement);
  return { store, pane: paneByHost(host) };
}

const pv = () => q(".ws-pv") as HTMLElement;
/** B45：默认进编辑态，切到渲染态要先点「预览」（等加载完才出现这个切换） */
const toPreview = async () => {
  const radio = await waitFor(() => {
    const r = within(pv()).getByRole("radio", { name: "预览" });
    expect(r).toBeTruthy();
    return r;
  });
  fireEvent.click(radio);
};

test("点文件开出预览标签：标题取文件名，工具条有文件信息（完整路径在提示里）", async () => {
  world.put("local", "/w/src/util.ts", "export const a = 1;\n");
  const { store } = await mount();
  fireEvent.click(
    q('.u-lrow-main[title="/w/src"]', paneByHost("server")) as HTMLElement,
  );
  const fm = q(".ws-fm", paneByHost("server")) as HTMLElement;
  await within(fm).findByText("util.ts");
  fireEvent.click(q('.u-lrow-main[title="/w/src/util.ts"]', fm) as HTMLElement);
  // 代码预览走 CodeMirror，内容在 .cm-content 里
  await waitFor(() =>
    expect(q(".cm-content", pv())?.textContent).toContain(
      "export const a = 1;",
    ),
  );
  // 预览现在开在新窗格里，标签名要全局找
  const names = qa(".ws-pn-tab-name", document.body).map((n) => n.textContent);
  expect(names).toContain("util.ts");
  const meta = q(".ws-pv-meta", pv()) as HTMLElement;
  expect(meta.textContent).toMatch(/^ts · /);
  expect(meta.getAttribute("title")).toBe("/w/src/util.ts");
  // 主机由窗格头标明，工具条里不再重复
  expect(within(pv()).queryByText("Server")).toBeNull();
  expect(
    tabsOf(store)
      .filter((t) => t.type === "preview")
      .map((t) => t.path),
  ).toEqual(["/w/src/util.ts"]);
  // Server 本机走服务端环境 id local
  expect(world.calls).toContain("text local /w/src/util.ts");
});

test("代码预览：直接用 CodeMirror 渲染并高亮，默认就可以改", async () => {
  world.put("local", "/w/a.ts", "one\ntwo\n\nfour\n");
  await openFile("a.ts");
  // 纯代码没有渲染态：直接是 CodeMirror，行号槽也在
  await waitFor(() => expect(q(".cm-content", pv())).toBeTruthy());
  expect(q(".cm-content", pv())?.textContent).toContain("one");
  expect(q(".cm-content", pv())?.textContent).toContain("four");
  expect(qa(".cm-lineNumbers .cm-gutterElement", pv()).length).toBeGreaterThan(
    1,
  );
  // B45：默认直接编辑，所以编辑条在，且没有「预览/编辑」切换（没有可渲染的东西）
  expect(q(".ws-pv-tail", pv())).toBeTruthy();
  expect(within(pv()).queryByRole("radio", { name: "预览" })).toBeNull();
});

test("大文件只读前 N KB：标「已截断」并写明显示了多少", async () => {
  // 超过 5MB 编辑上限才走「按范围只读预览」这条路
  const line = `${"x".repeat(98)}\n`;
  const total = TEXT_MAX + 40 * 1024;
  world.put("local", "/w/big.txt", line.repeat(Math.ceil(total / line.length)));
  await openFile("big.txt");
  await within(pv()).findByText(/已截断/);
  const note = screen.getByRole("alert");
  expect(note.textContent).toContain("只显示前 256.0 KB");
  expect(note.textContent).toContain("完整内容请下载");
  expect(qa("ol.ws-pv-code li", pv()).length).toBeLessThanOrEqual(
    Math.ceil(PREVIEW_LIMIT / 99) + 1,
  );
});

test("没截断的文件不显示截断提示", async () => {
  world.put("local", "/w/small.txt", "hi");
  await openFile("small.txt");
  await within(pv()).findByText("hi");
  expect(screen.queryByText("已截断")).toBeNull();
});

test("markdown：标题、列表、代码块、表格、任务列表；图片不加载；链接新窗口打开", async () => {
  world.put(
    "local",
    "/w/doc.md",
    [
      "# 标题一",
      "",
      "- 条目甲",
      "- 条目乙",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| 列甲 | 列乙 |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "- [x] 做完了",
      "- [ ] 没做完",
      "",
      "![架构图](pic.png)",
      "",
      "[链接](https://example.org/x)",
    ].join("\n"),
  );
  await openFile("doc.md");
  // B45：默认进编辑态，看渲染效果要切到「预览」
  await toPreview();
  expect(
    (await within(pv()).findByRole("heading", { level: 1 })).textContent,
  ).toBe("标题一");
  const md = q(".ws-pv-md", pv()) as HTMLElement;
  expect(within(md).getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);
  expect(q("pre code", md)?.textContent).toContain("const x = 1;");
  expect(within(md).getByRole("table")).toBeTruthy();
  expect(
    within(md)
      .getAllByRole("columnheader")
      .map((c) => c.textContent),
  ).toEqual(["列甲", "列乙"]);
  const boxes = qa<HTMLInputElement>('input[type="checkbox"]', md);
  expect(boxes.map((b) => b.checked)).toEqual([true, false]);
  expect(boxes.every((b) => b.disabled)).toBe(true);
  expect(qa("img", md)).toHaveLength(0);
  expect(md.textContent).toContain("[图片：架构图]");
  const a = within(md).getByRole("link", { name: "链接" });
  expect(a.getAttribute("target")).toBe("_blank");
  expect(a.getAttribute("rel")).toContain("noopener");
  expect(q(".ws-pv-meta", pv())?.textContent).toMatch(/^markdown/);
  // 没有 mermaid 围栏就不加载 mermaid
  expect(mermaid.render).not.toHaveBeenCalled();
});

test("markdown 里的 mermaid 围栏才按需渲染", async () => {
  world.put("local", "/w/g.md", "```mermaid\ngraph TD\n  A-->B\n```\n");
  await openFile("g.md");
  await toPreview();
  await waitFor(() => expect(screen.getByTestId("mm")).toBeTruthy());
  expect(mermaid.render).toHaveBeenCalledTimes(1);
  expect(mermaid.render.mock.calls[0]?.[1]).toBe("graph TD\n  A-->B");
});

test("mermaid 语法错误：给错误提示，不注入错误图", async () => {
  mermaid.render.mockRejectedValueOnce(new Error("bad diagram"));
  world.put("local", "/w/bad.md", "```mermaid\nnot a diagram\n```\n");
  await openFile("bad.md");
  await toPreview();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("图表渲染失败");
  expect(mermaid.render).toHaveBeenCalledTimes(1);
});

test("图片：整文件取字节，用 blob 地址显示，离开时释放", async () => {
  const create = vi.fn(() => "blob:logo");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
  );
  world.put("local", "/w/logo.png", new Uint8Array([137, 80, 78, 71, 0, 1]));
  await openFile("logo.png");
  const img = await waitFor(() => {
    const el = q<HTMLImageElement>(".ws-pv-imgbox img", pv());
    if (!el) throw new Error("no img");
    return el;
  });
  expect(img.getAttribute("src")).toBe("blob:logo");
  expect(img.alt).toBe("logo.png");
  expect(world.calls).toContain("bytes local /w/logo.png");
  expect(
    world.calls.some((c) => c.startsWith("preview local /w/logo.png")),
  ).toBe(false);
  cleanup();
  expect(revoke).toHaveBeenCalledWith("blob:logo");
});

test("pdf：连续滚动渲染各页、缩放、目录跳转，文字层可选取", async () => {
  world.put("local", "/w/spec.pdf", new TextEncoder().encode("%PDF-1.4"));
  pdf.outline = [
    { title: "第一章", dest: "d1", items: [] },
    { title: "第二章", dest: "d2", items: [] },
  ];
  pdf.dests = { d1: [{ n: 1 }], d2: [{ n: 3 }] };
  await openFile("spec.pdf");

  // 连续滚动：所有页都排进列表并渲染（测试环境没有 IntersectionObserver，立即渲染）
  await within(pv()).findByText("1 / 3");
  await waitFor(() => expect(pdf.rendered).toEqual([1, 2, 3]));
  // 每页一层文字节点，叠在画布上
  await waitFor(() => expect(pdf.textLayers).toHaveLength(3));
  expect(q(".ws-pv-text", pv())?.textContent).toContain("pdf 文字");

  // 目录：展开后能看到书签，点一项跳到对应页
  fireEvent.click(screen.getByRole("button", { name: "展开目录" }));
  const nav = await screen.findByRole("navigation", { name: "目录" });
  fireEvent.click(within(nav).getByText("第二章"));
  await within(pv()).findByText("3 / 3");

  // 缩放
  fireEvent.click(screen.getByRole("button", { name: "放大" }));
  await within(pv()).findByText("125%");
  await waitFor(() => expect(pdf.scales).toContain(1.25 * 1.5));
  for (let i = 0; i < 6; i++)
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(
    (screen.getByRole("button", { name: "放大" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(within(pv()).getByText("300%")).toBeTruthy();
});

test("pdf 没有书签时目录按钮不可用", async () => {
  world.put("local", "/w/plain.pdf", new TextEncoder().encode("%PDF-1.4"));
  await openFile("plain.pdf");
  await within(pv()).findByText("1 / 3");
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "展开目录" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
});

test("pdf 打不开时给明确错误", async () => {
  pdf.invalid = true;
  world.put("local", "/w/bad.pdf", "not a pdf");
  await openFile("bad.pdf");
  expect((await within(pv()).findByRole("alert")).textContent).toBe(
    "不是有效的 PDF 文件",
  );
});

test("二进制文件不渲染内容，给下载入口", async () => {
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const create = vi.fn(() => "blob:dl");
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
  );
  world.put("local", "/w/data.bin", new Uint8Array([1, 2, 0, 3]));
  await openFile("data.bin");
  await within(pv()).findByText("二进制文件");
  expect(qa("ol.ws-pv-code", pv())).toHaveLength(0);
  fireEvent.click(
    within(pv()).getAllByRole("button", { name: "下载" })[0] as HTMLElement,
  );
  await waitFor(() => expect(click).toHaveBeenCalled());
  expect(world.calls).toContain("download local /w/data.bin");
});

test("无扩展名的文本文件（octet-stream 但没有 NUL）按文本显示", async () => {
  world.put(
    "local",
    "/w/Makefile2",
    "all:\n\techo hi\n",
    "application/octet-stream",
  );
  await openFile("Makefile2");
  await within(pv()).findByText("all:");
});

test("加载中有状态；失败时说明原因并可重试", async () => {
  let release = () => {};
  world.readGate = new Promise<void>((r) => {
    release = r;
  });
  world.put("local", "/w/late.txt", "later");
  await openFile("late.txt");
  expect(within(pv()).getByRole("status").textContent).toContain("正在读取");
  world.readFail.set("local:/w/late.txt", "forbidden");
  await act(async () => release());
  await within(pv()).findByText("没有权限读取这个文件");

  world.readFail.delete("local:/w/late.txt");
  fireEvent.click(within(pv()).getByRole("button", { name: "重试" }));
  await within(pv()).findByText("later");
});

test("文件不存在 / 网络错误各有说明", async () => {
  world.put("local", "/w/gone.txt", "x");
  const { store } = await openFile("gone.txt");
  await within(pv()).findByText("x");
  world.contents.delete("local:/w/gone.txt");
  // 预览开在新窗格里，标签不在来源窗格
  fireEvent.click(await screen.findByRole("tab", { name: /gone\.txt/ }));
  const t = tabsOf(store).find((x) => x.type === "preview");
  // 路径换成不存在的文件（模拟被移走）
  await act(async () => {
    store.patchTab(t?.id as string, { path: "/w/none.txt" });
  });
  await within(pv()).findByText("文件不存在，可能已被移动或删除");
  world.readFail.set("local:/w/none.txt", "network");
  fireEvent.click(within(pv()).getByRole("button", { name: "重试" }));
  await within(pv()).findByText("网络不通，连不上 Server");
});

test("预览跟随路径变化重新读取（移动后跟到新位置）", async () => {
  world.put("local", "/w/old.txt", "旧位置");
  world.put("local", "/w/docs/old.txt", "新位置");
  const { store } = await openFile("old.txt");
  await within(pv()).findByText("旧位置");
  const t = tabsOf(store).find((x) => x.type === "preview");
  await act(async () => {
    store.patchTab(t?.id as string, { path: "/w/docs/old.txt" });
  });
  await within(pv()).findByText("新位置");
  expect(q(".ws-pv-meta", pv())?.getAttribute("title")).toBe("/w/docs/old.txt");
});

test("复制路径", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  world.put("local", "/w/c.txt", "c");
  await openFile("c.txt");
  await within(pv()).findByText("c");
  fireEvent.click(within(pv()).getByLabelText("复制路径"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("/w/c.txt"));
});

test("同一文件再点只聚焦，不重复开预览", async () => {
  world.put("local", "/w/once.txt", "o");
  const { store, pane } = await openFile("once.txt");
  await within(pv()).findByText("o");
  fireEvent.click(within(pane).getByRole("tab", { name: /^文件/ }));
  const fm = q(".ws-fm", pane) as HTMLElement;
  await within(fm).findByText("once.txt");
  fireEvent.click(q('.u-lrow-main[title="/w/once.txt"]', fm) as HTMLElement);
  // 再点同一个文件：仍然只有一个预览标签（不会又开一个）
  expect(tabsOf(store).filter((t) => t.type === "preview")).toHaveLength(1);
  // 并且焦点回到放着预览的那个窗格
  const st = store.getState().doc.windows;
  const w = st.list[st.active] as NonNullable<typeof st.list>[number];
  const holder = panesOf(w).find((x) =>
    x.tabs.some((t) => t.type === "preview" && t.path === "/w/once.txt"),
  );
  expect(w.focus).toBe(holder?.pid);
});

test("标题：有路径取文件名，没有路径用「预览」", () => {
  const def = getTabDef("preview");
  expect(
    def.title({ id: "x", type: "preview", host: "server", path: "/a/b/c.md" }),
  ).toBe("c.md");
  expect(
    def.title({ id: "x", type: "preview", host: "server", path: "" }),
  ).toBe("预览");
});

test("文本预览默认直接进编辑态：内容在编辑器里，未改动时保存不可用", async () => {
  world.put("local", "/w/a.ts", "const a = 1;\n");
  await openFile("a.ts");
  await waitFor(() =>
    expect(q(".cm-content", pv())?.textContent).toContain("const a = 1;"),
  );
  // B45：不再有「编辑」按钮，默认就是可编辑，只有 还原 / 保存
  expect(within(pv()).queryByRole("button", { name: "完成" })).toBeNull();
  expect(q(".ws-pv-tail", pv())).toBeTruthy();
  expect(
    (within(pv()).getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("html：默认进编辑态，「预览」内嵌运行页面（沙箱里不给同源），并有「在浏览器中打开」", async () => {
  world.put("local", "/w/p.html", "<h1>hi</h1>\n");
  await openFile("p.html");
  // 默认编辑：源码在编辑器里
  await waitFor(() =>
    expect(q(".cm-content", pv())?.textContent).toContain("<h1>hi</h1>"),
  );
  expect(q(".ws-pv-tail", pv())).toBeTruthy();
  expect(q("iframe", pv())).toBeNull();
  await toPreview();
  const frame = await waitFor(() => {
    const f = q("iframe", pv());
    expect(f).toBeTruthy();
    return f as HTMLIFrameElement;
  });
  expect(frame.getAttribute("srcdoc")).toBe("<h1>hi</h1>\n");
  expect(
    within(pv()).getByRole("button", { name: "在浏览器中打开" }),
  ).toBeTruthy();
});

test("svg：默认编辑，切「预览」渲染成图", async () => {
  world.put(
    "local",
    "/w/logo.svg",
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
  );
  await openFile("logo.svg");
  // 默认编辑：源码在编辑器里
  await waitFor(() =>
    expect(q(".cm-content", pv())?.textContent).toContain("<rect"),
  );
  // 切预览：渲染成一张 blob 图
  await toPreview();
  const img = (await waitFor(() => {
    const i = q(".ws-pv-svgb img", pv());
    expect(i).toBeTruthy();
    return i as HTMLImageElement;
  })) as HTMLImageElement;
  expect(img.src.startsWith("blob:")).toBe(true);
});

test("轮末 diff 没有所属会话：给出明确空状态，不去请求那一轮", async () => {
  const def = getTabDef("preview");
  render(
    def.render({
      tab: {
        id: "t1",
        type: "preview",
        host: "server",
        sid: undefined,
        path: "/w/a.ts",
        diff: { turn: 3, path: "/w/a.ts" },
      },
      pane: { pid: "p1", host: "server", tabs: [], active: "" },
      sessionId: null,
      active: true,
      patchTab: () => {},
      patchAfx: () => {},
      close: () => {},
    }) as React.ReactElement,
  );
  expect(screen.getByText("找不到这一轮所属的会话")).toBeTruthy();
  expect(turnApi.readTurnDiff).not.toHaveBeenCalled();
});

test("轮末 diff 按所属会话读那一轮的改动", async () => {
  turnApi.readTurnDiff.mockResolvedValue({ ok: true, data: "" });
  const def = getTabDef("preview");
  render(
    def.render({
      tab: {
        id: "t1",
        type: "preview",
        host: "server",
        sid: "s1",
        path: "/w/a.ts",
        diff: { turn: 3, path: "/w/a.ts" },
      },
      pane: { pid: "p1", host: "server", tabs: [], active: "" },
      sessionId: "s1",
      active: true,
      patchTab: () => {},
      patchAfx: () => {},
      close: () => {},
    }) as React.ReactElement,
  );
  await waitFor(() =>
    expect(turnApi.readTurnDiff).toHaveBeenCalledWith(null, "s1", 3, "/w/a.ts"),
  );
});

test("团队 diff 按所属会话读建队以来的改动，不走轮次接口；没有改动给明确说明", async () => {
  teamApi.readTeamDiff.mockResolvedValue({ ok: false, kind: "not_found" });
  const def = getTabDef("preview");
  render(
    def.render({
      tab: {
        id: "t1",
        type: "preview",
        host: "server",
        sid: "s1",
        path: "a.ts",
        diff: { turn: null, path: "a.ts", team: true },
      },
      pane: { pid: "p1", host: "server", tabs: [], active: "" },
      sessionId: "s1",
      active: true,
      patchTab: () => {},
      patchAfx: () => {},
      close: () => {},
    }) as React.ReactElement,
  );
  await waitFor(() =>
    expect(teamApi.readTeamDiff).toHaveBeenCalledWith(null, "s1", "a.ts"),
  );
  expect(turnApi.readTurnDiff).not.toHaveBeenCalled();
  expect(screen.getByText("团队改动")).toBeTruthy();
  await screen.findByText("这个文件相对建队时已经没有改动。");
});
