import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type PromptData,
  type PromptSpec,
  PromptTable,
  withUserNote,
} from "./prompts.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function table(timeoutMs = 1000) {
  const requested: PromptData[] = [];
  const resolved: Array<{
    promptId: string;
    outcome: string;
    optionId?: string;
  }> = [];
  const t = new PromptTable(
    {
      requested: (d) => requested.push(d),
      resolved: (d) => resolved.push(d),
    },
    timeoutMs,
  );
  return { t, requested, resolved };
}
const choice: PromptSpec = {
  source: "approval",
  title: "t",
  options: [
    { id: "allow", label: "通过" },
    { id: "deny", label: "拒绝" },
  ],
};

describe("R1/R2 先答先赢", () => {
  test("两次并发答复只有一个成功，第二次 prompt_resolved；落定事件只发一次", async () => {
    const { t, resolved } = table();
    const p = t.ask(choice);
    const id = t.list()[0]?.promptId as string;
    expect(t.answer(id, { optionId: "allow" })).toBeNull();
    expect(t.answer(id, { optionId: "deny" })).toBe("prompt_resolved");
    expect(await p).toEqual({ outcome: "answered", optionId: "allow" });
    expect(resolved).toEqual([
      { promptId: id, outcome: "answered", optionId: "allow" },
    ]);
    expect(t.answer("nope", { optionId: "allow" })).toBe("prompt_unknown");
  });

  test("非法 optionId / text 为 bad_request 且弹窗仍待处理", async () => {
    const { t } = table();
    void t.ask(choice);
    const id = t.list()[0]?.promptId as string;
    expect(t.answer(id, { optionId: "zzz" })).toBe("bad_request");
    expect(t.answer(id, { optionId: 5 })).toBe("bad_request");
    // 没有选项也没有输入框：光写字不行
    expect(t.answer(id, { text: "x" })).toBe("bad_request");
    // 两者都没有也不行
    expect(t.answer(id, {})).toBe("bad_request");
    expect(t.list()).toHaveLength(1);
  });

  test("有输入框的弹窗：文字答复的边界", async () => {
    const { t } = table();
    void t.ask({ source: "question", title: "q", input: "text" });
    const id = t.list()[0]?.promptId as string;
    for (const text of ["x".repeat(8001), 5])
      expect(t.answer(id, { text })).toBe("bad_request");
    // 空串当没给：既没有选项也没有别的，等于什么都没答
    expect(t.answer(id, { text: "" })).toBe("bad_request");
    expect(t.list()).toHaveLength(1);
    expect(t.answer(id, { text: "x".repeat(8000) })).toBeNull();
  });

  test("文字答复不进 resolved 事件，但在记录里", async () => {
    const { t, resolved } = table();
    const p = t.ask({ source: "question", title: "q", input: "text" });
    t.answer(t.list()[0]?.promptId as string, { text: "密码是 hunter2" });
    expect(await p).toMatchObject({ text: "密码是 hunter2" });
    expect(JSON.stringify(resolved)).not.toContain("hunter2");
    expect(t.history()[0]).toMatchObject({ text: "密码是 hunter2" });
  });
});

describe("R7 选项 + 文字可以一起给", () => {
  const both: PromptSpec = {
    source: "question",
    title: "接管",
    options: [
      { id: "done", label: "我已操作完成" },
      { id: "refuse", label: "拒绝" },
    ],
    input: "text",
  };

  test("选项与 input 原样带到 prompt.requested 的 data 上；没有选项时是 []", () => {
    const { t } = table();
    void t.ask(both);
    void t.ask({ source: "question", title: "q" });
    expect(t.list()[0]?.options).toEqual([
      { id: "done", label: "我已操作完成" },
      { id: "refuse", label: "拒绝" },
    ]);
    expect(t.list()[0]?.input).toBe("text");
    expect(t.list()[1]?.options).toEqual([]);
    // 没有输入框就不出现 input 字段
    expect(t.list()[1]).not.toHaveProperty("input");
    expect(t.list()[0]).not.toHaveProperty("kind");
    expect(t.list()[0]).not.toHaveProperty("rich");
    expect(t.list()[0]?.options[0]).not.toHaveProperty("needsText");
  });

  test("选项 + 文字：结果与记录都含两者", async () => {
    const { t, resolved } = table();
    const p = t.ask(both);
    expect(
      t.answer(t.list()[0]?.promptId as string, {
        optionId: "refuse",
        text: "我不能登录",
      }),
    ).toBeNull();
    expect(await p).toEqual({
      outcome: "answered",
      optionId: "refuse",
      text: "我不能登录",
    });
    expect(t.history()[0]).toMatchObject({
      optionLabel: "拒绝",
      text: "我不能登录",
    });
    // text 照样不进事件
    expect(JSON.stringify(resolved)).not.toContain("我不能登录");
  });

  test("空串文字等于没写：只算选了选项", async () => {
    const { t } = table();
    const p = t.ask(both);
    expect(
      t.answer(t.list()[0]?.promptId as string, {
        optionId: "done",
        text: "",
      }),
    ).toBeNull();
    expect(await p).toEqual({ outcome: "answered", optionId: "done" });
    expect(t.history()[0]?.text).toBeUndefined();
  });

  test("文字过长：bad_request 且弹窗仍在", () => {
    const { t } = table();
    void t.ask(both);
    const id = t.list()[0]?.promptId as string;
    expect(t.answer(id, { optionId: "refuse", text: "x".repeat(8001) })).toBe(
      "bad_request",
    );
    expect(t.list()).toHaveLength(1);
    expect(t.answer(id, { optionId: "refuse", text: "x".repeat(8000) })).toBe(
      null,
    );
  });
});

describe("R8 弹窗接受附件", () => {
  const images = [{ mimeType: "image/png", data: "QUJD" }];
  const rich: PromptSpec = {
    source: "question",
    title: "q",
    input: "rich",
  };

  test("input 只在有输入框时出现，值与形状一致", () => {
    const { t } = table();
    void t.ask(rich);
    void t.ask({ source: "question", title: "plain", input: "text" });
    expect(t.list()[0]?.input).toBe("rich");
    expect(t.list()[1]?.input).toBe("text");
  });

  test("rich 弹窗收 images：结果带回图片，记录里只有文字", async () => {
    const { t, resolved } = table();
    const p = t.ask(rich);
    const id = t.list()[0]?.promptId as string;
    expect(
      t.answer(id, { text: "看图\n\n[attach_file] x", images }),
    ).toBeNull();
    expect(await p).toEqual({
      outcome: "answered",
      text: "看图\n\n[attach_file] x",
      images,
    });
    expect(t.history()[0]?.text).toBe("看图\n\n[attach_file] x");
    expect(t.history()[0]).not.toHaveProperty("images");
    // 图片不进事件
    expect(JSON.stringify(resolved)).not.toContain("QUJD");
  });

  test("attached 没产生图片也算带附件：只在 rich 弹窗成立", async () => {
    const { t } = table();
    const p = t.ask(rich);
    expect(
      t.answer(t.list()[0]?.promptId as string, {
        text: "一个 pdf\n\n[attach_file] x",
        attached: true,
      }),
    ).toBeNull();
    expect(await p).toEqual({
      outcome: "answered",
      text: "一个 pdf\n\n[attach_file] x",
    });
  });

  test("input:text 与没有输入框的弹窗收到附件一律 bad_request，弹窗仍待处理", async () => {
    const { t } = table();
    void t.ask({ source: "question", title: "plain", input: "text" });
    void t.ask(choice);
    const plain = t.list()[0]?.promptId as string;
    const pick = t.list()[1]?.promptId as string;
    expect(t.answer(plain, { text: "x", images })).toBe("bad_request");
    expect(t.answer(plain, { text: "x", attached: true })).toBe("bad_request");
    expect(t.answer(pick, { optionId: "allow", images })).toBe("bad_request");
    expect(t.answer(pick, { optionId: "allow", attached: true })).toBe(
      "bad_request",
    );
    expect(t.list()).toHaveLength(2);
    // 不带附件时行为不变；空 images 数组当没有附件
    expect(t.answer(plain, { text: "x", images: [] })).toBeNull();
    expect(t.answer(pick, { optionId: "allow" })).toBeNull();
  });
});

describe("R3/R6 超时", () => {
  test("到期 timeout；答复后再到期无二次落定", async () => {
    const { t, resolved } = table(1000);
    const p1 = t.ask(choice);
    vi.advanceTimersByTime(1000);
    expect(await p1).toEqual({ outcome: "timeout" });
    expect(resolved).toHaveLength(1);
    expect(t.list()).toHaveLength(0);

    const p2 = t.ask(choice);
    t.answer(t.list()[0]?.promptId as string, { optionId: "allow" });
    // 答复必须清掉定时器，否则漏清的计时器会残留
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(await p2).toMatchObject({ outcome: "answered" });
    expect(resolved).toHaveLength(2);
  });

  test("expiresAt 是创建时刻加超时", () => {
    const { t } = table(60_000);
    void t.ask(choice);
    const exp = Date.parse(t.list()[0]?.expiresAt as string);
    expect(exp - Date.now()).toBe(60_000);
  });
});

describe("R4 撤销", () => {
  test("cancelAll 让所有待处理弹窗以 cancelled 落定", async () => {
    const { t, resolved } = table();
    const a = t.ask(choice);
    const b = t.ask(choice);
    t.cancelAll();
    expect(await a).toEqual({ outcome: "cancelled" });
    expect(await b).toEqual({ outcome: "cancelled" });
    expect(resolved.map((r) => r.outcome)).toEqual(["cancelled", "cancelled"]);
    expect(t.list()).toEqual([]);
  });

  test("signal 中止只撤销这一个提问，界面收到 resolved", async () => {
    const { t, resolved } = table();
    const stop = new AbortController();
    const a = t.ask(choice, stop.signal);
    const b = t.ask(choice);
    stop.abort();
    expect(await a).toEqual({ outcome: "cancelled" });
    expect(resolved.map((r) => r.outcome)).toEqual(["cancelled"]);
    expect(t.list()).toHaveLength(1);
    expect(
      t.answer(t.list()[0]?.promptId as string, { optionId: "allow" }),
    ).toBe(null);
    expect(await b).toEqual({ outcome: "answered", optionId: "allow" });
  });

  test("已经中止的 signal：不弹出提问，直接 cancelled", async () => {
    const { t, requested } = table();
    const stop = new AbortController();
    stop.abort();
    expect(await t.ask(choice, stop.signal)).toEqual({ outcome: "cancelled" });
    expect(requested).toEqual([]);
    expect(t.list()).toEqual([]);
  });

  test("落定后摘掉 abort 监听：长寿命的 signal 不会越积越多", async () => {
    const { t } = table();
    const events: string[] = [];
    const signal = {
      aborted: false,
      addEventListener: () => events.push("add"),
      removeEventListener: () => events.push("remove"),
    } as unknown as AbortSignal;
    const p = t.ask(choice, signal);
    t.answer(t.list()[0]?.promptId as string, { optionId: "allow" });
    await p;
    expect(events).toEqual(["add", "remove"]);
  });

  test("答复之后再中止 signal：无二次落定", async () => {
    const { t, resolved } = table();
    const stop = new AbortController();
    const p = t.ask(choice, stop.signal);
    t.answer(t.list()[0]?.promptId as string, { optionId: "allow" });
    await p;
    stop.abort();
    expect(resolved).toHaveLength(1);
  });
});

describe("withUserNote 把用户写的话接在拒绝原因后面", () => {
  test("有文字就追加，空白与原样保持", () => {
    expect(
      withUserNote("用户拒绝了该操作", {
        outcome: "answered",
        text: "  换个目录  ",
      }),
    ).toBe("用户拒绝了该操作\n用户补充：换个目录");
    expect(withUserNote("用户拒绝了该操作", { outcome: "answered" })).toBe(
      "用户拒绝了该操作",
    );
    expect(
      withUserNote("用户拒绝了该操作", { outcome: "answered", text: "   " }),
    ).toBe("用户拒绝了该操作");
    expect(withUserNote("用户拒绝了该操作", { outcome: "timeout" })).toBe(
      "用户拒绝了该操作",
    );
  });
});
