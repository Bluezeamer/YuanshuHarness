import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeWS, frame, snapshot } from "../../../test/chatFakes";
import { ChatProvider } from "../context";
import { ExecView, type ExecViewProps } from "./ExecView";
import { forgetExecutions } from "./names";
import {
  FLOWS,
  installFlowsApi,
  exec as makeExec,
  type Server,
} from "./testkit";

const attachApi = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  attachmentBlob: vi.fn(),
  downloadAttachment: vi.fn(),
}));
vi.mock("../../../api/attachments", () => attachApi);

beforeEach(() => {
  attachApi.uploadAttachment.mockReset();
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  forgetExecutions();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wsFor = (id: string): FakeWS => {
  const w = FakeWS.all.find((x) => x.url.endsWith(`/sessions/${id}/stream`));
  if (!w)
    throw new Error(
      `没有 ${id} 的连接：${FakeWS.all.map((x) => x.url).join(",")}`,
    );
  return w;
};

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => q(sel)?.textContent ?? "";
const streamText = () => text("[data-chat-stream]");

// connect: all = 父会话与（清单里确有时才会连的）子会话都连上；parent = 只连父会话；none = 都不连
async function open(
  props: Partial<ExecViewProps> = {},
  server: Partial<Server> = {},
  connect: "all" | "parent" | "none" = "all",
) {
  const srv = installFlowsApi(server);
  render(
    <ChatProvider token="tok" onUnauthorized={() => {}}>
      <ExecView parentId="s1" execId="x1" {...props} />
    </ChatProvider>,
  );
  if (connect !== "none") {
    await act(async () => {
      wsFor("s1").serve(snapshot(1, []));
    });
  }
  if (connect === "all") {
    await waitFor(() => expect(wsFor(props.execId ?? "x1")).toBeTruthy());
    await act(async () => {
      wsFor(props.execId ?? "x1").serve(snapshot(1, []));
    });
  }
  return srv;
}

const serveChild = async (messages: Record<string, unknown>[]) => {
  await act(async () => {
    wsFor("x1").serve(snapshot(2, [], { messages }));
  });
};

test("头只有一行：状态点、名称、角色、状态与时长、上下文读条；模型 / 工具数在悬停卡片里", async () => {
  await open();
  await waitFor(() => expect(text("[data-ex=name]")).toBe("回归审阅"));
  expect(text("[data-ex=role]")).toBe("代码审查");
  expect(text("[data-ex=state]")).toMatch(/^运行中 .*2 分/);
  const bar = within(q("[data-ex=ctx]") as HTMLElement).getByRole("meter");
  expect(bar.getAttribute("aria-valuenow")).toBe("38000");
  expect(text("[data-ex=ctx]")).toContain("19%");
  // 头里不再平铺模型 / 工具数，悬停名称才出现
  expect(q(".ch-ex-head")?.textContent).not.toContain("Claude Opus 4.8");
  fireEvent.focus(q("[data-ex=name]") as HTMLElement);
  const card = await screen.findByRole("tooltip");
  expect(card.textContent).toContain("Claude Opus 4.8");
  expect(card.textContent).toContain("2 个");
  expect(card.textContent).toContain("38k / 200k");
});

test("正文复用主对话渲染：派发任务就是子会话第一条用户消息，助手消息按主渲染层显示", async () => {
  await open();
  await serveChild([
    {
      role: "user",
      text: "你是父会话派发的子代理，独立完成下面的任务。\n任务：\n核对重复投递",
    },
    { role: "assistant", text: "已检查，没有重复" },
  ]);
  const msgs = [
    ...document.querySelectorAll<HTMLElement>("[data-chat-stream] .ch-msg"),
  ];
  expect(msgs).toHaveLength(2);
  expect(msgs[0]?.classList.contains("ch-you")).toBe(true);
  expect(msgs[0]?.querySelector(".ch-bubble")?.textContent).toContain("任务：");
  expect(msgs[1]?.classList.contains("ch-agent")).toBe(true);
  expect(msgs[1]?.textContent).toContain("已检查，没有重复");
  // 不再有自绘的派发任务 / 轨迹 / 结论卡：任务只作为一条用户消息出现一次
  expect(q(".ch-ex-blk,.ch-ex-div,[data-exec-msg]")).toBeNull();
  expect(document.body.textContent?.match(/核对重复投递/g)).toHaveLength(1);
});

test("助手消息的思考与工具卡交给主渲染层：折叠思考、连续工具并成一条链", async () => {
  await open();
  await serveChild([
    {
      role: "assistant",
      text: "改好了",
      blocks: [
        { type: "thinking", text: "先看看依赖" },
        {
          type: "tool",
          id: "t1",
          name: "read",
          args: JSON.stringify({ path: "src/a.ts" }),
          result: "ok",
        },
        {
          type: "tool",
          id: "t2",
          name: "grep",
          args: JSON.stringify({ pattern: "retry", path: "src" }),
          result: "命中 2 处",
        },
        { type: "text", text: "改好了" },
      ],
    },
  ]);
  const think = await waitFor(() => {
    const el = q(".ch-think");
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  // 折成一行，点开才是全文
  expect(think.textContent).toBe("思考");
  fireEvent.click(within(think).getByRole("button"));
  expect(think.textContent).toContain("先看看依赖");
  // 相邻同类折成一组：read 一组、grep 一组
  const groups = [...document.querySelectorAll(".ch-group")].map(
    (g) => g.querySelector(".ch-glabel")?.textContent,
  );
  expect(groups).toEqual(["读取了 1 个文件", "搜索了 1 次"]);
});

test("流式输出按主渲染层：思考单行跟新、正文 partial、正在输入光标、工具参数生成中", async () => {
  await open();
  await act(async () => {
    wsFor("x1").serve(frame(2, "message.started", { role: "assistant" }));
    wsFor("x1").serve(
      frame(3, "message.delta", {
        kind: "thinking",
        text: "先看依赖\n再看测试",
      }),
    );
    wsFor("x1").serve(
      frame(4, "message.delta", { kind: "text", text: "结论是" }),
    );
  });
  await waitFor(() => expect(streamText()).toContain("结论是"));
  // 正文已开始流出：思考折成一行，光标跟在正文后
  expect(q(".ch-think")).toBeTruthy();
  expect(q(".ch-live")).toBeNull();
  expect(q(".ch-caret")).toBeTruthy();
  await act(async () => {
    wsFor("x1").serve(
      frame(5, "message.delta", {
        kind: "toolstart",
        toolCallId: "t9",
        toolName: "grep",
      }),
    );
    wsFor("x1").serve(
      frame(6, "message.delta", {
        kind: "toolarg",
        toolCallId: "t9",
        toolName: "grep",
        text: '{"pattern":"retry"}',
      }),
    );
  });
  // 参数生成中：只有一行预览，标签是工具名
  await waitFor(() => expect(q(".ch-live")).toBeTruthy());
  expect(text(".ch-live-k")).toBe("grep");
  await waitFor(() => expect(text(".ch-live-t")).toBe("retry"));
});

test("失败的执行体只在头部标失败：正文不再自绘结论卡", async () => {
  await open(
    {},
    {
      flows: {
        ...FLOWS,
        executions: [
          makeExec({
            state: "done",
            outcome: "failed",
            result: "模型调用超时",
          }),
        ],
      },
    },
  );
  await waitFor(() => expect(text("[data-ex=state]")).toMatch(/^失败/));
  expect(q(".ch-ex-blk")).toBeNull();
  expect(screen.queryByText("模型调用超时")).toBeNull();
});

test("发送只写子会话：子会话连接收到 send_message，父会话连接什么都没收到", async () => {
  await open();
  await waitFor(() => screen.getByRole("textbox", { name: /补充要求/ }));
  const box = screen.getByRole("textbox", {
    name: /补充要求/,
  }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "上限改成 8 分钟" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(wsFor("x1").commands("send_message")).toEqual([
    { id: "c1", type: "send_message", text: "上限改成 8 分钟" },
  ]);
  expect(wsFor("s1").commands("send_message")).toHaveLength(0);
  expect(box.value).toBe("");
});

test("补充要求也能带文件：传到子会话的附件区，只带附件也能发送", async () => {
  attachApi.uploadAttachment.mockImplementation(
    (_token, sessionId: string, file: File) =>
      Promise.resolve({
        ok: true,
        data: {
          name: file.name,
          mime: file.type,
          size: 1,
          path: `d/${file.name}`,
        },
        sessionId,
      }),
  );
  await open();
  await waitFor(() => screen.getByRole("textbox", { name: /补充要求/ }));
  const input = document.querySelector("[data-file-input]") as HTMLInputElement;
  Object.defineProperty(input, "files", {
    value: [new File(["x"], "spec.pdf", { type: "application/pdf" })],
    configurable: true,
  });
  fireEvent.change(input);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  // 上传到的是子会话自己的附件区
  expect(attachApi.uploadAttachment.mock.calls[0]?.[1]).toBe("x1");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(wsFor("x1").commands("send_message")).toMatchObject([
    { type: "send_message", text: "", attachments: [{ path: "d/spec.pdf" }] },
  ]);
});

test("发送按钮可用；Shift+Enter 换行不发送；空草稿禁用发送", async () => {
  await open();
  const box = (await waitFor(() =>
    screen.getByRole("textbox", { name: /补充要求/ }),
  )) as HTMLTextAreaElement;
  const send = screen.getByRole("button", {
    name: "发送",
  }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(box, { target: { value: "第一行" } });
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(wsFor("x1").commands("send_message")).toHaveLength(0);
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  expect(wsFor("x1").commands("send_message")).toHaveLength(1);
});

test("已不在运行态：显示提示；运行中不显示", async () => {
  await open();
  await waitFor(() => screen.getByText("回归审阅"));
  expect(q("[data-exec-stopped]")).toBeNull();
  cleanup();
  FakeWS.all = [];
  await open(
    {},
    {
      flows: {
        ...FLOWS,
        executions: [makeExec({ state: "done", outcome: "ok" })],
      },
    },
  );
  await waitFor(() => screen.getByText("回归审阅"));
  expect(text("[data-exec-stopped]")).toContain("不会进入父会话");
});

test("子会话断线：横幅提示正在重连（连接状态由执行体自己显示，不靠 ChatView）", async () => {
  await open();
  await act(async () => {
    wsFor("x1").drop();
  });
  const bar = await waitFor(() => {
    const el = q("[data-ex=conn]");
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  expect(bar.getAttribute("data-conn")).toBe("reconnecting");
  expect(bar.textContent).toContain("正在重连");
  expect(within(bar).queryByRole("button")).toBeNull();
});

test("子会话连接没就绪：给出原因并保留草稿，不吞错", async () => {
  await open({}, {}, "none");
  const box = (await waitFor(() =>
    screen.getByRole("textbox", { name: /补充要求/ }),
  )) as HTMLTextAreaElement;
  await act(async () => {
    wsFor("s1").serve(snapshot(1, []));
  });
  fireEvent.change(box, { target: { value: "补充一句" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(screen.getByRole("alert").textContent).toContain("连接");
  expect(box.value).toBe("补充一句");
  expect(wsFor("x1").commands("send_message")).toHaveLength(0);
});

test("清单里没有这个执行体：给空态，不渲染输入栏，也不去连它的子会话", async () => {
  await open({ execId: "ghost" }, {}, "parent");
  await waitFor(() => screen.getByText("这个执行体不存在"));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(FakeWS.all.map((w) => w.url)).toEqual([
    expect.stringContaining("/sessions/s1/stream"),
  ]);
});

test("清单取数失败：给原因与重试，重试成功后出内容", async () => {
  const srv = await open({}, { flows: 500 }, "parent");
  await waitFor(() => screen.getByText("无法载入执行体"));
  srv.flows = FLOWS;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(text("[data-ex=name]")).toBe("回归审阅"));
});

test("清单载入前显示载入中", async () => {
  await open({}, {}, "none");
  expect(text(".ch-ex-state")).toBe("载入中…");
});
