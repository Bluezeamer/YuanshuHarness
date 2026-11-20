import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FakeWS,
  frame,
  installChatApi,
  msgs,
  snapshot,
} from "../../test/chatFakes";
import { ChatProvider } from "./context";
import { useChatHub, useChatSession } from "./hooks";

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 测试用小组件：把 hook 的产出渲染成文本与一个输入框，行为全部走 actions。
function Probe({ id, label }: { id: string; label: string }) {
  const { state, actions, metrics, draft } = useChatSession(id);
  return (
    <section aria-label={label}>
      <output aria-label={`${label}-conn`}>{state.conn}</output>
      <output aria-label={`${label}-msgs`}>
        {state.messages.map((m) => m.text).join("|")}
      </output>
      <output aria-label={`${label}-goal`}>{state.goal?.text ?? "-"}</output>
      <output aria-label={`${label}-ctx`}>
        {metrics.line.ctxLabel ?? "-"}
      </output>
      <output aria-label={`${label}-err`}>
        {state.lastError
          ? `${state.lastError.code}:${state.lastError.message}`
          : "-"}
      </output>
      <textarea
        aria-label={`${label}-box`}
        value={draft.text}
        onChange={(e) => actions.setDraft(e.target.value)}
      />
      <button type="button" onClick={() => actions.send()}>
        {label}-发送
      </button>
      <button type="button" onClick={() => actions.setGoal("新目标")}>
        {label}-设目标
      </button>
    </section>
  );
}

function Two({ id = "s1" }: { id?: string }) {
  const [second, setSecond] = useState(true);
  return (
    <>
      <Probe id={id} label="a" />
      {second && <Probe id={id} label="b" />}
      <button type="button" onClick={() => setSecond(false)}>
        关第二个
      </button>
    </>
  );
}

function setup(ui = <Two />, token: string | null = "tok") {
  installChatApi(msgs(0, 3));
  const view = render(
    <ChatProvider token={token} onUnauthorized={() => {}}>
      {ui}
    </ChatProvider>,
  );
  return { view, ws: FakeWS.last };
}
const text = (label: string) => screen.getByLabelText(label).textContent;
const box = (label: string) =>
  screen.getByLabelText(label) as HTMLTextAreaElement;

test("连上之前是初始状态；快照到达后渲染", () => {
  const { ws } = setup(<Probe id="s1" label="a" />);
  expect(text("a-conn")).toBe("connecting");
  expect(text("a-msgs")).toBe("");
  act(() => ws.serve(snapshot(1, msgs(0, 3))));
  expect(text("a-conn")).toBe("open");
  expect(text("a-msgs")).toBe("m0|m1|m2");
});

test("R12 两个标签镜像同一会话只开一条连接；关掉一个连接保持，全卸载才关", () => {
  const { ws, view } = setup();
  expect(FakeWS.all).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "关第二个" }));
  expect(ws.closed).toBe(false);
  view.unmount();
  expect(ws.closed).toBe(true);
});

test("R11 一个标签的帧在两个标签里都显示；goal.updated 两边同一份", () => {
  const { ws } = setup();
  act(() => ws.serve(snapshot(1, msgs(0, 1))));
  act(() =>
    ws.serve(
      frame(2, "message.ended", { role: "assistant", text: "同步的话" }),
    ),
  );
  expect(text("a-msgs")).toBe("m0|同步的话");
  expect(text("b-msgs")).toBe("m0|同步的话");
  act(() =>
    ws.serve(
      frame(3, "goal.updated", {
        goal: {
          id: "g1",
          revision: 1,
          text: "补齐测试",
          by: "user",
          state: "active",
          maxRounds: 50,
          rounds: 0,
          since: "t",
          updatedAt: "t",
        },
      }),
    ),
  );
  expect(text("a-goal")).toBe("补齐测试");
  expect(text("b-goal")).toBe("补齐测试");
});

test("R11 一边打字另一边的输入立刻同步；发送后两边同时清空", () => {
  const { ws } = setup();
  act(() => ws.serve(snapshot(1, msgs(0, 1))));
  fireEvent.change(box("a-box"), { target: { value: "半截" } });
  expect(box("b-box").value).toBe("半截");
  fireEvent.click(screen.getByRole("button", { name: "b-发送" }));
  expect(ws.commands("send_message")).toEqual([
    { id: "c1", type: "send_message", text: "半截" },
  ]);
  expect(box("a-box").value).toBe("");
  expect(box("b-box").value).toBe("");
});

test("R14 切走再回来，草稿原样保留", () => {
  installChatApi(msgs(0, 1));
  function Switch() {
    const [id, setId] = useState("s1");
    return (
      <>
        <Probe id={id} label="a" />
        <button type="button" onClick={() => setId("s2")}>
          去乙
        </button>
        <button type="button" onClick={() => setId("s1")}>
          回甲
        </button>
      </>
    );
  }
  render(
    <ChatProvider token="tok" onUnauthorized={() => {}}>
      <Switch />
    </ChatProvider>,
  );
  fireEvent.change(box("a-box"), { target: { value: "没写完" } });
  fireEvent.click(screen.getByRole("button", { name: "去乙" }));
  expect(box("a-box").value).toBe("");
  expect(FakeWS.all[0]?.closed).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "回甲" }));
  expect(box("a-box").value).toBe("没写完");
});

test("R1 切换会话关闭旧连接，旧连接的帧不再改变界面", () => {
  installChatApi(msgs(0, 1));
  function Switch() {
    const [id, setId] = useState("s1");
    return (
      <>
        <Probe id={id} label="a" />
        <button type="button" onClick={() => setId("s2")}>
          去乙
        </button>
      </>
    );
  }
  render(
    <ChatProvider token="tok" onUnauthorized={() => {}}>
      <Switch />
    </ChatProvider>,
  );
  const old = FakeWS.last;
  act(() => old.serve(snapshot(1, msgs(0, 1))));
  fireEvent.click(screen.getByRole("button", { name: "去乙" }));
  expect(old.closed).toBe(true);
  expect(FakeWS.all).toHaveLength(2);
  act(() =>
    old.serve(
      frame(2, "message.ended", { role: "assistant", text: "旧会话的话" }),
    ),
  );
  expect(text("a-msgs")).toBe("");
});

test("命令被拒：lastError 带错误码与说明", () => {
  const { ws } = setup(<Probe id="s1" label="a" />);
  act(() => ws.serve(snapshot(1, msgs(0, 1))));
  fireEvent.click(screen.getByRole("button", { name: "a-设目标" }));
  act(() =>
    ws.serve({
      type: "ack",
      id: "c1",
      ok: false,
      error: { code: "bad_request", message: "text 不能为空" },
    }),
  );
  expect(text("a-err")).toBe("bad_request:text 不能为空");
});

test("metrics 随快照里的 usage 渲染，百分比带绝对值", () => {
  const { ws } = setup(<Probe id="s1" label="a" />);
  act(() =>
    ws.serve(
      snapshot(1, msgs(0, 1), {
        usage: {
          turns: 1,
          steps: 1,
          tokensPerSecond: null,
          modelMs: 1000,
          tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
          cacheHitRate: 0,
          context: { used: 76000, window: 200000, messages: 70000 },
        },
      }),
    ),
  );
  expect(text("a-ctx")).toBe("38% 76k/200k");
});

test("ChatProvider：令牌换新后新建的连接用新令牌", () => {
  installChatApi();
  function App({ token }: { token: string }) {
    const [show, setShow] = useState(true);
    return (
      <ChatProvider token={token} onUnauthorized={() => {}}>
        {show && <Probe id="s1" label="a" />}
        <button type="button" onClick={() => setShow((v) => !v)}>
          切换
        </button>
      </ChatProvider>
    );
  }
  const view = render(<App token="old" />);
  expect(FakeWS.last.protocols).toEqual(["yuanshu.v1", "bearer.old"]);
  view.rerender(<App token="new" />);
  fireEvent.click(screen.getByRole("button", { name: "切换" }));
  fireEvent.click(screen.getByRole("button", { name: "切换" }));
  expect(FakeWS.last.protocols).toEqual(["yuanshu.v1", "bearer.new"]);
});

test("useChatHub 在 Provider 之外使用会报错", () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  function Bad() {
    useChatHub();
    return null;
  }
  expect(() => render(<Bad />)).toThrow(/ChatProvider/);
  err.mockRestore();
});
