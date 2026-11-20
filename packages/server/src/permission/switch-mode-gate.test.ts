import { describe, expect, test } from "vitest";
import type { PromptResult, PromptSpec } from "../session/prompts.js";
import { permissionExtension } from "./extension.js";
import { dirAt, locateAt } from "./testkit.js";
import type { Tier } from "./tier.js";

// switch_mode：真切换要人批（"list" 只是查看）；通过档不弹，自动审核档不送审。
function harness(tier: Tier, answer: PromptResult) {
  const asked: PromptSpec[] = [];
  const audits: Array<{ detail: Record<string, unknown> }> = [];
  const reviewed: string[] = [];
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  permissionExtension({
    directoryCtx: dirAt("/"),
    locate: locateAt("/"),
    tier: () => tier,
    review: async (c) => {
      reviewed.push(c.tool);
      return { decision: "allow" };
    },
    ask: async (spec) => {
      asked.push(spec);
      return answer;
    },
    audit: (rec) => audits.push(rec),
  })({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as never);
  return {
    asked,
    audits,
    reviewed,
    call: (mode: unknown) =>
      handler?.({
        toolName: "switch_mode",
        toolCallId: "t1",
        input: { mode },
      }) as Promise<{ block?: boolean; reason?: string } | undefined>,
  };
}
const allow: PromptResult = { outcome: "answered", optionId: "allow" };

describe("switch_mode 要人批", () => {
  test("切进模式：弹审批；批准放行并记审计，拒绝 / 超时 / 取消都拦下", async () => {
    const ok = harness("rules", allow);
    expect(await ok.call("Plan")).toBeUndefined();
    expect(ok.asked[0]).toMatchObject({
      source: "approval",
      input: "text",
      detail: { tool: "switch_mode", summary: "切换到模式「Plan」" },
    });
    expect(ok.asked[0]?.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
    expect(ok.audits.at(-1)?.detail).toMatchObject({
      tool: "switch_mode",
      decision: "allow",
      by: "user",
    });
    for (const answer of [
      { outcome: "answered", optionId: "deny" },
      { outcome: "timeout" },
      { outcome: "cancelled" },
    ] as PromptResult[]) {
      const h = harness("rules", answer);
      expect(await h.call("Plan")).toMatchObject({ block: true });
    }
  });

  test("拒绝时把用户写的话带给模型：选 deny + 文字，与只写文字都算拒绝", async () => {
    for (const answer of [
      { outcome: "answered", optionId: "deny", text: "先别切，看看现有工具" },
      { outcome: "answered", text: "先别切，看看现有工具" },
    ] as PromptResult[]) {
      const h = harness("rules", answer);
      const r = await h.call("Plan");
      expect(r?.block).toBe(true);
      expect(r?.reason).toContain("用户拒绝了切换模式");
      expect(r?.reason).toContain("用户补充：先别切，看看现有工具");
      // 审计不记理由
      expect(JSON.stringify(h.audits.at(-1))).not.toContain("先别切");
    }
    // 没写文字时保持原句
    const plain = harness("rules", { outcome: "answered", optionId: "deny" });
    expect((await plain.call("Plan"))?.reason).toBe("用户拒绝了切换模式");
  });

  test("退出模式也要批（退出会恢复被限制的工具）", async () => {
    const h = harness("rules", allow);
    await h.call("none");
    expect(h.asked[0]?.detail).toMatchObject({ summary: "退出当前模式" });
  });

  test("list 与空参数只是查看：不弹", async () => {
    const h = harness("rules", allow);
    for (const m of ["list", " LIST ", "", undefined])
      expect(await h.call(m)).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });

  test("自动审核档：不送审，交人工；通过档：不弹", async () => {
    const auto = harness("auto", allow);
    await auto.call("Plan");
    expect(auto.asked).toHaveLength(1);
    expect(auto.reviewed).toHaveLength(0);
    const full = harness("full", allow);
    expect(await full.call("Plan")).toBeUndefined();
    expect(full.asked).toHaveLength(0);
  });
});
