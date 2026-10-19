import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type PromptSpec, PromptTable } from "./prompts.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function table(timeoutMs = 1000) {
  const requested: string[] = [];
  const resolved: Array<{
    promptId: string;
    outcome: string;
    optionId?: string;
  }> = [];
  const t = new PromptTable(
    {
      requested: (d) => requested.push(d.promptId),
      resolved: (d) => resolved.push(d),
    },
    timeoutMs,
  );
  return { t, requested, resolved };
}
const choice: PromptSpec = {
  source: "approval",
  kind: "choice",
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
    expect(t.answer(id, { text: "x" })).toBe("bad_request");
    expect(t.list()).toHaveLength(1);

    void t.ask({ source: "question", kind: "input", title: "q" });
    const id2 = t.list()[1]?.promptId as string;
    for (const text of ["", "x".repeat(8001), 5, undefined])
      expect(t.answer(id2, { text })).toBe("bad_request");
    expect(t.list()).toHaveLength(2);
    expect(t.answer(id2, { text: "x".repeat(8000) })).toBeNull();
  });

  test("input 类弹窗 options 为空；答复文本不进 resolved 事件，但在记录里", async () => {
    const { t, resolved } = table();
    const p = t.ask({
      source: "question",
      kind: "input",
      title: "q",
      options: [{ id: "a", label: "a" }],
    });
    expect(t.list()[0]?.options).toEqual([]);
    t.answer(t.list()[0]?.promptId as string, { text: "密码是 hunter2" });
    expect(await p).toMatchObject({ text: "密码是 hunter2" });
    expect(JSON.stringify(resolved)).not.toContain("hunter2");
    expect(t.history()[0]).toMatchObject({ text: "密码是 hunter2" });
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
});
