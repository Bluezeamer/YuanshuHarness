import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UploadResult } from "../../../api/attachments";
import { pendingReason, useLocalAttachments } from "./attachments";
import { RichInput } from "./RichInput";

const api = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  attachmentBlob: vi.fn(),
  downloadAttachment: vi.fn(),
}));
vi.mock("../../../api/attachments", () => api);

const uploaded = (file: File) =>
  ({
    ok: true,
    data: {
      name: file.name,
      mime: file.type,
      size: file.size,
      path: `./2026-11-17/ab12-${file.name}`,
    },
  }) as UploadResult;

// 把输入框里的状态露出来：文字与附件路径
function Harness({
  onSubmit,
  disabled,
}: {
  onSubmit?: () => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const files = useLocalAttachments();
  return (
    <>
      <RichInput
        sessionId="s1"
        label="回答"
        value={text}
        onChange={setText}
        sink={files}
        {...(onSubmit ? { onSubmit } : {})}
        {...(disabled ? { disabled } : {})}
      />
      <output data-testid="state">
        {JSON.stringify({
          text,
          paths: files.list.map((a) => a.path),
          pending: pendingReason(files.list),
        })}
      </output>
    </>
  );
}

const state = () =>
  JSON.parse(screen.getByTestId("state").textContent ?? "{}") as {
    text: string;
    paths: string[];
    pending: string | null;
  };
const fileInput = () =>
  document.querySelector("[data-file-input]") as HTMLInputElement;
const pick = (files: File[]) => {
  Object.defineProperty(fileInput(), "files", {
    value: files,
    configurable: true,
  });
  fireEvent.change(fileInput());
};

beforeEach(() => {
  api.uploadAttachment.mockReset();
  api.attachmentBlob.mockResolvedValue({ ok: true, data: new Blob(["x"]) });
  api.uploadAttachment.mockImplementation((_t, _s, file: File) =>
    Promise.resolve(uploaded(file)),
  );
});
afterEach(cleanup);

test("选文件：上传到本会话附件区，附件条出现，路径进入附件列表", async () => {
  render(<Harness />);
  expect(screen.queryByLabelText("附件")).toBeNull();
  pick([new File(["x"], "a.txt", { type: "text/plain" })]);
  await waitFor(() =>
    expect(state().paths).toEqual(["./2026-11-17/ab12-a.txt"]),
  );
  expect(api.uploadAttachment.mock.calls[0]?.[1]).toBe("s1");
  expect(screen.getByLabelText("附件").textContent).toContain("a.txt");
});

test("粘贴文件走同一条上传链路；纯文本粘贴不拦", async () => {
  render(<Harness />);
  const ta = screen.getByRole("textbox", { name: "回答" });
  const text = fireEvent.paste(ta, { clipboardData: { files: [] } });
  expect(text).toBe(true);
  expect(api.uploadAttachment).not.toHaveBeenCalled();

  const shot = new File(["p"], "shot.png", { type: "image/png" });
  const blocked = !fireEvent.paste(ta, { clipboardData: { files: [shot] } });
  expect(blocked).toBe(true);
  await waitFor(() => expect(state().paths).toHaveLength(1));
});

test("上传没完成时 pendingReason 给出原因，完成后清掉", async () => {
  let done: (r: UploadResult) => void = () => {};
  api.uploadAttachment.mockImplementationOnce(
    () => new Promise<UploadResult>((r) => (done = r)),
  );
  render(<Harness />);
  const file = new File(["x"], "slow.txt", { type: "text/plain" });
  pick([file]);
  await waitFor(() =>
    expect(state().pending).toBe("附件还在上传，请稍候再发送"),
  );
  done(uploaded(file));
  await waitFor(() => expect(state().pending).toBeNull());
});

test("拖入文件：落在输入框里就加进这个输入框，不冒泡给外层的拖入区", async () => {
  const outer = vi.fn();
  render(
    // biome-ignore lint/a11y/noStaticElementInteractions: 测试里模拟外层拖入区
    <div onDrop={outer}>
      <Harness />
    </div>,
  );
  const file = new File(["d"], "drop.txt", { type: "text/plain" });
  const zone = document.querySelector("[data-rich-input]") as HTMLElement;
  fireEvent.drop(zone, {
    dataTransfer: { types: ["Files"], files: [file], items: [] },
  });
  await waitFor(() => expect(state().paths).toHaveLength(1));
  expect(outer).not.toHaveBeenCalled();
});

test("Enter 提交（Shift+Enter 换行、组词中不提交）；不给 onSubmit 时 Enter 不拦", () => {
  const submit = vi.fn();
  render(<Harness onSubmit={submit} />);
  const ta = screen.getByRole("textbox", { name: "回答" });
  fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(ta, { key: "Enter", isComposing: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(submit).toHaveBeenCalledTimes(1);
  cleanup();

  render(<Harness />);
  const free = screen.getByRole("textbox", { name: "回答" });
  expect(fireEvent.keyDown(free, { key: "Enter" })).toBe(true);
});

test("禁用时文字框与上传按钮都不可用", () => {
  render(<Harness disabled />);
  expect(
    (screen.getByRole("textbox", { name: "回答" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "上传文件" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
