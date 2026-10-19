import { describe, expect, test } from "vitest";
import { type Frame, Renderer } from "./render.js";

let seq = 0;
const f = (type: string, data: Record<string, unknown> = {}): Frame => ({
  session: "s",
  seq: ++seq,
  ts: "",
  type,
  data,
});

function run(frames: Frame[]) {
  const r = new Renderer();
  let out = "";
  let err = "";
  for (const fr of frames) {
    const x = r.render(fr);
    out += x.out;
    err += x.err;
  }
  return { out, err, r };
}

describe("渲染（R5、R6）", () => {
  test("快照：先最近消息，再 partial 且保持生成中；之后的增量接在 partial 后面", () => {
    const { out, r } = run([
      f("snapshot", {
        messages: [
          { role: "user", text: "hi" },
          { role: "assistant", text: "hello" },
        ],
        partial: { role: "assistant", text: "abc" },
        queue: [],
      }),
    ]);
    expect(out).toBe("[你] hi\n[助手] hello\n[助手] abc");
    expect(r.generating).toBe(true);
    const more = [
      f("message.delta", { kind: "text", text: "def" }),
      f("message.ended", { role: "assistant", text: "abcdef" }),
    ].map((x) => r.render(x).out);
    expect(more.join("")).toBe("def\n");
    expect(r.generating).toBe(false);
  });

  test("文本增量直接追加不换行，ended 收尾换行", () => {
    const { out } = run([
      f("message.started", { role: "assistant", text: "" }),
      f("message.delta", { kind: "text", text: "你" }),
      f("message.delta", { kind: "text", text: "好" }),
      f("message.ended", { role: "assistant", text: "你好" }),
    ]);
    expect(out).toBe("[助手] 你好\n");
  });

  test("思考增量与未识别的事件类型不显示、不报错", () => {
    const { out, err } = run([
      f("message.delta", { kind: "thinking", text: "secret thoughts" }),
      f("prompt.future", { x: 1 }),
    ]);
    expect(out).toBe("");
    expect(err).toBe("");
  });

  test("工具行：开始与结束各一行，失败标明；行中间时先补换行", () => {
    const { out } = run([
      f("message.started", { role: "assistant" }),
      f("message.delta", { kind: "text", text: "查一下" }),
      f("tool.started", { toolName: "bash" }),
      f("tool.ended", { toolName: "bash", isError: false }),
      f("tool.started", { toolName: "read" }),
      f("tool.ended", { toolName: "read", isError: true }),
    ]);
    expect(out).toBe(
      "[助手] 查一下\n[工具] bash 开始\n[工具] bash 完成\n[工具] read 开始\n[工具] read 失败\n",
    );
  });

  test("run.failed 写 stderr；用户消息在 ended 时整条打印一次", () => {
    const { out, err } = run([
      f("message.started", { role: "user", text: "q" }),
      f("message.ended", { role: "user", text: "q" }),
      f("run.failed", { message: "boom" }),
    ]);
    expect(out).toBe("[你] q\n");
    expect(err).toBe("运行失败：boom\n");
  });

  test("排队行只在条数变化时打印；快照里的队列作为基线", () => {
    const { out } = run([
      f("snapshot", { messages: [], partial: null, queue: ["a"] }),
      f("queue.updated", { queue: ["a"] }),
      f("queue.updated", { queue: ["a", "b"] }),
      f("queue.updated", { queue: [] }),
    ]);
    expect(out).toBe("[排队] 2 条\n[排队] 0 条\n");
  });
});

describe("弹窗渲染（prompt-dialog R10）", () => {
  const q = {
    promptId: "p1",
    source: "question",
    kind: "choice",
    title: "选哪个？",
    options: [
      { id: "0", label: "甲" },
      { id: "1", label: "乙" },
    ],
  };
  test("requested 显示问题与编号选项并登记待答；resolved 清掉", () => {
    const { out, r } = run([f("prompt.requested", q)]);
    expect(out).toContain("[提问] 选哪个？");
    expect(out).toContain("1. 甲");
    expect(out).toContain("2. 乙");
    expect(r.pendingPrompts).toHaveLength(1);
    const x = r.render(
      f("prompt.resolved", { promptId: "p1", outcome: "timeout" }),
    );
    expect(x.out).toContain("已超时");
    expect(r.pendingPrompts).toHaveLength(0);
  });
  test("快照里的 prompts 取代本地待答集合", () => {
    const { r } = run([
      f("prompt.requested", q),
      f("snapshot", { messages: [], partial: null, queue: [], prompts: [] }),
    ]);
    expect(r.pendingPrompts).toHaveLength(0);
  });
});
