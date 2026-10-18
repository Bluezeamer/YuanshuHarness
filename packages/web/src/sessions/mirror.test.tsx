import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { ConversationView } from "../ChatView";
import { FakeWS, frame, installApi, msgs, snapshot } from "../fakes";
import { SessionHub } from "./hub";

const session = {
  id: "s1",
  name: "甲",
  createdAt: "t",
  updatedAt: "t",
  running: false,
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

// 两个 pane 绑定同一会话；按钮可以卸载其中一个。
function Two({ hub }: { hub: SessionHub }) {
  const [second, setSecond] = useState(true);
  return (
    <>
      <section aria-label="pane-a">
        <ConversationView hub={hub} session={session} />
      </section>
      {second && (
        <section aria-label="pane-b">
          <ConversationView hub={hub} session={session} />
        </section>
      )}
      <button type="button" onClick={() => setSecond(false)}>
        关第二个
      </button>
    </>
  );
}

function setup() {
  const history = msgs(0, 3);
  installApi(history);
  const hub = new SessionHub();
  render(<Two hub={hub} />);
  const ws = FakeWS.last;
  act(() => ws.serve(snapshot(1, history)));
  const boxes = () => {
    const [a, b] = screen.getAllByLabelText(
      "输入消息",
    ) as HTMLTextAreaElement[];
    if (!a || !b) throw new Error("需要两个输入框");
    return [a, b] as const;
  };
  return { hub, ws, boxes };
}

test("R12 同一会话两个 pane 只开一条连接", () => {
  setup();
  expect(FakeWS.all).toHaveLength(1);
});

test("R11 一个 pane 里的帧在两个 pane 里都显示", () => {
  const { ws } = setup();
  act(() =>
    ws.serve(
      frame(2, "message.ended", { role: "assistant", text: "同步的话" }),
    ),
  );
  expect(screen.getAllByText("同步的话")).toHaveLength(2);
});

test("R11 一边打字，另一边的输入栏立刻出现；发送后两边同时清空", () => {
  const { ws, boxes } = setup();
  fireEvent.change(boxes()[0], { target: { value: "半截" } });
  expect(boxes()[1].value).toBe("半截");
  fireEvent.keyDown(boxes()[1], { key: "Enter" });
  expect(ws.sent.some((m) => m.type === "send_message")).toBe(true);
  expect(boxes()[0].value).toBe("");
  expect(boxes()[1].value).toBe("");
});

test("R12 关掉一个 pane 连接保持；最后一个释放才关闭", () => {
  const { ws } = setup();
  fireEvent.click(screen.getByRole("button", { name: "关第二个" }));
  expect(ws.closed).toBe(false);
  cleanup();
  expect(ws.closed).toBe(true);
});
