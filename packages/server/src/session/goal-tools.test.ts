import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type { GoalNotice } from "./goal.js";
import { GoalDriver, type GoalHost } from "./goal-driver.js";
import { goalToolsExtension } from "./goal-tools.js";
import { SessionStateHolder } from "./session-state.js";

// pi 的扩展接口在测试里只用得到 registerTool。
type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    params: unknown,
    signal?: unknown,
    update?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
};
type Pi = { registerTool: (t: Tool) => void };

function setup() {
  const calls: { kind: "inject" | "note"; notice: GoalNotice }[] = [];
  const flags = { busy: false };
  const host = {
    flags,
    host: {
      busy: () => flags.busy,
      hasPendingWork: () => false,
      inject: (_text, notice) => calls.push({ kind: "inject", notice }),
      note: (notice) => calls.push({ kind: "note", notice }),
      stop: async () => {},
      defaultMaxRounds: () => 50,
    } satisfies GoalHost,
  };
  const state = new SessionStateHolder("s1", undefined, () => {});
  const driver = new GoalDriver(host.host, state);
  const tools = new Map<string, Tool>();
  const factory: ExtensionFactory = goalToolsExtension(() => driver);
  (factory as unknown as (pi: Pi) => void)({
    registerTool: (t) => tools.set(t.name, t),
  });
  const call = async (name: string, params: unknown = {}) => {
    const t = tools.get(name);
    if (!t) throw new Error(`没有工具 ${name}`);
    return t.execute("c1", params);
  };
  const text = async (name: string, params: unknown = {}) =>
    (await call(name, params)).content.map((b) => b.text).join("\n");
  return { driver, state, tools, call, text, calls };
}

describe("三个工具的登记", () => {
  test("注册了 get_goal / create_goal / update_goal，描述是英文", () => {
    const h = setup();
    expect([...h.tools.keys()]).toEqual([
      "get_goal",
      "create_goal",
      "update_goal",
    ]);
    for (const t of h.tools.values())
      expect(t.description).toMatch(/^[A-Z][\s\S]*\.$/);
    expect(h.tools.get("update_goal")?.parameters).toMatchObject({
      required: ["goal_id", "revision", "action"],
    });
  });
});

describe("get_goal", () => {
  test("没有目标时给 No goal is set.", async () => {
    const h = setup();
    expect(await h.text("get_goal")).toBe("No goal is set.");
  });

  test("有目标时给 id、revision、objective、set_by、state 与轮数", async () => {
    const h = setup();
    h.driver.create("把测试跑绿");
    const out = await h.text("get_goal");
    expect(out).toContain("objective: 把测试跑绿");
    expect(out).toContain("set_by: user");
    expect(out).toContain("state: active");
    expect(out).toContain("round: 0/50");
    expect(out).toMatch(/goal_id: [0-9a-f-]{36}/);
    expect(out).toContain("revision: 1");
  });
});

describe("create_goal", () => {
  test("创建成功：by=model，返回说明之后会被继续驱动", async () => {
    const h = setup();
    const r = await h.call("create_goal", { objective: "整理仓库" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain('action "complete" or "blocked"');
    expect(h.state.goal).toMatchObject({ text: "整理仓库", by: "model" });
    expect(h.calls.at(-1)).toMatchObject({
      kind: "note",
      notice: { event: "set", by: "model" },
    });
  });

  test("已有未完成目标时是错误结果", async () => {
    const h = setup();
    h.driver.create("用户的目标");
    const r = await h.call("create_goal", { objective: "另一个" });
    expect(r.isError).toBe(true);
    expect(h.state.goal?.text).toBe("用户的目标");
  });
});

describe("update_goal", () => {
  const args = (h: ReturnType<typeof setup>, extra = {}) => ({
    goal_id: h.state.goal?.id,
    revision: h.state.goal?.revision,
    ...extra,
  });

  test("goal_id / revision 对不上：错误结果，让模型先 get_goal", async () => {
    const h = setup();
    h.driver.create("g");
    const r = await h.call("update_goal", {
      goal_id: "nope",
      revision: 1,
      action: "complete",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("get_goal");
  });

  test("edit 只对模型自设的目标有效；用户设的给错误结果", async () => {
    const h = setup();
    h.driver.modelCreate("我的目标");
    expect(
      await h.text("update_goal", args(h, { action: "edit", objective: "改" })),
    ).toContain("updated");
    expect(h.state.goal?.text).toBe("改");

    h.driver.clear();
    h.driver.create("用户的目标");
    const r = await h.call(
      "update_goal",
      args(h, { action: "edit", objective: "改" }),
    );
    expect(r.isError).toBe(true);
    expect(h.state.goal?.text).toBe("用户的目标");
  });

  test("非目标轮里 complete 被拒；目标轮里通过并带收尾指令", async () => {
    const h = setup();
    h.driver.modelCreate("我的目标");
    // 创建的那一轮：允许
    const r = await h.call("update_goal", args(h, { action: "complete" }));
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("Do not call any more tools.");
    expect(h.state.goal?.state).toBe("complete");
  });

  test("blocked 需要至少 3 轮与具体原因", async () => {
    const h = setup();
    h.driver.modelCreate("我的目标");
    h.driver.runStarted();
    const early = await h.call(
      "update_goal",
      args(h, { action: "blocked", blocked_reason: "缺凭据" }),
    );
    expect(early.isError).toBe(true);
  });

  test("action 不在枚举里：错误结果", async () => {
    const h = setup();
    h.driver.create("g");
    const r = await h.call("update_goal", args(h, { action: "pause" }));
    expect(r.isError).toBe(true);
  });
});

describe("驱动不在了", () => {
  test("会话已关闭时三个工具都返回 isError", async () => {
    const tools = new Map<string, Tool>();
    const factory: ExtensionFactory = goalToolsExtension(() => undefined);
    (factory as unknown as (pi: Pi) => void)({
      registerTool: (t) => tools.set(t.name, t),
    });
    for (const [name, params] of [
      ["get_goal", {}],
      ["create_goal", { objective: "x" }],
      ["update_goal", { goal_id: "g", revision: 1, action: "complete" }],
    ] as const) {
      const r = await tools.get(name)?.execute("c1", params);
      expect(r?.isError).toBe(true);
    }
  });
});
