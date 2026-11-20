import { describe, expect, test } from "vitest";
import {
  DETAIL_STRING_MAX,
  type PromptResult,
  type PromptSpec,
} from "../session/prompts.js";
import type { NamedRun } from "../workflow/named.js";
import { permissionExtension } from "./extension.js";
import { dirAt, locateAt } from "./testkit.js";
import type { Tier } from "./tier.js";

// workflow_run：一次运行可能启动很多模型会话，除通过档外每次都要人批；自动审核档不送审。
function harness(
  tier: Tier,
  answer: PromptResult,
  o: {
    unattended?: boolean;
    // 命名流程的解析：name 是调用方传的名字
    named?: (name: string, args: unknown) => NamedRun;
  } = {},
) {
  const asked: PromptSpec[] = [];
  const audits: Array<{ detail: Record<string, unknown> }> = [];
  const reviewed: string[] = [];
  const resolved: Array<{ name: string; args: unknown }> = [];
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  permissionExtension({
    directoryCtx: dirAt("/"),
    locate: locateAt("/"),
    tier: () => tier,
    ...(o.unattended ? { unattended: true } : {}),
    ...(o.named
      ? {
          namedWorkflows: {
            resolveRun: async (
              name: string,
              args: unknown,
            ): Promise<NamedRun> => {
              resolved.push({ name, args });
              return (o.named as (n: string, a: unknown) => NamedRun)(
                name,
                args,
              );
            },
          },
        }
      : {}),
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
    resolved,
    call: (input: Record<string, unknown>) =>
      handler?.({
        toolName: "workflow_run",
        toolCallId: "t1",
        input,
      }) as Promise<{ block?: boolean; reason?: string } | undefined>,
  };
}
const allow: PromptResult = { outcome: "answered", optionId: "allow" };
const SCRIPT = 'return await agent("x");';
const NAMED_SCRIPT = 'return await agent("named");\n';

describe("workflow_run 要人批", () => {
  test("运行前弹审批；批准放行并记审计，拒绝 / 超时 / 取消都拦下", async () => {
    const ok = harness("rules", allow);
    expect(await ok.call({ script: SCRIPT })).toBeUndefined();
    expect(ok.asked[0]).toMatchObject({
      source: "approval",
      input: "text",
      title: "允许运行工作流？",
      detail: { tool: "workflow_run", summary: SCRIPT },
    });
    expect(ok.asked[0]?.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
    expect(ok.asked[0]?.body).toContain(
      "每个 agent() 是一个完整的模型会话，数量由脚本决定",
    );
    expect(ok.audits.at(-1)?.detail).toMatchObject({
      tool: "workflow_run",
      decision: "allow",
      by: "user",
    });
    for (const answer of [
      { outcome: "answered", optionId: "deny" },
      { outcome: "timeout" },
      { outcome: "cancelled" },
    ] as PromptResult[]) {
      const h = harness("rules", answer);
      const r = await h.call({ script: SCRIPT });
      expect(r).toMatchObject({ block: true });
      expect(h.audits.at(-1)?.detail).toMatchObject({
        tool: "workflow_run",
        decision: "deny",
        by: answer.outcome === "answered" ? "user" : answer.outcome,
      });
    }
  });

  test("拒绝后告诉模型不要原样重试，先向用户确认", async () => {
    const h = harness("rules", { outcome: "answered", optionId: "deny" });
    const r = await h.call({ script: SCRIPT });
    expect(r?.reason).toContain("用户拒绝了这次运行");
    expect(r?.reason).toContain("不要原样重试");
    // 没写文字时不追加
    expect(r?.reason).not.toContain("用户补充");
  });

  test("拒绝时把用户写的话带给模型（选 deny + 文字，或只写文字）", async () => {
    for (const answer of [
      { outcome: "answered", optionId: "deny", text: "只跑前两个" },
      { outcome: "answered", text: "只跑前两个" },
    ] as PromptResult[]) {
      const h = harness("rules", answer);
      const r = await h.call({ script: SCRIPT });
      expect(r?.block).toBe(true);
      expect(r?.reason).toContain("用户拒绝了这次运行");
      expect(r?.reason).toContain("用户补充：只跑前两个");
      // 审计不记理由
      expect(JSON.stringify(h.audits.at(-1))).not.toContain("只跑前两个");
    }
  });

  test("正文列出标签、并发数与 args；args 过长就截断并注明", async () => {
    const h = harness("rules", allow);
    await h.call({
      script: SCRIPT,
      label: "review-all",
      concurrency: 4,
      args: { files: ["a.txt"] },
    });
    const body = h.asked[0]?.body ?? "";
    expect(body).toContain("标签：review-all");
    expect(body).toContain("并发数：4");
    expect(body).toContain('args：{"files":["a.txt"]}');

    const long = harness("rules", allow);
    const big = { text: "x".repeat(400) };
    await long.call({ script: SCRIPT, args: big });
    const shown = long.asked[0]?.body ?? "";
    expect(shown).toContain("已截断");
    // 完整内容仍在 summary 里：脚本之后空一行接 args 的 JSON
    expect(long.asked[0]?.detail?.summary).toBe(
      `${SCRIPT}\n\n--- args ---\n${JSON.stringify(big)}`,
    );
  });

  test("脚本加 args 超过展示上限：直接拒绝，不进审批", async () => {
    const h = harness("rules", allow);
    const r = await h.call({ script: "x".repeat(DETAIL_STRING_MAX + 1) });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("脚本过长无法完整展示审批");
    expect(r?.reason).toContain("在 args 里传路径");
    expect(h.asked).toHaveLength(0);
    expect(h.audits.at(-1)?.detail).toMatchObject({
      tool: "workflow_run",
      decision: "deny",
      by: "error",
    });
    // args 把总长度顶过上限时同样算看不全
    const args = harness("rules", allow);
    expect(
      await args.call({
        script: "y".repeat(DETAIL_STRING_MAX - 10),
        args: "z".repeat(50),
      }),
    ).toMatchObject({ block: true });
    expect(args.asked).toHaveLength(0);
  });

  test("自动审核档：不送审，交人工；通过档：不弹", async () => {
    const auto = harness("auto", allow);
    expect(await auto.call({ script: SCRIPT })).toBeUndefined();
    expect(auto.asked).toHaveLength(1);
    expect(auto.reviewed).toHaveLength(0);
    const full = harness("full", allow);
    expect(await full.call({ script: SCRIPT })).toBeUndefined();
    expect(full.asked).toHaveLength(0);
  });

  test("无人值守：没有审批通道，直接拒绝并记审计", async () => {
    const h = harness("rules", allow, { unattended: true });
    const r = await h.call({ script: SCRIPT });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("没有人工审批通道");
    expect(h.asked).toHaveLength(0);
    expect(h.audits.at(-1)?.detail).toMatchObject({
      tool: "workflow_run",
      decision: "deny",
      by: "unattended",
    });
  });

  test("命名流程：弹窗前解析成脚本与填好默认值的 args，弹窗显示的就是会运行的文本", async () => {
    const h = harness("rules", allow, {
      named: (name, args) =>
        name === "review"
          ? {
              ok: true,
              script: NAMED_SCRIPT,
              args: { scope: "week", ...(args as object) },
              layer: "project",
            }
          : { ok: false, error: `There is no named workflow "${name}".` },
    });
    const input: Record<string, unknown> = {
      name: "review",
      args: { limit: 2 },
    };
    expect(await h.call(input)).toBeUndefined();
    expect(h.resolved).toEqual([{ name: "review", args: { limit: 2 } }]);
    // 弹窗正文点名了命名流程与层，summary 是脚本（与运行时同一份）
    expect(h.asked[0]?.body).toContain("命名流程：review（project）");
    expect(h.asked[0]?.detail?.summary).toBe(
      `${NAMED_SCRIPT}\n\n--- args ---\n{"scope":"week","limit":2}`,
    );
    // 原地改写：execute 拿到的 input 就是弹窗那一份（name 已换成 script；标签缺省取名称）
    expect(input).toEqual({
      script: NAMED_SCRIPT,
      args: { scope: "week", limit: 2 },
      label: "review",
    });
  });

  test("命名流程解析失败：不弹窗，直接拦下并给出同一条原因；通过档也能跑", async () => {
    const h = harness("rules", allow, {
      named: () => ({ ok: false, error: "broken.js: invalid JSON" }),
    });
    const r = await h.call({ name: "broken" });
    expect(r).toMatchObject({ block: true, reason: "broken.js: invalid JSON" });
    expect(h.asked).toHaveLength(0);

    const full = harness("full", allow, {
      named: () => ({
        ok: true,
        script: NAMED_SCRIPT,
        args: {},
        layer: "global",
      }),
    });
    const input: Record<string, unknown> = { name: "review" };
    expect(await full.call(input)).toBeUndefined();
    expect(input).toEqual({ script: NAMED_SCRIPT, args: {}, label: "review" });
  });

  test("name 与 script 二选一：都给或都不给都拦下", async () => {
    const both = harness("rules", allow, {
      named: () => ({
        ok: true,
        script: NAMED_SCRIPT,
        args: {},
        layer: "global",
      }),
    });
    const r1 = await both.call({ name: "review", script: SCRIPT });
    expect(r1).toMatchObject({ block: true });
    expect(r1?.reason).toContain("either name or script");
    expect(both.resolved).toHaveLength(0);

    const neither = harness("rules", allow);
    const r2 = await neither.call({});
    expect(r2).toMatchObject({ block: true });
    expect(r2?.reason).toContain("workflow_list");
  });

  test("命名流程在批准与运行之间被改掉：运行的是批准时的文本", async () => {
    let text = NAMED_SCRIPT;
    const h = harness(
      "rules",
      { outcome: "answered", optionId: "allow" },
      {
        named: () => ({ ok: true, script: text, args: {}, layer: "project" }),
      },
    );
    // 弹窗期间改写文件：解析结果已经写进 input，换掉源文本不应影响这次运行
    const answer = h.call({ name: "review" });
    text = "return 'changed';\n";
    await answer;
    expect(h.asked[0]?.detail?.summary).toBe(
      `${NAMED_SCRIPT}\n\n--- args ---\n{}`,
    );
  });
});
