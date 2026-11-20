// 审核提示词页签：固定头尾只读、判别准则走草稿 + 保存条、恢复默认只是把草稿换回默认文本。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../api/http";
import type { ReviewPrompt } from "../../../api/reviewPrompt";
import { clearToasts, ToastHost } from "../../../ui";
import { ReviewPromptTab } from "./ReviewPromptTab";

const api = vi.hoisted(() => ({
  getReviewPrompt: vi.fn(),
  putReviewPrompt: vi.fn(),
}));
vi.mock("../../../api/reviewPrompt", () => api);

const DEFAULT = "- allow：低风险\n- deny：越界\n- ask：拿不准";
const prompt = (over: Partial<ReviewPrompt> = {}): ReviewPrompt => ({
  head: "HEAD-FIXED",
  tail: "TAIL-FIXED",
  criteria: DEFAULT,
  defaultCriteria: DEFAULT,
  custom: false,
  max: 50,
  ...over,
});

beforeEach(() => {
  sessionStorage.clear();
  api.getReviewPrompt.mockReset();
  api.putReviewPrompt.mockReset();
  api.getReviewPrompt.mockResolvedValue(prompt());
});
afterEach(() => {
  cleanup();
  clearToasts();
});

const box = () => screen.getByLabelText("判别准则") as HTMLTextAreaElement;
const restore = () =>
  screen.getByRole("button", { name: "恢复默认" }) as HTMLButtonElement;
const toastText = () => document.querySelector(".u-toast")?.textContent ?? "";

async function mount() {
  render(
    <>
      <ReviewPromptTab />
      <ToastHost />
    </>,
  );
  await screen.findByLabelText("判别准则");
}

test("固定头尾只读展示，判别准则是可编辑的当前值；默认时没有「已自定义」，恢复默认置灰", async () => {
  await mount();
  expect(screen.getByText("HEAD-FIXED").tagName).toBe("PRE");
  expect(screen.getByText("TAIL-FIXED").tagName).toBe("PRE");
  expect(box().value).toBe(DEFAULT);
  expect(screen.queryByText("已自定义")).toBeNull();
  expect(restore().disabled).toBe(true);
  expect(screen.queryByRole("region", { name: "保存" })).toBeNull();
});

test("读取失败：给原因和「重试」，重试后显示内容", async () => {
  api.getReviewPrompt.mockRejectedValueOnce(new ApiError(0, null));
  render(<ReviewPromptTab />);
  expect(await screen.findByText("读取审核提示词失败")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByLabelText("判别准则")).toBeTruthy();
});

test("改了出保存条；保存请求带去掉首尾空白的文本，成功后以服务端回来的为准", async () => {
  await mount();
  api.putReviewPrompt.mockResolvedValue(
    prompt({ criteria: "只许改 docs", custom: true }),
  );
  fireEvent.change(box(), { target: { value: "  只许改 docs  " } });
  expect(screen.getByRole("region", { name: "保存" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(api.putReviewPrompt).toHaveBeenCalledWith(null, "只许改 docs"),
  );
  await waitFor(() => expect(toastText()).toContain("已保存"));
  expect(screen.queryByRole("region", { name: "保存" })).toBeNull();
  expect(box().value).toBe("只许改 docs");
  expect(screen.getByText("已自定义")).toBeTruthy();
});

test("恢复默认：只是把草稿换回默认文本，点保存才提交；已经是默认时置灰", async () => {
  api.getReviewPrompt.mockResolvedValue(
    prompt({ criteria: "只许改 docs", custom: true }),
  );
  await mount();
  expect(screen.getByText("已自定义")).toBeTruthy();
  expect(restore().disabled).toBe(false);
  fireEvent.click(restore());
  expect(api.putReviewPrompt).not.toHaveBeenCalled();
  expect(box().value).toBe(DEFAULT);
  expect(restore().disabled).toBe(true);

  api.putReviewPrompt.mockResolvedValue(prompt());
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(api.putReviewPrompt).toHaveBeenCalledWith(null, DEFAULT),
  );
  await waitFor(() => expect(screen.queryByText("已自定义")).toBeNull());
});

test("清空或超长：行内提示原因，保存不发请求且草稿保留", async () => {
  await mount();
  fireEvent.change(box(), { target: { value: "   " } });
  expect(screen.getByText(/判别准则不能为空/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(toastText()).toContain("保存失败"));
  expect(api.putReviewPrompt).not.toHaveBeenCalled();

  fireEvent.change(box(), { target: { value: "x".repeat(51) } });
  expect(screen.getByText(/最多 50 个字符，现在 51 个/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(api.putReviewPrompt).not.toHaveBeenCalled());
  expect(box().value).toBe("x".repeat(51));
});

test("服务端拒绝：保存失败的提示里有原因，草稿保留", async () => {
  await mount();
  api.putReviewPrompt.mockRejectedValue(
    new ApiError(400, { error: "invalid_review_criteria" }),
  );
  fireEvent.change(box(), { target: { value: "新的" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(toastText()).toContain("保存失败：判别准则不合法"),
  );
  expect(box().value).toBe("新的");
  expect(screen.getByRole("region", { name: "保存" })).toBeTruthy();
});
