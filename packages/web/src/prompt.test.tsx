import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "./api";
import { type Frame, initial, reduce } from "./conversation";
import { FakeWS, frame, installApi, msgs, snapshot } from "./fakes";
import { Shell } from "./Shell";

const session = (id: string, name: string) => ({
  id,
  name,
  createdAt: "t",
  updatedAt: "t",
  running: false,
});

const approval = {
  promptId: "p1",
  source: "approval",
  kind: "choice",
  title: "允许执行 bash？",
  options: [
    { id: "allow", label: "允许" },
    { id: "deny", label: "拒绝" },
    { id: "remember", label: "允许并记住" },
  ],
  detail: { tool: "bash", summary: "rm -rf build" },
  expiresAt: Date.now() + 90_000,
};
const question = {
  promptId: "p2",
  source: "question",
  kind: "input",
  title: "项目叫什么？",
  options: [],
  expiresAt: Date.now() + 60_000,
};

beforeEach(() => {
  FakeWS.all = [];
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(prompts: object[] = []) {
  installApi(msgs(0, 2));
  render(<Shell sessions={[session("s1", "甲")]} onUnauthorized={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  const ws = FakeWS.last;
  act(() => ws.serve(snapshot(1, msgs(0, 2), { prompts })));
  return ws;
}
const serve = (ws: FakeWS, o: unknown) => act(() => ws.serve(o));

test("reduce 丢弃坏数据、去重，resolved 移除对应弹窗", () => {
  const f = (type: string, data: Record<string, unknown>) =>
    frame(2, type, data) as Frame;
  let s = reduce(initial, f("prompt.requested", { nope: 1 }));
  expect(s.prompts).toEqual([]);
  s = reduce(s, f("prompt.requested", approval));
  s = reduce(s, f("prompt.requested", approval));
  expect(s.prompts).toHaveLength(1);
  s = reduce(s, f("prompt.resolved", { promptId: "zz", outcome: "answered" }));
  expect(s.prompts).toHaveLength(1);
  s = reduce(s, f("prompt.resolved", { promptId: "p1", outcome: "timeout" }));
  expect(s.prompts).toEqual([]);
});

test("审批弹窗展示工具与摘要，焦点在拒绝，三个选项", () => {
  const ws = open();
  serve(ws, frame(2, "prompt.requested", approval));
  const dlg = screen.getByRole("dialog");
  expect(dlg.textContent).toContain("bash");
  expect(dlg.textContent).toContain("rm -rf build");
  expect(dlg.textContent).toContain("会话：甲");
  expect(dlg.textContent).toMatch(/剩余 1:\d\d/);
  expect(screen.getAllByRole("button", { name: /允许|拒绝/ })).toHaveLength(3);
  expect(document.activeElement?.textContent).toBe("拒绝");
});

test("点选发送 answer_prompt；成功以 prompt.resolved 为准才关闭", () => {
  const ws = open();
  serve(ws, frame(2, "prompt.requested", approval));
  fireEvent.click(screen.getByRole("button", { name: "允许并记住" }));
  const cmd = ws.sent.find((c) => c.type === "answer_prompt");
  expect(cmd).toMatchObject({ promptId: "p1", optionId: "remember" });
  serve(ws, { type: "ack", id: cmd?.id, ok: true });
  expect(screen.getByRole("dialog")).toBeTruthy();
  serve(
    ws,
    frame(3, "prompt.resolved", {
      promptId: "p1",
      outcome: "answered",
      optionId: "remember",
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("多端先答先赢：别处答复的 resolved 让本端自动关闭", () => {
  const ws = open([approval]);
  expect(screen.getByRole("dialog")).toBeTruthy();
  serve(
    ws,
    frame(2, "prompt.resolved", { promptId: "p1", outcome: "answered" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("快照补发待处理弹窗；重连快照里没有则消失", () => {
  const ws = open([approval]);
  expect(screen.getByRole("dialog")).toBeTruthy();
  serve(ws, snapshot(9, msgs(0, 2), { prompts: [] }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each([
  ["prompt_resolved", "已被其他端答复"],
  ["prompt_unknown", "已不存在"],
  ["bad_request", "答复无效"],
])("ack 失败 %s 给出可理解提示且可再试", (code, text) => {
  const ws = open([approval]);
  fireEvent.click(screen.getByRole("button", { name: "允许" }));
  const cmd = ws.sent.find((c) => c.type === "answer_prompt");
  serve(ws, { type: "ack", id: cmd?.id, ok: false, error: { code } });
  expect(screen.getByRole("alert").textContent).toContain(text);
  expect(
    (screen.getByRole("button", { name: "允许" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("input 弹窗提交文本，空白不可提交", () => {
  const ws = open([question]);
  const submit = screen.getByRole("button", {
    name: "提交",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("你的回答"), {
    target: { value: "元枢" },
  });
  fireEvent.click(submit);
  expect(ws.sent.find((c) => c.type === "answer_prompt")).toMatchObject({
    promptId: "p2",
    text: "元枢",
  });
});

test("Esc 不关闭弹窗也不发命令；背景 inert", () => {
  const ws = open([approval]);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(ws.sent.some((c) => c.type === "answer_prompt")).toBe(false);
  expect(screen.getByLabelText("输入消息").closest("[inert]")).toBeTruthy();
});

test("Tab 在弹窗内循环", () => {
  open([approval]);
  const last = screen.getByRole("button", { name: "允许并记住" });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement?.textContent).toBe("允许");
});

test("多个弹窗按序处理并提示剩余数", () => {
  const ws = open([approval, question]);
  expect(screen.getByRole("dialog").textContent).toContain("另有 1 项");
  serve(
    ws,
    frame(2, "prompt.resolved", { promptId: "p1", outcome: "answered" }),
  );
  expect(screen.getByRole("dialog").textContent).toContain("项目叫什么");
});

test("切到其他会话再回来，弹窗仍在（状态在 store/快照里）", () => {
  const ws = open([approval]);
  expect(screen.getByRole("dialog")).toBeTruthy();
  // 断线重连后新快照仍带待处理弹窗
  act(() => ws.drop());
  expect(screen.getByRole("dialog")).toBeTruthy();
});
