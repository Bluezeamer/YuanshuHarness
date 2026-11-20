import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PromptEntry } from "./flowLog";
import { PromptPager } from "./PromptPager";
import { approval, question } from "./testkit";

vi.mock("../../../api/attachments", () => ({
  uploadAttachment: vi.fn(),
  attachmentBlob: vi.fn(),
  downloadAttachment: vi.fn(),
}));

afterEach(cleanup);

const entry = (prompt: PromptEntry["prompt"], seq: number): PromptEntry => ({
  seq,
  at: 0,
  prompt,
  status: "pending",
});

// getByText 不看 hidden：看得见 = 文字在、且祖先里没有 hidden
const shown = (text: string | RegExp) => {
  const el = screen.queryByText(text);
  return el !== null && el.closest("[hidden]") === null;
};

const asks = [
  entry(question("a", { title: "问题甲", options: [], input: "rich" }), 1),
  entry(question("b", { title: "问题乙", options: [], input: "rich" }), 2),
  entry(approval("c", { title: "要审批的丙" }), 3),
];

const mount = (entries: readonly PromptEntry[], onAnswer = vi.fn()) => {
  const view = render(
    <PromptPager
      entries={entries}
      sessionId="s1"
      errorOf={() => null}
      onAnswer={onAnswer}
    />,
  );
  return {
    onAnswer,
    rerender: (next: readonly PromptEntry[]) =>
      view.rerender(
        <PromptPager
          entries={next}
          sessionId="s1"
          errorOf={() => null}
          onAnswer={onAnswer}
        />,
      ),
  };
};

test("只有一个待答弹窗：就是那张卡，没有切换器", () => {
  mount([asks[0] as PromptEntry]);
  expect(screen.getByText("问题甲")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "待答的弹窗" })).toBeNull();
});

test("几个同时待答：合成一处，一次只显示一张，卡头里「‹ 1 / 3 ›」来回切换（首尾相接）", () => {
  mount(asks);
  const pager = screen.getByRole("group", { name: "待答的弹窗" });
  expect(pager.textContent).toContain("1 / 3");
  expect(shown("问题甲")).toBe(true);
  expect(shown("问题乙")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "下一个" }));
  expect(shown("问题乙")).toBe(true);
  expect(shown("问题甲")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "下一个" }));
  expect(shown(/要审批的丙/)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "下一个" }));
  expect(shown("问题甲")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "上一个" }));
  expect(shown(/要审批的丙/)).toBe(true);
});

test("切走再切回：写了一半的回答还在", () => {
  mount(asks);
  const box = () => screen.getByRole("textbox", { name: "回答" });
  fireEvent.change(box(), { target: { value: "写到一半" } });
  fireEvent.click(screen.getByRole("button", { name: "下一个" }));
  fireEvent.click(screen.getByRole("button", { name: "上一个" }));
  expect((box() as HTMLTextAreaElement).value).toBe("写到一半");
});

test("当前这张答完离开待答列表：落到剩下的第一张，计数跟着变；只剩一张时切换器消失", () => {
  const { rerender } = mount(asks);
  fireEvent.click(screen.getByRole("button", { name: "下一个" }));
  expect(shown("问题乙")).toBe(true);
  rerender([asks[0] as PromptEntry, asks[2] as PromptEntry]);
  expect(shown("问题甲")).toBe(true);
  expect(screen.getByRole("group").textContent).toContain("1 / 2");
  rerender([asks[2] as PromptEntry]);
  expect(shown(/要审批的丙/)).toBe(true);
  expect(screen.queryByRole("group", { name: "待答的弹窗" })).toBeNull();
});
