import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearToasts, ToastHost } from "../../../ui";
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

const attach = (
  name: string,
  mime: string,
  sizeText: string,
  path: string,
) => ({
  name,
  mime,
  sizeText,
  path,
});

const three = {
  role: "user" as const,
  text: "看看这两个文件",
  attachments: [
    attach("shot.png", "image/png", "12.3 KB", "./2026-10-27/ab-shot.png"),
    attach("报告.pdf", "application/pdf", "2.0 MB", "./2026-10-27/cd-报告.pdf"),
  ],
};

afterEach(() => {
  cleanup();
  clearToasts();
  api.attachmentBlob.mockReset();
  api.downloadAttachment.mockReset();
});

test("历史用户消息：图片只显示缩略图，非图片显示名称/类型/大小", async () => {
  installWorld();
  api.attachmentBlob.mockResolvedValue({ ok: true, data: new Blob(["x"]) });
  mount({ messages: [three] }, { meta });
  const row = screen.getByLabelText("附件");
  // 图片不显示名称与类型，只在 alt/title/aria-label 里
  expect(row.textContent).not.toContain("shot.png");
  expect(row.textContent).not.toContain("image/png");
  expect(row.textContent).toContain("报告.pdf");
  expect(row.textContent).toContain("application/pdf · 2.0 MB");
  // 图片缩略图走 content 接口；非图片不取内容
  await waitFor(() =>
    expect(api.attachmentBlob).toHaveBeenCalledWith(
      null,
      "s1",
      "./2026-10-27/ab-shot.png",
    ),
  );
  expect(api.attachmentBlob).toHaveBeenCalledTimes(1);
  expect(screen.getByAltText("shot.png")).toBeTruthy();
});

test("历史附件：点图片打开 ImageViewer，点非图片直接下载", async () => {
  installWorld();
  api.attachmentBlob.mockResolvedValue({ ok: true, data: new Blob(["x"]) });
  api.downloadAttachment.mockResolvedValue({ ok: true });
  mount({ messages: [three] }, { meta });

  await screen.findByAltText("shot.png");
  fireEvent.click(screen.getByRole("button", { name: "查看大图 shot.png" }));
  expect(screen.getByRole("dialog").textContent).toContain("shot.png");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));

  fireEvent.click(screen.getByRole("button", { name: "下载附件 报告.pdf" }));
  await waitFor(() =>
    expect(api.downloadAttachment).toHaveBeenCalledWith(
      null,
      "s1",
      "./2026-10-27/cd-报告.pdf",
      "报告.pdf",
    ),
  );
});

test("下载失败：toast 中文原因", async () => {
  installWorld();
  api.attachmentBlob.mockResolvedValue({ ok: true, data: new Blob(["x"]) });
  api.downloadAttachment.mockResolvedValue({
    ok: false,
    message: "附件不存在或已被清理",
  });
  render(<ToastHost />);
  mount(
    {
      messages: [
        {
          role: "user",
          text: "文件",
          attachments: [
            attach("a.zip", "application/zip", "1 B", "./2026/a.zip"),
          ],
        },
      ],
    },
    { meta },
  );
  fireEvent.click(screen.getByRole("button", { name: "下载附件 a.zip" }));
  expect(await screen.findByText("附件不存在或已被清理")).toBeTruthy();
});

test("排队区里的附件标记行在展示前剥掉", () => {
  installWorld();
  mount(
    {
      queue: [
        [
          "[attach_file] attachment:/2026/a.html (text/html, 3 B)",
          "看这个文件",
        ].join("\n"),
      ],
    },
    { meta },
  );
  const queue = document.querySelector(".ch-queue") as HTMLElement;
  expect(queue.textContent).toContain("看这个文件");
  expect(queue.textContent).not.toContain("[attach_file]");
  expect(screen.getByText(/当前步骤结束后送达/)).toBeTruthy();
});
