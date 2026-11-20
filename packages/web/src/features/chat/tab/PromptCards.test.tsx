import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UploadResult } from "../../../api/attachments";
import type { PromptEntry } from "./flowLog";
import { ApprovalCard, QuestionCard } from "./PromptCards";
import { approval, question } from "./testkit";

const api = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  attachmentBlob: vi.fn(),
  downloadAttachment: vi.fn(),
}));
vi.mock("../../../api/attachments", () => api);

const entry = (
  prompt = question("pq1", { options: [], input: "rich" }),
  over: Partial<PromptEntry> = {},
): PromptEntry => ({
  seq: 1,
  at: 0,
  prompt,
  status: "pending",
  ...over,
});

const mountCard = (e: PromptEntry = entry(), onAnswer = vi.fn()) => {
  render(
    <QuestionCard sessionId="s1" entry={e} error={null} onAnswer={onAnswer} />,
  );
  return onAnswer;
};
const mountApproval = (e: PromptEntry, onAnswer = vi.fn()) => {
  render(
    <ApprovalCard sessionId="s1" entry={e} error={null} onAnswer={onAnswer} />,
  );
  return onAnswer;
};
const fileInput = () =>
  document.querySelector("[data-file-input]") as HTMLInputElement;
const pick = (file: File) => {
  Object.defineProperty(fileInput(), "files", {
    value: [file],
    configurable: true,
  });
  fireEvent.change(fileInput());
};
const ok = (file: File) =>
  ({
    ok: true,
    data: {
      name: file.name,
      mime: file.type,
      size: 1,
      path: `./d/${file.name}`,
    },
  }) as UploadResult;
const box = () => screen.getByRole("textbox", { name: "回答" });
const submit = () => screen.getByRole("button", { name: "提交" });

beforeEach(() => {
  api.uploadAttachment.mockReset();
  api.attachmentBlob.mockResolvedValue({ ok: true, data: new Blob(["x"]) });
  api.uploadAttachment.mockImplementation((_t, _s, f: File) =>
    Promise.resolve(ok(f)),
  );
});
afterEach(cleanup);

// ---- 提问卡：选项（可选）+ 输入框（有就一直在） ----

test("只有文字：不带 attachments 字段，收成一行写回答", () => {
  const onAnswer = mountCard();
  fireEvent.change(box(), { target: { value: "第二份" } });
  fireEvent.click(submit());
  expect(onAnswer).toHaveBeenCalledWith(
    expect.objectContaining({ promptId: "pq1" }),
    { text: "第二份" },
    "第二份",
  );
});

test("只带附件也能提交：答复里是路径，收起的那一行写出文件名", async () => {
  const onAnswer = mountCard();
  expect((submit() as HTMLButtonElement).disabled).toBe(true);
  pick(new File(["x"], "report.pdf", { type: "application/pdf" }));
  await waitFor(() =>
    expect((submit() as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(submit());
  expect(onAnswer).toHaveBeenCalledWith(
    expect.anything(),
    { attachments: [{ path: "./d/report.pdf" }] },
    "附件 report.pdf",
  );
});

test("附件还在上传时不提交，给出原因", async () => {
  let done: (r: UploadResult) => void = () => {};
  api.uploadAttachment.mockImplementationOnce(
    () => new Promise<UploadResult>((r) => (done = r)),
  );
  const onAnswer = mountCard();
  const file = new File(["x"], "slow.txt", { type: "text/plain" });
  pick(file);
  fireEvent.change(box(), { target: { value: "看附件" } });
  fireEvent.click(submit());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "附件还在上传",
  );
  expect(onAnswer).not.toHaveBeenCalled();
  done(ok(file));
});

const withOptions = () => entry(question("pq3", { input: "rich" }));

test("有选项也有输入框：点选项直接答，不带文字", () => {
  const onAnswer = mountCard(withOptions());
  expect(box()).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "3 家 · 深度简报" }));
  expect(onAnswer).toHaveBeenCalledWith(
    expect.anything(),
    { optionId: "brief" },
    "3 家 · 深度简报",
  );
});

test("写了字再点选项：选项 + 补充说明一起发出，收起的那一行两样都写", () => {
  const onAnswer = mountCard(withOptions());
  fireEvent.change(box(), { target: { value: "但只要国内的" } });
  fireEvent.click(screen.getByRole("button", { name: "6 家 · 对比表" }));
  expect(onAnswer).toHaveBeenCalledWith(
    expect.anything(),
    { optionId: "sheet", text: "但只要国内的" },
    "6 家 · 对比表 · 但只要国内的",
  );
});

test("有选项时也能不选，直接写自己的话提交", () => {
  const onAnswer = mountCard(withOptions());
  fireEvent.change(box(), { target: { value: "都不要，先看原始数据" } });
  fireEvent.click(submit());
  expect(onAnswer).toHaveBeenCalledWith(
    expect.anything(),
    { text: "都不要，先看原始数据" },
    "都不要，先看原始数据",
  );
});

test("没有输入框的弹窗（插件的选择 / 确认）：只有选项按钮", () => {
  mountCard(entry(question("pq4", { input: null })));
  expect(screen.queryByRole("textbox", { name: "回答" })).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(2);
});

test("只有文字没有附件的输入框（插件的输入弹窗）：没有上传入口", () => {
  mountCard(entry(question("pq2", { options: [], input: "text" })));
  expect(box()).toBeTruthy();
  expect(screen.queryByRole("button", { name: "上传文件" })).toBeNull();
  expect(document.querySelector("[data-file-input]")).toBeNull();
});

// ---- 审批卡：拒绝可以说明理由 ----

const approvalEntry = (input: "text" | null = "text") =>
  entry(approval("pa1", { input }));

test("批准与拒绝仍是一次点击，不带文字", () => {
  const onAnswer = mountApproval(approvalEntry());
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  expect(onAnswer).toHaveBeenLastCalledWith(
    expect.objectContaining({ promptId: "pa1" }),
    { optionId: "deny" },
    "拒绝",
  );
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  expect(onAnswer).toHaveBeenLastCalledWith(
    expect.anything(),
    { optionId: "allow" },
    "批准",
  );
});

test("拒绝并说明：展开输入行，理由随 deny 发出；取消收起", () => {
  const onAnswer = mountApproval(approvalEntry());
  expect(screen.queryByRole("textbox", { name: "拒绝的理由" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "拒绝并说明" }));
  fireEvent.change(screen.getByRole("textbox", { name: "拒绝的理由" }), {
    target: { value: "别动生产库" },
  });
  // 输入行里的「拒绝」是第二个同名按钮
  fireEvent.click(
    screen.getAllByRole("button", { name: "拒绝" }).at(-1) as HTMLElement,
  );
  expect(onAnswer).toHaveBeenCalledWith(
    expect.anything(),
    { optionId: "deny", text: "别动生产库" },
    "拒绝",
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("textbox", { name: "拒绝的理由" })).toBeNull();
});

test("没有输入框的审批（弹窗不收文字）：不出现「拒绝并说明」", () => {
  mountApproval(approvalEntry(null));
  expect(screen.queryByRole("button", { name: "拒绝并说明" })).toBeNull();
});

test("拒绝后收成一行，写出理由；批准不带理由", () => {
  const denied = entry(approval("pa1"), {
    status: "answered",
    answer: {
      optionId: "deny",
      text: "别动生产库",
      label: "拒绝",
      time: "10:00",
    },
  });
  mountApproval(denied);
  const line = screen.getByLabelText("审批").textContent ?? "";
  expect(line).toContain("已拒绝");
  expect(line).toContain("理由：别动生产库");
  cleanup();
  mountApproval(
    entry(approval("pa2"), {
      status: "answered",
      answer: { optionId: "allow", label: "批准", time: "10:00" },
    }),
  );
  expect(screen.getByLabelText("审批").textContent).not.toContain("理由");
});
