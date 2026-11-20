// 笔记「添加到对话」：选中的预览内容、没选中就是整篇，都带上来源标签进借用会话的输入草稿。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearToasts, ToastHost } from "../../../../ui";
import { ChatProvider, useChatHub } from "../../../chat";
import { BarSlotsProvider } from "../preview/BarSlots";
import { NoteView } from "./NoteView";

const TEXT = "# 标题\n\n第一段\n\n第二段\n";
vi.mock("../../../../api/canvas", async (orig) => ({
  ...(await orig<object>()),
  readCard: async () => ({
    ok: true,
    data: { text: TEXT, mtimeMs: 1, sha256: "x" },
  }),
}));

let hubOf: ReturnType<typeof useChatHub>;
function Probe() {
  hubOf = useChatHub();
  return null;
}

function Host({ sessionId }: { sessionId: string | null }) {
  const [tail, setTail] = useState<HTMLElement | null>(null);
  return (
    <ChatProvider token={null} onUnauthorized={() => {}}>
      <Probe />
      <ToastHost />
      <div ref={setTail} data-testid="bar" />
      <BarSlotsProvider value={{ lead: null, tail }}>
        <NoteView
          env="local"
          dir="/p"
          hostLabel="Server"
          path="想法/访谈.md"
          sessionId={sessionId}
          onDirtyChange={() => {}}
          onWikilink={() => {}}
          saveRef={{ current: null }}
        />
      </BarSlotsProvider>
    </ChatProvider>
  );
}

beforeEach(() => window.getSelection()?.removeAllRanges());
afterEach(() => {
  cleanup();
  clearToasts();
});

const quotes = () => hubOf.draftOf("s1").quotes.map((c) => c.quote);

async function ready() {
  await waitFor(() =>
    expect(document.querySelector(".cv-note-read p")).toBeTruthy(),
  );
  return screen.findByRole("button", { name: "添加到对话" });
}

test("没有选中：整篇笔记作为引用，来源是 .canvas 里的绝对路径加整篇行号", async () => {
  render(<Host sessionId="s1" />);
  fireEvent.click(await ready());
  expect(quotes()).toEqual([
    { label: "Server:/p/.canvas/想法/访谈.md:L1-L5", text: TEXT },
  ]);
  expect(await screen.findByText(/已添加到对话/)).toBeTruthy();
});

test("预览里选中了一段：只引用这一段，行号对上原文", async () => {
  render(<Host sessionId="s1" />);
  const button = await ready();
  const p = [...document.querySelectorAll(".cv-note-read p")].find(
    (x) => x.textContent === "第二段",
  ) as Element;
  const range = document.createRange();
  range.selectNodeContents(p);
  window.getSelection()?.addRange(range);
  fireEvent.click(button);
  expect(quotes()).toEqual([
    { label: "Server:/p/.canvas/想法/访谈.md:L5", text: "第二段" },
  ]);
});

test("没有可借用的会话：提示先打开对话，不往任何草稿里加", async () => {
  render(<Host sessionId={null} />);
  fireEvent.click(await ready());
  expect(
    await screen.findByText("先打开一个对话，才能把内容加进去"),
  ).toBeTruthy();
  expect(quotes()).toEqual([]);
});
