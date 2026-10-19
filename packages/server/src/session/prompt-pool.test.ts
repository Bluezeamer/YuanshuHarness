import { afterAll, afterEach, describe, expect, test } from "vitest";
import {
  collector,
  expectContiguous,
  waitFor,
} from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { PoolError } from "./pool.js";

// 第一次请求让模型调用 ask_user，拿到工具结果后的第二次请求回一句话。
const stub = await startStub((n, body) => {
  const msgs = (body.messages ?? []) as Array<{
    role: string;
    content?: unknown;
  }>;
  const last = msgs[msgs.length - 1];
  if (last?.role === "tool") return `got:${String(last.content)}`;
  return n % 2 === 1 ? { tool: "ask_user", args: ASK.current } : "unreachable";
});
const ASK: { current: Record<string, unknown> } = {
  current: { question: "选哪个？", options: ["甲", "乙"] },
};
afterAll(() => stub.close());

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  stub.requests.length = 0;
});

async function setup(promptTimeoutMs?: number) {
  const t = testPool(
    stubSessionFactory(stub),
    testData(),
    promptTimeoutMs ? { promptTimeoutMs } : {},
  );
  cleanups.push(
    () => t.data.close(true),
    () => t.pool.dispose(),
  );
  const id = (await t.pool.create()).id;
  const entry = t.pool.get(id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c);
  return { ...t, id, entry, c };
}
const pending = (c: ReturnType<typeof collector>) =>
  c.frames.find((f) => f.type === "prompt.requested");
const endedN =
  (c: ReturnType<typeof collector>, n = 1) =>
  () =>
    c.types().filter((t) => t === "run.ended").length >= n;

describe("ask_user 端到端", () => {
  test("choice：requested → 快照可见 → 答复 → resolved → 工具结果回模型", async () => {
    ASK.current = { question: "选哪个？", options: ["甲", "乙"] };
    const { entry, c } = await setup();
    entry.send("开始");
    await waitFor(() => pending(c) !== undefined, "prompt.requested");
    const req = pending(c);
    expect(req?.data).toMatchObject({
      source: "question",
      kind: "choice",
      title: "选哪个？",
      options: [
        { id: "0", label: "甲" },
        { id: "1", label: "乙" },
      ],
    });
    expect(typeof req?.data.expiresAt).toBe("string");
    // 另一个订阅者此刻加入：快照带 prompts，且 seq 与之对应。
    const late = collector();
    entry.subscribe(late);
    expect(late.frames[0]?.data.prompts).toEqual([req?.data]);
    expect(late.frames[0]?.seq).toBe(req?.seq);

    entry.answerPrompt(req?.data.promptId, { optionId: "1" });
    await waitFor(endedN(c), "run.ended");
    expect(c.frames.find((f) => f.type === "prompt.resolved")?.data).toEqual({
      promptId: req?.data.promptId,
      outcome: "answered",
      optionId: "1",
    });
    expect(JSON.stringify(stub.requests.at(-1)?.body)).toContain("乙");
    expectContiguous(c.frames);
    expect(entry.prompts.list()).toEqual([]);
  });

  test("resync：有待处理弹窗时重发的快照仍带 prompts，序号与之对应", async () => {
    ASK.current = { question: "选哪个？", options: ["甲", "乙"] };
    const { entry, c } = await setup();
    entry.send("开始");
    await waitFor(() => pending(c) !== undefined, "prompt.requested");
    const req = pending(c);
    const again = collector();
    entry.subscribe(again);
    entry.resync(again);
    const snap = again.frames.at(-1);
    expect(snap?.data.prompts).toEqual([req?.data]);
    expect(snap?.seq).toBe(req?.seq);
    entry.answerPrompt(req?.data.promptId, { optionId: "0" });
    await waitFor(endedN(c), "run.ended");
  });

  test("input：无 options 时自由文本；答复后第二次答复 prompt_resolved", async () => {
    ASK.current = { question: "叫什么？" };
    const { entry, c } = await setup();
    entry.send("开始");
    await waitFor(() => pending(c) !== undefined, "requested");
    const id = pending(c)?.data.promptId;
    expect(pending(c)?.data).toMatchObject({ kind: "input", options: [] });
    entry.answerPrompt(id, { text: "小明" });
    expect(() => entry.answerPrompt(id, { text: "小红" })).toThrow(PoolError);
    try {
      entry.answerPrompt(id, { text: "小红" });
    } catch (e) {
      expect((e as PoolError).code).toBe("prompt_resolved");
    }
    await waitFor(endedN(c), "run.ended");
    expect(JSON.stringify(stub.requests.at(-1)?.body)).toContain("小明");
  });

  test("stop 撤销待处理弹窗并结束运行", async () => {
    ASK.current = { question: "q", options: ["a", "b"] };
    const { entry, c } = await setup();
    entry.send("开始");
    await waitFor(() => pending(c) !== undefined, "requested");
    await entry.stop();
    await waitFor(endedN(c), "run.ended");
    expect(
      c.frames.find((f) => f.type === "prompt.resolved")?.data.outcome,
    ).toBe("cancelled");
  });

  test("超时：resolved(timeout)，工具得到“用户未回答”，运行继续", async () => {
    ASK.current = { question: "q", options: ["a", "b"] };
    const { entry, c } = await setup(50);
    entry.send("开始");
    await waitFor(endedN(c), "run.ended");
    expect(
      c.frames.find((f) => f.type === "prompt.resolved")?.data.outcome,
    ).toBe("timeout");
    expect(JSON.stringify(stub.requests.at(-1)?.body)).toContain("用户未回答");
  });

  test("删除会话与池关闭都撤销待处理弹窗，不留悬挂", async () => {
    ASK.current = { question: "q", options: ["a", "b"] };
    const { entry, c, pool } = await setup();
    entry.send("开始");
    await waitFor(() => pending(c) !== undefined, "requested");
    pool.dispose();
    expect(entry.prompts.list()).toEqual([]);
    expect(entry.prompts.history()[0]).toMatchObject({ outcome: "cancelled" });
  });
});
