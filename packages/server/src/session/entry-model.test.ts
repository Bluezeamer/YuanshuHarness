import { describe, expect, test, vi } from "vitest";
import { SessionEntry } from "./pool.js";

// 直接构造 SessionEntry，不经过真实 SDK：只看它对 session 的调用。
function fake(model = { provider: "p", id: "a" }, thinkingLevel = "off") {
  const session = {
    model,
    thinkingLevel,
    subscribe: () => () => {},
    sessionManager: { appendCustomEntry: vi.fn() },
    dispose() {},
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(),
    prompt: vi.fn(async () => {}),
  };
  return { session, entry: new SessionEntry(session as never) };
}

describe("applyModel", () => {
  test("模型与档位都没变：什么都不调", async () => {
    const { session, entry } = fake();
    await entry.applyModel({ provider: "p", id: "a" } as never, "off");
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("同一个模型只改档位：只调 setThinkingLevel", async () => {
    const { session, entry } = fake();
    await entry.applyModel({ provider: "p", id: "a" } as never, "high");
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  test("换了模型：调 setModel，再按目标档位设置", async () => {
    const { session, entry } = fake();
    const b = { provider: "p", id: "b" };
    await entry.applyModel(b as never, "low");
    expect(session.setModel).toHaveBeenCalledWith(b);
    expect(session.setThinkingLevel).toHaveBeenCalledWith("low");
    // 换模型作废冻结物
    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "yuanshu.rebuild",
      {},
    );
  });

  test("供应商不同、模型 id 相同也算换了模型", async () => {
    const { session, entry } = fake();
    await entry.applyModel({ provider: "q", id: "a" } as never, null);
    expect(session.setModel).toHaveBeenCalledTimes(1);
  });
});

describe("holdSend", () => {
  const ticks = () => new Promise((r) => setTimeout(r, 20));

  test("发送要等被扣住的事做完才交给模型", async () => {
    const { session, entry } = fake();
    let release: () => void = () => {};
    entry.holdSend(new Promise<void>((r) => (release = r)));
    entry.send("hi");
    await ticks();
    expect(session.prompt).not.toHaveBeenCalled();
    release();
    await ticks();
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  test("被扣住的事失败了，发送照常进行", async () => {
    const { session, entry } = fake();
    entry.holdSend(Promise.reject(new Error("boom")));
    entry.send("hi");
    await ticks();
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  test("没有被扣住的事时发送不被拖延", async () => {
    const { session, entry } = fake();
    entry.send("hi");
    await Promise.resolve();
    await Promise.resolve();
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });
});

test("排队消息模式：创建 entry 时改成一次性全部注入", () => {
  const agent = {
    steeringMode: "one-at-a-time" as string,
    followUpMode: "one-at-a-time" as string,
  };
  const session = {
    model: { provider: "p", id: "a" },
    thinkingLevel: "off",
    subscribe: () => () => {},
    dispose() {},
    agent,
  };
  new SessionEntry(session as never);
  expect(agent.steeringMode).toBe("all");
  expect(agent.followUpMode).toBe("all");
});
