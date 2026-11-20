import { describe, expect, test } from "vitest";
import type { GoalNotice } from "./goal.js";
import { GoalDriver, type GoalHost } from "./goal-driver.js";
import { SessionStateHolder } from "./session-state.js";

// 可控的假会话：record 里有 note / inject / stop 的调用；busy 与 pending 由用例拨。
type Images = { mimeType: string; data: string }[];
type Call =
  | { kind: "note"; notice: GoalNotice }
  | { kind: "inject"; text: string; notice: GoalNotice; images?: Images }
  | { kind: "stop" };

function harness(o: { maxRounds?: number | null } = {}) {
  const calls: Call[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const flags = { busy: false, pending: false };
  const host = {
    flags,
    host: {
      busy: () => flags.busy,
      hasPendingWork: () => flags.pending,
      inject: (text, notice, images) =>
        calls.push({
          kind: "inject",
          text,
          notice,
          ...(images ? { images } : {}),
        }),
      note: (notice) => calls.push({ kind: "note", notice }),
      stop: async () => {
        calls.push({ kind: "stop" });
      },
      defaultMaxRounds: () => o.maxRounds ?? 50,
    } satisfies GoalHost,
  };
  const state = new SessionStateHolder("s1", undefined, (type, data) =>
    events.push({ type, data }),
  );
  const driver = new GoalDriver(host.host, state);
  const injected = () => calls.filter((c) => c.kind === "inject");
  const notes = () => calls.filter((c) => c.kind === "note");
  // 等 setImmediate 那一拍。
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { calls, events, state, driver, host, injected, notes, tick };
}

// 模拟「注入的一轮跑完」：开始 → （可选工具调用）→ 结束。
function round(
  h: ReturnType<typeof harness>,
  o: { tools?: number; error?: string; aborted?: boolean } = {},
) {
  h.driver.runStarted();
  for (let i = 0; i < (o.tools ?? 0); i++) h.driver.toolStarted();
  h.driver.runEnded({
    aborted: o.aborted ?? false,
    error: o.error,
    text: "",
  });
}

describe("续跑条件", () => {
  test("active 且完全空闲才注入一轮，rounds 记 1", async () => {
    const h = harness();
    h.driver.create("把测试跑绿");
    await h.tick();
    expect(h.injected()).toHaveLength(1);
    const first = h.injected()[0];
    expect(first?.text).toContain("[Goal round 1/50]");
    expect(first?.notice).toEqual({
      event: "round",
      goalId: h.state.goal?.id,
      revision: 2,
      round: 1,
      maxRounds: 50,
    });
    expect(h.state.goal?.rounds).toBe(1);
  });

  test("会话在跑、有待处理工作、目标不是 active 都不注入", async () => {
    const h = harness();
    h.driver.create("g");
    h.host.flags.busy = true;
    await h.tick();
    expect(h.injected()).toHaveLength(0);

    h.host.flags.busy = false;
    h.host.flags.pending = true;
    h.driver.settled();
    await h.tick();
    expect(h.injected()).toHaveLength(0);

    h.host.flags.pending = false;
    await h.driver.pause();
    await h.tick();
    expect(h.injected()).toHaveLength(0);
    expect(h.state.goal?.state).toBe("paused");
  });

  test("settled() 幂等：并发调用只注入一次", async () => {
    const h = harness();
    h.driver.create("g");
    for (let i = 0; i < 5; i++) h.driver.settled();
    await h.tick();
    expect(h.injected()).toHaveLength(1);
  });
});

const files = [
  {
    name: "a.png",
    mime: "image/png",
    sizeText: "1 B",
    path: "./2026-11-20/aaaaaaa1-a.png",
  },
];
const images = [{ mimeType: "image/png", data: "QUJD" }];

describe("目标附件", () => {
  test("带附件建目标：卡片带 files，只有第一轮带图，之后每轮只带标记行", async () => {
    const h = harness();
    h.driver.create("看图", { attachments: files, images });
    await h.tick();
    expect(h.injected()[0]?.images).toEqual(images);
    expect(h.injected()[0]?.text).toContain("[attach_file] attachment:");
    expect(h.state.goal?.attachments).toEqual(files);
    expect(h.notes()[0]).toMatchObject({ notice: { files: ["a.png"] } });

    round(h);
    await h.tick();
    expect(h.injected()[1]?.images).toBeUndefined();
    expect(h.injected()[1]?.text).toContain("[attach_file] attachment:");
    await h.driver.pause();
  });

  test("改附件：替换待带图，下一轮再带一次；不给 content 不动附件也不动待带图", async () => {
    const h = harness();
    h.driver.create("看图", { attachments: files, images });
    await h.tick();
    round(h);
    await h.tick();
    expect(h.injected()[1]?.images).toBeUndefined();

    // 只改文本：附件与待带图都不动
    h.driver.edit({ text: "换个说法" });
    await h.tick();
    expect(h.injected()[2]?.images).toBeUndefined();
    expect(h.injected()[2]?.text).toContain("[attach_file] attachment:");
    expect(h.state.goal?.attachments).toEqual(files);

    // 换附件：下一轮再带一次图
    h.driver.edit({ content: { attachments: [], images: [] } });
    await h.tick();
    expect(h.injected()[3]?.images).toBeUndefined();
    expect(h.injected()[3]?.text).not.toContain("[attach_file]");
    expect(h.state.goal?.attachments).toBeUndefined();
    expect(h.notes().at(-1)).toMatchObject({
      notice: { event: "edited", files: [] },
    });
    await h.driver.pause();
  });

  test("改附件带图：下一轮带图", async () => {
    const h = harness();
    h.driver.create("看图");
    await h.tick();
    h.driver.edit({ content: { attachments: files, images } });
    await h.tick();
    expect(h.injected().at(-1)?.images).toEqual(images);
    await h.driver.pause();
  });

  test("清除目标时一并清掉待带图：不会跑到下一个目标的第一轮里", async () => {
    const h = harness();
    // busy 挡住续跑：待带图还没被取走
    h.host.flags.busy = true;
    h.driver.create("看图", { attachments: files, images });
    h.driver.clear();
    h.driver.create("再一个");
    h.host.flags.busy = false;
    await h.tick();
    expect(h.injected().at(-1)?.images).toBeUndefined();
    await h.driver.pause();
  });
});

describe("轮数与上限", () => {
  test("轮数累计；到上限先置 blocked 再注入收尾消息（只有注入，没有额外卡片）", async () => {
    const h = harness({ maxRounds: 2 });
    h.driver.create("g");
    await h.tick();
    expect(h.state.goal?.rounds).toBe(1);
    round(h);
    await h.tick();
    expect(h.state.goal?.rounds).toBe(2);
    round(h);
    await h.tick();

    const g = h.state.goal;
    expect(g).toMatchObject({ state: "blocked", rounds: 2 });
    expect(g?.reason).toEqual({ code: "round-limit" });
    const last = h.injected().at(-1);
    expect(last?.text).toContain("reached its round limit (2 rounds)");
    expect(last?.text).toContain("Do not call any more tools.");
    expect(last?.notice).toMatchObject({
      event: "blocked",
      reason: { code: "round-limit" },
    });
    // 每一种变更恰好一条卡片：set + blocked 那一条就是注入本身
    expect(
      h.notes().map((n) => (n as { notice: GoalNotice }).notice.event),
    ).toEqual(["set"]);
  });

  test("无工具调用的目标轮连续 3 轮 → blocked（no-tool-calls）", async () => {
    const h = harness();
    h.driver.create("g");
    await h.tick();
    for (let i = 0; i < 3; i++) {
      round(h);
      await h.tick();
    }
    expect(h.state.goal).toMatchObject({
      state: "blocked",
      rounds: 3,
      reason: { code: "no-tool-calls" },
    });
    const last = h.injected().at(-1);
    expect(last?.text).toContain("The last 3 goal rounds made no tool calls");
    expect(last?.notice).toMatchObject({
      event: "blocked",
      reason: { code: "no-tool-calls" },
    });
  });

  test("有工具调用的一轮把连续无工具计数清零", async () => {
    const h = harness();
    h.driver.create("g");
    await h.tick();
    round(h);
    await h.tick();
    round(h);
    await h.tick();
    // 第三轮里调了工具：不清零的话这一轮就会被判受阻
    round(h, { tools: 1 });
    await h.tick();
    expect(h.state.goal?.state).toBe("active");
    expect(h.state.goal?.rounds).toBe(4);
  });
});

describe("暂停 / 停止 / 出错 / 重启", () => {
  test("本轮出错：目标 paused（request-failed），不续跑", async () => {
    const h = harness();
    h.driver.create("g");
    await h.tick();
    const n = h.injected().length;
    round(h, { error: "provider 429" });
    await h.tick();
    expect(h.state.goal).toMatchObject({
      state: "paused",
      reason: { code: "request-failed", detail: "provider 429" },
    });
    expect(h.injected()).toHaveLength(n);
    expect(h.notes().at(-1)).toMatchObject({
      notice: { event: "paused", reason: { code: "request-failed" } },
    });
  });

  test("用户停止：active → paused（user-stopped）；已 paused 的不重复", async () => {
    const h = harness();
    h.driver.create("g");
    await h.tick();
    h.driver.userStopped();
    expect(h.state.goal).toMatchObject({
      state: "paused",
      reason: { code: "user-stopped" },
    });
    const n = h.notes().length;
    h.driver.userStopped();
    expect(h.notes()).toHaveLength(n);
  });

  test("用户暂停：正在跑就一并中断本轮；继续把轮数归零", async () => {
    const h = harness();
    h.driver.create("g");
    await h.tick();
    h.host.flags.busy = true;
    await h.driver.pause();
    expect(h.calls.at(-1)).toEqual({ kind: "stop" });
    expect(h.state.goal?.reason).toEqual({ code: "user-paused" });

    h.host.flags.busy = false;
    h.driver.resume();
    await h.tick();
    expect(h.state.goal?.rounds).toBe(1);
    expect(h.state.goal?.reason).toBeUndefined();
  });

  test("重启恢复：载入时 active → paused（server-restart）并出一张卡片", () => {
    const h = harness();
    h.driver.create("g");
    h.driver.restore();
    expect(h.state.goal).toMatchObject({
      state: "paused",
      reason: { code: "server-restart" },
    });
    expect(h.notes().at(-1)).toMatchObject({
      notice: { event: "paused", reason: { code: "server-restart" } },
    });
  });
});

describe("模型宣布完成 / 受阻", () => {
  test("非目标轮里 complete 被拒；目标轮里通过并出卡片", async () => {
    const h = harness();
    h.driver.create("g");
    const g = h.state.goal;
    // 用户亲手发起的运行：runStarted 之后 goalRun 仍是 false
    h.driver.runStarted();
    expect(
      h.driver.modelUpdate({
        goalId: g?.id as string,
        revision: g?.revision as number,
        action: "complete",
      }),
    ).toMatchObject({ isError: true });
    expect(h.state.goal?.state).toBe("active");

    // 目标轮：注入之后
    await h.tick();
    h.driver.runStarted();
    const now = h.state.goal;
    const ok = h.driver.modelUpdate({
      goalId: now?.id as string,
      revision: now?.revision as number,
      action: "complete",
    });
    expect(ok.isError).toBeUndefined();
    expect(ok.text).toContain("Do not call any more tools.");
    expect(h.state.goal?.state).toBe("complete");
    expect(h.notes().at(-1)).toMatchObject({
      notice: { event: "complete" },
    });
  });

  test("blocked 需要至少 3 轮且写明原因", async () => {
    const h = harness();
    h.driver.create("g");
    await h.tick();
    h.driver.runStarted();
    const g = h.state.goal;
    expect(
      h.driver.modelUpdate({
        goalId: g?.id as string,
        revision: g?.revision as number,
        action: "blocked",
        blockedReason: "缺凭据",
      }),
    ).toMatchObject({ isError: true });
    expect(h.state.goal?.state).toBe("active");
  });

  test("revision / goal_id 对不上、改用户设的目标都被拒", async () => {
    const h = harness();
    h.driver.create("g");
    await h.tick();
    h.driver.runStarted();
    const g = h.state.goal;
    expect(
      h.driver.modelUpdate({
        goalId: g?.id as string,
        revision: (g?.revision as number) + 5,
        action: "edit",
        objective: "x",
      }),
    ).toMatchObject({ isError: true });
    expect(
      h.driver.modelUpdate({
        goalId: g?.id as string,
        revision: g?.revision as number,
        action: "edit",
        objective: "x",
      }),
    ).toMatchObject({ isError: true });
    expect(h.state.goal?.text).toBe("g");
  });

  test("模型自设的目标可以 edit，by 保持 model", async () => {
    const h = harness();
    const created = h.driver.modelCreate("先做 X");
    expect(created.isError).toBeUndefined();
    expect(h.notes().at(-1)).toMatchObject({
      notice: { event: "set", by: "model" },
    });
    const g = h.state.goal;
    const edited = h.driver.modelUpdate({
      goalId: g?.id as string,
      revision: g?.revision as number,
      action: "edit",
      objective: "改做 Y",
    });
    expect(edited.isError).toBeUndefined();
    expect(h.state.goal).toMatchObject({ text: "改做 Y", by: "model" });
    expect(h.notes().at(-1)).toMatchObject({
      notice: { event: "edited", by: "model", text: "改做 Y" },
    });
  });

  test("已有未完成目标时不能再 create", () => {
    const h = harness();
    h.driver.create("g");
    expect(h.driver.modelCreate("另一个")).toMatchObject({ isError: true });
  });

  // 模型看到的文字一律英文：状态与文本校验的中文报错只给用户
  test("模型被拒时看到的是英文说明，不是中文报错", async () => {
    const h = harness();
    expect(h.driver.modelCreate("  ").text).toMatch(/^The objective must be/);
    h.driver.modelCreate("先做 X");
    const g = h.state.goal;
    // 创建它的这一轮里目标被用户暂停：再宣布完成，状态不允许
    await h.driver.pause();
    const done = h.driver.modelUpdate({
      goalId: g?.id as string,
      revision: h.state.goal?.revision as number,
      action: "complete",
    });
    expect(done.isError).toBe(true);
    expect(done.text).toMatch(/^The goal is paused/);
  });
});

describe("卡片不重不漏", () => {
  test("每种变更恰好一张：set / edited / paused / resumed / cleared", async () => {
    const h = harness();
    h.driver.create("g");
    h.driver.edit({ text: "g2" });
    h.driver.edit({ maxRounds: null });
    await h.driver.pause();
    h.driver.resume();
    h.driver.clear();
    expect(h.notes().map((n) => (n as { notice: GoalNotice }).notice)).toEqual([
      {
        event: "set",
        goalId: expect.any(String),
        revision: 1,
        by: "user",
        text: "g",
      },
      {
        event: "edited",
        goalId: expect.any(String),
        revision: 2,
        by: "user",
        text: "g2",
      },
      {
        event: "edited",
        goalId: expect.any(String),
        revision: 3,
        by: "user",
        maxRounds: null,
      },
      {
        event: "paused",
        goalId: expect.any(String),
        revision: 4,
        reason: { code: "user-paused" },
      },
      { event: "resumed", goalId: expect.any(String), revision: 5 },
      { event: "cleared", goalId: expect.any(String), revision: 5 },
    ]);
  });
});
