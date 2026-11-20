import { describe, expect, test } from "vitest";
import {
  advance,
  block,
  complete,
  createGoal,
  editGoal,
  GoalError,
  pause,
  resume,
} from "./goal.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:01:00.000Z";

const base = () => createGoal("目标", "user", 50, "g1", NOW);

describe("createGoal", () => {
  test("新目标从 active、轮数 0、revision 1 起", () => {
    expect(base()).toEqual({
      id: "g1",
      revision: 1,
      text: "目标",
      by: "user",
      state: "active",
      maxRounds: 50,
      rounds: 0,
      since: NOW,
      updatedAt: NOW,
    });
  });

  test("新建可以带附件；没给附件时没有这个字段", () => {
    const files = [
      { name: "a.png", mime: "image/png", sizeText: "1 B", path: "./d/a.png" },
    ];
    expect(createGoal("目标", "user", 50, "g1", NOW, files)).toMatchObject({
      attachments: files,
    });
    expect(createGoal("目标", "user", 50, "g1", NOW, [])).not.toHaveProperty(
      "attachments",
    );
  });

  test("文本去空白；空文本与超长报 bad_request", () => {
    expect(createGoal("  x  ", "model", null, "g2", NOW).text).toBe("x");
    expect(() => createGoal("   ", "user", 50, "g3", NOW)).toThrow(GoalError);
    expect(() => createGoal("x".repeat(4001), "user", 50, "g3", NOW)).toThrow(
      GoalError,
    );
  });
});

describe("editGoal", () => {
  test("用户改文本：by 归 user，revision +1，状态不变", () => {
    const g = createGoal("旧", "model", 50, "g1", NOW);
    const next = editGoal(g, { text: "新" }, "user", LATER);
    expect(next).toMatchObject({
      text: "新",
      by: "user",
      revision: 2,
      state: "active",
      updatedAt: LATER,
    });
  });

  test("用户能改上限；模型不能", () => {
    const g = base();
    expect(
      editGoal(g, { maxRounds: null }, "user", LATER).maxRounds,
    ).toBeNull();
    expect(() => editGoal(g, { maxRounds: 5 }, "model", LATER)).toThrow(
      GoalError,
    );
  });

  test("用户改附件：整体替换，空数组 = 清空；模型不能改", () => {
    const files = [
      { name: "a.png", mime: "image/png", sizeText: "1 B", path: "./d/a.png" },
      { name: "b.png", mime: "image/png", sizeText: "2 B", path: "./d/b.png" },
    ];
    const g = createGoal("目标", "user", 50, "g1", NOW, files);
    const one = editGoal(
      g,
      { attachments: [files[0] as never] },
      "user",
      LATER,
    );
    expect(one.attachments).toEqual([files[0]]);
    expect(one.revision).toBe(2);
    const none = editGoal(one, { attachments: [] }, "user", LATER);
    expect(none).not.toHaveProperty("attachments");
    // 不给 attachments 就不动已有的
    expect(editGoal(g, { text: "换文本" }, "user", LATER).attachments).toEqual(
      files,
    );
    for (const by of ["model"] as const) {
      expect(() => editGoal(g, { attachments: [] }, by, LATER)).toThrow(
        GoalError,
      );
      try {
        editGoal(g, { attachments: [] }, by, LATER);
      } catch (e) {
        expect((e as GoalError).code).toBe("conflict");
      }
    }
  });

  test("模型改自己的目标：by 仍是 model", () => {
    const g = createGoal("旧", "model", 50, "g1", NOW);
    expect(editGoal(g, { text: "新" }, "model", LATER)).toMatchObject({
      text: "新",
      by: "model",
    });
  });

  test("至少给一项；complete 的目标不能改", () => {
    const g = base();
    expect(() => editGoal(g, {}, "user", LATER)).toThrow(GoalError);
    try {
      editGoal(g, {}, "user", LATER);
    } catch (e) {
      expect((e as GoalError).code).toBe("bad_request");
    }
    const done = complete(g, LATER);
    expect(() => editGoal(done, { text: "x" }, "user", LATER)).toThrow(
      GoalError,
    );
  });
});

describe("状态转移", () => {
  test("pause 只对 active 生效，其余返回 null", () => {
    const g = base();
    const p = pause(g, { code: "user-paused" }, LATER);
    expect(p).toMatchObject({
      state: "paused",
      reason: { code: "user-paused" },
      revision: 2,
    });
    expect(pause(p as never, { code: "user-stopped" }, LATER)).toBeNull();
    expect(
      pause(complete(g, LATER), { code: "user-paused" }, LATER),
    ).toBeNull();
  });

  test("resume 把 paused / blocked 拉回 active，轮数归零并清原因", () => {
    const g = advance(base(), LATER);
    const p = pause(g, { code: "user-paused" }, LATER) as never;
    const r = resume(p, LATER);
    expect(r).toMatchObject({ state: "active", rounds: 0 });
    expect(r.reason).toBeUndefined();
    const b = block(g, { code: "round-limit" }, LATER);
    expect(resume(b, LATER).rounds).toBe(0);
  });

  test("resume 对 active / complete 报错", () => {
    expect(() => resume(base(), LATER)).toThrow(GoalError);
    expect(() => resume(complete(base(), LATER), LATER)).toThrow(GoalError);
  });

  test("block / complete 只从 active 出发", () => {
    const g = base();
    expect(block(g, { code: "no-tool-calls" }, LATER)).toMatchObject({
      state: "blocked",
      reason: { code: "no-tool-calls" },
    });
    expect(complete(g, LATER)).toMatchObject({ state: "complete" });
    const p = pause(g, { code: "user-paused" }, LATER) as never;
    expect(() => complete(p, LATER)).toThrow(GoalError);
    expect(() => block(p, { code: "model-blocked" }, LATER)).toThrow(GoalError);
  });

  test("advance 只给 active 记轮，原因 detail 截到 500", () => {
    expect(advance(base(), LATER).rounds).toBe(1);
    const p = pause(base(), { code: "user-paused" }, LATER) as never;
    expect(() => advance(p, LATER)).toThrow(GoalError);
    const b = block(
      base(),
      { code: "model-blocked", detail: "x".repeat(600) },
      LATER,
    );
    expect(b.reason?.detail?.length).toBe(500);
  });
});
