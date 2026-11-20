import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UploadResult } from "../../../api/attachments";
import { clearToasts, ToastHost } from "../../../ui";
import type { Attachment } from "../model/draft";
import { mount } from "./testkit";
import { installWorld } from "./testkit.world";

const api = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  attachmentBlob: vi.fn(),
  downloadAttachment: vi.fn(),
}));
vi.mock("../../../api/attachments", () => api);
vi.mock("../audit", () => ({ AuditPane: () => null }));

const meta = { title: "t", agentName: "编码实现", status: "running" as const };
const ta = () =>
  screen.getByRole("textbox", {
    name: "给 编码实现 发消息",
  }) as HTMLTextAreaElement;
const send = () =>
  screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
// 拖入的落点是整个对话标签（.ch-main），不再是输入卡
const main = () => document.querySelector(".ch-main") as HTMLElement;
const fileInput = () =>
  document.querySelector("[data-file-input]") as HTMLInputElement;
const attachRow = () => screen.queryByLabelText("附件") as HTMLElement | null;

const draftAttachment = (over: Partial<Attachment> = {}): Attachment => ({
  id: "a1",
  name: "f.txt",
  mimeType: "text/plain",
  size: 5,
  path: "./f.txt",
  status: "ready",
  progress: 100,
  ...over,
});

const uploaded = (file: File, over: Partial<{ path: string }> = {}) =>
  ({
    ok: true,
    data: {
      name: file.name,
      mime: file.type,
      size: file.size,
      path: over.path ?? `./2026-10-27/ab12-${file.name}`,
    },
  }) as UploadResult;

// 选文件：jsdom 里 input.files 只读，用 defineProperty 换掉再触发 change。
const pick = (files: File[]) => {
  Object.defineProperty(fileInput(), "files", {
    value: files,
    configurable: true,
  });
  fireEvent.change(fileInput());
};

// 拖拽/夹带用的假 entry（与 dropFiles 的最小结构一致）。
const fileEntry = (file: File) => ({
  isFile: true,
  isDirectory: false,
  name: file.name,
  file: (ok: (f: File) => void) => ok(file),
});
const dirEntry = (name: string, children: unknown[]) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let done = false;
    return {
      readEntries: (ok: (entries: unknown[]) => void) => {
        ok(done ? [] : children);
        done = true;
      },
    };
  },
});
const dropItem = (entry: unknown) => ({
  kind: "file",
  webkitGetAsEntry: () => entry,
});
const dropData = (items: unknown[], files: File[] = []) => ({
  types: ["Files"],
  items,
  files,
});

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  api.uploadAttachment.mockReset();
  api.attachmentBlob.mockReset();
  api.downloadAttachment.mockReset();
  api.uploadAttachment.mockImplementation((_t, _s, file: File) =>
    Promise.resolve(uploaded(file)),
  );
  api.attachmentBlob.mockResolvedValue({ ok: true, data: new Blob(["x"]) });
  api.downloadAttachment.mockResolvedValue({ ok: true });
});
afterEach(() => {
  clearToasts();
  vi.restoreAllMocks();
});

test("输入框的占位文字提示 / 调出命令，可访问名仍在", () => {
  installWorld();
  mount({}, { meta });
  expect(ta().placeholder).toContain("/ 调出命令");
  expect(ta().getAttribute("aria-label")).toBe("给 编码实现 发消息");
  // 占位文字不能退化成文本子节点（textarea 只该有 value）
  expect(ta().textContent).toBe("");
});

test("Enter 发送，Shift+Enter 换行（不发送）；输入法组字中的 Enter 不发送", () => {
  installWorld();
  const h = mount({}, { meta, draft: { text: "你好" } });
  fireEvent.keyDown(ta(), { key: "Enter", shiftKey: true });
  expect(h.box.actions.send).not.toHaveBeenCalled();
  fireEvent.keyDown(ta(), { key: "Enter", isComposing: true });
  expect(h.box.actions.send).not.toHaveBeenCalled();
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(h.box.actions.send).toHaveBeenCalledTimes(1);
  expect(h.box.actions.send).toHaveBeenCalledWith();
});

test("手机上（enterSends=false）回车是换行：不发送，占位文字不提 Enter，发送靠按钮", () => {
  installWorld();
  const h = mount(
    {},
    { meta, draft: { text: "你好" }, env: { enterSends: false } },
  );
  expect(ta().placeholder).not.toContain("Enter");
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(h.box.actions.send).not.toHaveBeenCalled();
  fireEvent.click(send());
  expect(h.box.actions.send).toHaveBeenCalledTimes(1);
});

test("量高度时锁住输入卡高度，量完立刻放开（不能留着死高度）", () => {
  installWorld();
  mount({}, { meta, draft: { text: "你好" } });
  const form = document.querySelector("[data-composer]") as HTMLElement;
  fireEvent.change(ta(), { target: { value: "你好\n第二行\n第三行" } });
  expect(form.style.height).toBe("");
});

test("草稿为空时发送按钮禁用，输入后可用", () => {
  installWorld();
  mount({}, { meta });
  expect(send().disabled).toBe(true);
  fireEvent.change(ta(), { target: { value: "hi" } });
  expect(send().disabled).toBe(false);
});

test("发送失败：message 显示在输入卡上方，可关闭；重新输入时消失", () => {
  installWorld();
  const h = mount({}, { meta, draft: { text: "/goal" } });
  h.box.sendResult = { ok: false, message: "在 /goal 后写一句长期目标" };
  fireEvent.keyDown(ta(), { key: "Enter" });
  const err = screen.getByRole("alert");
  expect(err.textContent).toContain("在 /goal 后写一句长期目标");
  const form = document.querySelector("[data-composer]") as HTMLElement;
  expect(form.firstElementChild).toBe(err);
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(screen.queryByRole("alert")).toBeNull();

  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.change(ta(), { target: { value: "/goal 写了" } });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("命令被服务端拒绝（lastError）：显示在输入卡上方，关闭调 dismissError", () => {
  installWorld();
  const h = mount(
    {
      lastError: {
        command: "pause_goal",
        code: "no_goal",
        message: "当前没有长期目标",
      },
    },
    { meta },
  );
  expect(screen.getByRole("alert").textContent).toContain("当前没有长期目标");
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(h.box.actions.dismissError).toHaveBeenCalled();
});

test("引用 chip 与附件卡片：有内容才显示，各自可移除；只有附件也能发", async () => {
  installWorld();
  const h = mount({}, { meta });
  expect(screen.queryByLabelText("引用")).toBeNull();
  expect(attachRow()).toBeNull();
  act(() =>
    h.box.setDraft({
      quotes: [{ id: "q1", quote: { label: "build:src/a.ts:L3", text: "x" } }],
      attachments: [
        draftAttachment({
          id: "a1",
          name: "shot.png",
          mimeType: "image/png",
          path: "./shot.png",
        }),
      ],
    }),
  );
  expect(screen.getByLabelText("引用").textContent).toContain(
    "build:src/a.ts:L3",
  );
  expect(attachRow()?.textContent).not.toContain("shot.png");
  // 图片缩略图走 content 接口取 blob；名称只在 alt/title/aria-label 里
  await waitFor(() =>
    expect(api.attachmentBlob).toHaveBeenCalledWith(null, "s1", "./shot.png"),
  );
  expect(screen.getByAltText("shot.png")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "查看大图 shot.png" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "移除引用 build:src/a.ts:L3" }),
  );
  expect(h.box.actions.removeQuote).toHaveBeenCalledWith("q1");
  // 只有附件也能发
  expect(send().disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "移除附件 shot.png" }));
  expect(h.box.actions.removeAttachment).toHaveBeenCalledWith("a1");
});

test("图片查看：同批左右切换、旋转、重置", async () => {
  installWorld();
  const h = mount({}, { meta });
  act(() =>
    h.box.setDraft({
      attachments: [
        draftAttachment({
          id: "a1",
          name: "a.png",
          mimeType: "image/png",
          path: "./a.png",
        }),
        draftAttachment({
          id: "a2",
          name: "b.png",
          mimeType: "image/png",
          path: "./b.png",
        }),
      ],
    }),
  );
  await screen.findByAltText("a.png");
  fireEvent.click(screen.getByRole("button", { name: "查看大图 a.png" }));
  expect(screen.getByRole("dialog").textContent).toContain("1 / 2");
  fireEvent.click(screen.getByRole("button", { name: "下一张" }));
  expect(await screen.findByText(/2 \/ 2 · b\.png/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "上一张" }));
  expect(await screen.findByText(/1 \/ 2 · a\.png/)).toBeTruthy();
  for (const name of ["逆时针旋转", "顺时针旋转", "缩小", "放大", "重置"])
    expect(screen.getByRole("button", { name })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "顺时针旋转" }));
  fireEvent.click(screen.getByRole("button", { name: "重置" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("运行中出现停止钮，点它调 stop；停止受理中禁用", () => {
  installWorld();
  const h = mount({ running: true }, { meta });
  fireEvent.click(screen.getByRole("button", { name: "停止运行" }));
  expect(h.box.actions.stop).toHaveBeenCalled();
  act(() => h.box.set({ stopPending: true }));
  expect(
    (screen.getByRole("button", { name: "停止运行" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("/compact 进行中：显示进度态，仍可发送（服务端排队）", () => {
  installWorld();
  const h = mount({ compacting: true }, { meta, draft: { text: "继续" } });
  expect(screen.getByRole("status").textContent).toContain("正在压缩上下文");
  expect(send().disabled).toBe(false);
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(h.box.actions.send).toHaveBeenCalledTimes(1);
});

test("+ 菜单：上传文件 / 引用仓库文件 / 引用隐私变量；@ 与 {{@}} 插入文本，光标落在花括号内", async () => {
  installWorld();
  mount({}, { meta });
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "上传文件或插入引用" }));
  expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
    "上传文件任意格式",
    "引用仓库文件@",
    "引用隐私变量{{@}}",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: /引用仓库文件/ }));
  expect(ta().value).toBe("@");

  fireEvent.change(ta(), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "上传文件或插入引用" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /引用隐私变量/ }));
  expect(ta().value).toBe("{{@}}");
  expect(ta().selectionStart).toBe(3);
  expect(ta().selectionEnd).toBe(3);
});

test("+ 菜单在触屏上多出「拍照」「相册」，各点开自己的文件框（拍照带 capture）", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  installWorld();
  mount({}, { meta });
  await act(async () => {});
  const click = vi.spyOn(HTMLInputElement.prototype, "click");
  fireEvent.click(screen.getByRole("button", { name: "上传文件或插入引用" }));
  expect(
    screen
      .getAllByRole("menuitem")
      .slice(0, 3)
      .map((i) => i.textContent),
  ).toEqual(["拍照", "相册", "上传文件任意格式"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "拍照" }));
  const photo = document.querySelector('[data-file-input="photo"]');
  expect(click.mock.contexts.at(-1)).toBe(photo);
  expect(photo?.getAttribute("capture")).toBe("environment");
  fireEvent.click(screen.getByRole("button", { name: "上传文件或插入引用" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "相册" }));
  expect(click.mock.contexts.at(-1)).toBe(
    document.querySelector('[data-file-input="image"]'),
  );
  vi.unstubAllGlobals();
});

// ── 附件上传 ──

test("选择任意类型文件：上传中显示进度并禁止发送，完成后卡片显示类型与体积", async () => {
  installWorld();
  mount({}, { meta });
  let onProgress: ((p: number) => void) | undefined;
  let finish: (r: UploadResult) => void = () => {};
  api.uploadAttachment.mockImplementationOnce(
    (
      _t: string | null,
      _s: string,
      _file: File,
      progress?: (p: number) => void,
    ) => {
      onProgress = progress;
      return new Promise<UploadResult>((r) => (finish = r));
    },
  );
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  pick([file]);
  await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1));
  expect(api.uploadAttachment.mock.calls[0]?.[1]).toBe("s1");
  expect(api.uploadAttachment.mock.calls[0]?.[2]).toBe(file);
  expect(attachRow()?.textContent).toContain("notes.txt");
  expect(send().disabled).toBe(true);
  expect(
    screen.getByRole("progressbar", { name: "上传进度 notes.txt" }),
  ).toBeTruthy();

  act(() => onProgress?.(42));
  expect(attachRow()?.textContent).toContain("上传中 42%");

  // 上传中按 Enter：不发，并给出可见原因；完成后提示自动消失
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(send().disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain(
    "附件还在上传，请稍候再发送",
  );

  await act(async () => finish(uploaded(file)));
  await waitFor(() =>
    expect(attachRow()?.textContent).toContain("text/plain · 5 B"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(send().disabled).toBe(false);
});

test("上传失败：卡片显示原因与重试，重试成功后恢复可发送", async () => {
  installWorld();
  const h = mount({}, { meta });
  api.uploadAttachment.mockImplementationOnce(() =>
    Promise.resolve({
      ok: false,
      message: "文件太大，超出了服务端限制",
    } as UploadResult),
  );
  const file = new File(["xx"], "big.bin", {
    type: "application/octet-stream",
  });
  pick([file]);
  await waitFor(() =>
    expect(attachRow()?.textContent).toContain("文件太大，超出了服务端限制"),
  );
  expect(send().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(attachRow()?.textContent).toContain("application/octet-stream"),
  );
  expect(send().disabled).toBe(false);

  // 上传中连 Enter 也不发
  api.uploadAttachment.mockImplementationOnce(
    () => new Promise<UploadResult>(() => {}),
  );
  const second = new File(["z"], "slow.bin", {
    type: "application/octet-stream",
  });
  pick([second]);
  await waitFor(() =>
    expect(screen.getByRole("progressbar", { name: "上传进度 slow.bin" })),
  );
  fireEvent.change(ta(), { target: { value: "发个文件" } });
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(h.box.actions.send).not.toHaveBeenCalled();
});

test("移除附件：清掉卡片并调 removeAttachment", async () => {
  installWorld();
  const h = mount({}, { meta });
  const file = new File(["x"], "a.txt", { type: "text/plain" });
  pick([file]);
  await waitFor(() => expect(attachRow()?.textContent).toContain("a.txt"));
  fireEvent.click(screen.getByRole("button", { name: "移除附件 a.txt" }));
  expect(h.box.actions.removeAttachment).toHaveBeenCalledWith("a1");
  expect(attachRow()).toBeNull();
  expect(send().disabled).toBe(true);
});

test("图片：上传中用本地预览 objectURL，完成后缩略图改走 content 接口", async () => {
  installWorld();
  mount({}, { meta });
  let finish: (r: UploadResult) => void = () => {};
  api.uploadAttachment.mockImplementationOnce(
    () => new Promise<UploadResult>((r) => (finish = r)),
  );
  const file = new File(["png"], "pic.png", { type: "image/png" });
  pick([file]);
  // 上传中：本地 blob 预览 + 进度条
  const thumb = (await screen.findByAltText("pic.png")) as HTMLImageElement;
  expect(thumb.src).toBe("blob:test");
  expect(
    screen.getByRole("progressbar", { name: "上传进度 pic.png" }),
  ).toBeTruthy();
  await act(async () =>
    finish(uploaded(file, { path: "./2026-10-27/ab12-pic.png" })),
  );
  await waitFor(() =>
    expect(api.attachmentBlob).toHaveBeenCalledWith(
      null,
      "s1",
      "./2026-10-27/ab12-pic.png",
    ),
  );
  expect(screen.getByRole("button", { name: "查看大图 pic.png" })).toBeTruthy();
});

test("点击附件卡片：图片打开大图，非图片直接下载", async () => {
  installWorld();
  const h = mount({}, { meta });
  act(() =>
    h.box.setDraft({
      attachments: [
        draftAttachment({
          id: "a1",
          name: "chart.png",
          mimeType: "image/png",
          path: "./chart.png",
        }),
        draftAttachment({
          id: "a2",
          name: "report.pdf",
          mimeType: "application/pdf",
          path: "./report.pdf",
          size: 2048,
        }),
      ],
    }),
  );
  await screen.findByAltText("chart.png");
  fireEvent.click(screen.getByRole("button", { name: "查看大图 chart.png" }));
  expect(screen.getByRole("dialog").textContent).toContain("chart.png");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));

  fireEvent.click(screen.getByRole("button", { name: "下载附件 report.pdf" }));
  await waitFor(() =>
    expect(api.downloadAttachment).toHaveBeenCalledWith(
      null,
      "s1",
      "./report.pdf",
      "report.pdf",
    ),
  );
});

// ── 拖拽与粘贴 ──

test("拖拽悬停：整个对话标签出现虚线高亮；进出子元素用深度计数避免闪烁", () => {
  installWorld();
  mount({}, { meta });
  const dt = dropData([]);
  fireEvent.dragEnter(main(), { dataTransfer: dt });
  fireEvent.dragEnter(ta(), { dataTransfer: dt }); // 进入子元素
  expect(document.querySelector(".ch-drop-mask")).toBeTruthy();
  fireEvent.dragLeave(ta(), { dataTransfer: dt }); // 离开子元素，仍在标签内
  expect(document.querySelector(".ch-drop-mask")).toBeTruthy();
  fireEvent.dragLeave(main(), { dataTransfer: dt });
  expect(document.querySelector(".ch-drop-mask")).toBeNull();
  // dragover 必须 preventDefault，否则浏览器不认这个落点
  expect(fireEvent.dragOver(main(), { dataTransfer: dt })).toBe(false);
});

test("拖拽非文件（文字等内部拖拽）：不接管、不高亮", () => {
  installWorld();
  mount({}, { meta });
  const dt = { types: ["text/plain"] };
  fireEvent.dragEnter(main(), { dataTransfer: dt });
  expect(document.querySelector(".ch-drop-mask")).toBeNull();
  expect(fireEvent.dragOver(main(), { dataTransfer: dt })).toBe(true);
});

test("审计视图不接收拖入", () => {
  installWorld();
  mount({}, { meta, tab: { ctab: "audit" } });
  const dt = dropData([dropItem(fileEntry(new File(["a"], "a.txt")))]);
  fireEvent.dragEnter(main(), { dataTransfer: dt });
  expect(document.querySelector(".ch-drop-mask")).toBeNull();
  expect(fireEvent.drop(main(), { dataTransfer: dt })).toBe(true);
  expect(api.uploadAttachment).not.toHaveBeenCalled();
});

test("拖拽批量文件：一次 drop 全部上传", async () => {
  installWorld();
  mount({}, { meta });
  const a = new File(["a"], "a.txt", { type: "text/plain" });
  const b = new File(["b"], "b.html", { type: "text/html" });
  // 落在对话流上而不是输入框：整个标签都可落
  fireEvent.drop(document.querySelector(".ch-stream") as HTMLElement, {
    dataTransfer: dropData([dropItem(fileEntry(a)), dropItem(fileEntry(b))]),
  });
  await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2));
  expect(
    api.uploadAttachment.mock.calls.map((c) => (c[2] as File).name),
  ).toEqual(["a.txt", "b.html"]);
});

test("拖拽文件夹：递归上传其中的文件", async () => {
  installWorld();
  mount({}, { meta });
  const a = new File(["a"], "a.txt", { type: "text/plain" });
  const b = new File(["b"], "b.md", { type: "text/markdown" });
  const folder = dirEntry("docs", [
    fileEntry(a),
    dirEntry("sub", [fileEntry(b)]),
  ]);
  fireEvent.drop(main(), { dataTransfer: dropData([dropItem(folder)]) });
  await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2));
  expect(
    api.uploadAttachment.mock.calls.map((c) => (c[2] as File).name),
  ).toEqual(["a.txt", "b.md"]);
});

test("拖拽空内容：提示没有可上传的文件", async () => {
  installWorld();
  render(<ToastHost />);
  mount({}, { meta });
  fireEvent.drop(main(), { dataTransfer: dropData([]) });
  expect(await screen.findByText("没有找到可上传的文件")).toBeTruthy();
  expect(api.uploadAttachment).not.toHaveBeenCalled();
});

test("GIF 按普通文件处理：不显示缩略图，点击下载", async () => {
  installWorld();
  mount({}, { meta });
  const gif = new File(["GIF89a"], "anim.gif", { type: "image/gif" });
  pick([gif]);
  await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      document.querySelector(".ch-file")?.getAttribute("data-status"),
    ).toBe("ready"),
  );
  expect(document.querySelector(".ch-file-thumb img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下载附件 anim.gif" }));
  await waitFor(() =>
    expect(api.downloadAttachment).toHaveBeenCalledWith(
      null,
      "s1",
      "./2026-10-27/ab12-anim.gif",
      "anim.gif",
    ),
  );
});

test("粘贴文件：任意类型都走上传链路", async () => {
  installWorld();
  const h = mount({}, { meta });
  const file = new File(["x"], "note.md", { type: "text/markdown" });
  fireEvent.paste(ta(), { clipboardData: { files: [file] } });
  await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1));
  const sent = api.uploadAttachment.mock.calls[0]?.[2] as File | undefined;
  expect(sent?.name).toBe("note.md");
  expect(h.box.actions.send).not.toHaveBeenCalled();
});

const slashPop = () => screen.queryByRole("dialog", { name: "快捷命令与技能" });
const slashRows = () => [
  ...document.querySelectorAll<HTMLElement>("[data-slash-id]"),
];
const slashRow = (id: string) =>
  document.querySelector(`[data-slash-id="${id}"]`) as HTMLElement;
const pressRow = (id: string) =>
  fireEvent.click(slashRow(id).querySelector("button") as HTMLElement);
const currentRows = () =>
  slashRows()
    .filter((r) => r.hasAttribute("data-current"))
    .map((r) => r.dataset.slashId);

test("空输入框按 / 打开命令菜单；有内容时不抢字符", async () => {
  installWorld();
  mount({}, { meta });
  fireEvent.keyDown(ta(), { key: "/" });
  await waitFor(() => expect(slashPop()).toBeTruthy());
  fireEvent.keyDown(ta(), { key: "Escape" });
  await waitFor(() => expect(slashPop()).toBeNull());

  fireEvent.change(ta(), { target: { value: "a" } });
  fireEvent.keyDown(ta(), { key: "/" });
  expect(slashPop()).toBeNull();
});

test("斜杠菜单：只保留一个 /，输入过滤，首项选中，Enter 执行", async () => {
  installWorld();
  mount({}, { meta });
  fireEvent.keyDown(ta(), { key: "/" });
  expect(ta().value).toBe("/");
  await waitFor(() => expect(slashPop()).toBeTruthy());
  expect(currentRows()).toEqual(["goal"]);

  fireEvent.change(ta(), { target: { value: "/pl" } });
  await waitFor(() => expect(slashRow("plan")).toBeTruthy());
  expect(
    slashRows().filter((r) => !r.dataset.slashId?.startsWith("mcp:")),
  ).toHaveLength(1);
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(ta().value).toBe("/plan ");
  expect(slashPop()).toBeNull();
});

test("斜杠菜单：Tab 命中当前选中项", async () => {
  installWorld();
  mount({}, { meta });
  fireEvent.keyDown(ta(), { key: "/" });
  fireEvent.change(ta(), { target: { value: "/rev" } });
  await waitFor(() => expect(slashRow("review")).toBeTruthy());
  fireEvent.keyDown(ta(), { key: "Tab" });
  expect(ta().value).toBe("/review ");
  expect(slashPop()).toBeNull();
});

test("斜杠菜单分三组：命令 / 技能 / MCP；MCP 是只读提示，点它与键盘都选不到", async () => {
  installWorld();
  mount({}, { meta });
  await waitFor(() =>
    expect(document.querySelector("[data-modelname]")?.textContent).toBe(
      "Claude Sonnet 5",
    ),
  );
  fireEvent.keyDown(ta(), { key: "/" });
  await waitFor(() => expect(slashPop()).toBeTruthy());
  expect(
    [...document.querySelectorAll(".ch-slash-h")].map((h) => h.textContent),
  ).toEqual(["命令", "技能", "MCP"]);
  expect(slashRows().map((r) => r.dataset.slashId)).toEqual([
    "goal",
    "compact",
    "mcp",
    "reload",
    "plan",
    "review",
    "skill:code-review",
    "mcp:github",
    "mcp:linear",
  ]);
  expect(slashRow("mcp:github").textContent).toContain("3 个工具");
  expect(slashRow("mcp:linear").textContent).toContain("握手超时");
  // 点 MCP 行没有任何反应
  fireEvent.click(
    slashRow("mcp:github").querySelector("button") as HTMLElement,
  );
  expect(ta().value).toBe("/");
  expect(slashPop()).toBeTruthy();
  // ↑ 从首项回绕到最后一个可选项（技能），不会落到 MCP 行
  fireEvent.keyDown(ta(), { key: "ArrowUp" });
  expect(currentRows()).toEqual(["skill:code-review"]);
});

test("斜杠菜单：点选命令或技能插入到输入框并收起；/compact 只插入不发送", async () => {
  installWorld();
  const h = mount({}, { meta });
  fireEvent.keyDown(ta(), { key: "/" });
  await waitFor(() => expect(slashRow("goal")).toBeTruthy());
  pressRow("goal");
  expect(ta().value).toBe("/goal ");
  expect(slashPop()).toBeNull();

  fireEvent.change(ta(), { target: { value: "" } });
  fireEvent.keyDown(ta(), { key: "/" });
  await waitFor(() => expect(slashRow("skill:code-review")).toBeTruthy());
  pressRow("skill:code-review");
  expect(ta().value).toBe("/code-review ");

  // 输入法 / 键盘吞 keydown 时，文本变成 / 也能打开菜单
  fireEvent.change(ta(), { target: { value: "/" } });
  await waitFor(() => expect(slashPop()).toBeTruthy());
  pressRow("compact");
  expect(ta().value).toBe("/compact ");
  expect(h.box.actions.send).not.toHaveBeenCalled();
});

test("/mcp：打开 MCP 状态弹窗，不发给会话，草稿清空", async () => {
  installWorld();
  const h = mount({}, { meta, draft: { text: "/mcp" } });
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(h.box.actions.send).not.toHaveBeenCalled();
  expect(h.box.actions.setDraft).toHaveBeenCalledWith("");
  const dlg = await screen.findByRole("dialog", { name: "MCP 服务" });
  await waitFor(() => expect(dlg.textContent).toContain("github"));
  expect(dlg.textContent).toContain("握手超时");
});

test("/reload：调用重载接口并提示，不发给会话", async () => {
  const w = installWorld();
  render(<ToastHost />);
  const h = mount({}, { meta, draft: { text: "/reload" } });
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(h.box.actions.send).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(w.actions).toContain("/api/v1/sessions/s1/reload"),
  );
  await screen.findByText(/已重载 MCP 与主机环境/);
});

test("/mcp 带参数不接受（交给原有的发送失败提示）", () => {
  installWorld();
  const h = mount({}, { meta, draft: { text: "/mcp x" } });
  h.box.sendResult = { ok: false, message: "/mcp 不接受参数" };
  fireEvent.keyDown(ta(), { key: "Enter" });
  expect(screen.getByRole("alert").textContent).toContain("/mcp 不接受参数");
});

test("斜杠菜单打开后输入非命令文本：菜单收起", async () => {
  installWorld();
  mount({}, { meta });
  fireEvent.keyDown(ta(), { key: "/" });
  await waitFor(() => expect(slashPop()).toBeTruthy());
  fireEvent.change(ta(), { target: { value: "你好" } });
  await waitFor(() => expect(slashPop()).toBeNull());
});
