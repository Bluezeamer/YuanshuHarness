import { describe, expect, test } from "vitest";
import type { PromptResult, PromptSpec } from "../session/prompts.js";
import type { NamedRun } from "../workflow/named.js";
import { permissionExtension } from "./extension.js";
import { dirAt, locateAt } from "./testkit.js";
import type { Tier } from "./tier.js";
import type { Policy, ToolPolicy } from "./tool-matrix.js";

// 单开关工具（flat）：一个「放行 / 审批」，不分 cwd；fixed 的框架工具始终自身放行。
// 直接驱动权限扩展的 tool_call 处理器。

interface Opts {
  tier?: Tier;
  policy?: Record<string, ToolPolicy>;
  unattended?: boolean;
  answer?: PromptResult;
  named?: (name: string, args: unknown) => NamedRun;
  /** 单目录的 cwd，缺省 "/" */
  cwd?: string;
}

const P = (p: Policy): ToolPolicy => ({ inside: p, outside: p });

function harness(o: Opts = {}) {
  const asked: PromptSpec[] = [];
  const audits: Array<{ detail: Record<string, unknown> }> = [];
  const resolved: Array<{ name: string; args: unknown }> = [];
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  permissionExtension({
    directoryCtx: dirAt(o.cwd ?? "/"),
    locate: locateAt(o.cwd ?? "/"),
    tier: () => o.tier ?? "rules",
    ...(o.unattended ? { unattended: true } : {}),
    ...(o.policy ? { toolPolicy: (t: string) => o.policy?.[t] ?? null } : {}),
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
    ask: async (spec) => {
      asked.push(spec);
      return o.answer ?? { outcome: "answered", optionId: "allow" };
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
    resolved,
    call: (toolName: string, input: Record<string, unknown> = {}) =>
      handler?.({ toolName, toolCallId: "t1", input }) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
  };
}

describe("单开关工具：放行不弹窗，审批弹窗", () => {
  test.each([
    "spawn_subagent",
    "list_directories",
    "browser_snapshot",
    "team_status",
  ])("%s：allow 不弹窗，ask 弹窗", async (name) => {
    const allow = harness({ policy: { [name]: P("allow") } });
    expect(await allow.call(name, {})).toBeUndefined();
    expect(allow.asked).toHaveLength(0);

    const ask = harness({ policy: { [name]: P("ask") } });
    // 答「仅此次通过」：弹了窗、随后放行
    expect(await ask.call(name, {})).toBeUndefined();
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]?.detail).toMatchObject({ tool: name });

    const refused = harness({
      policy: { [name]: P("ask") },
      answer: { outcome: "answered", optionId: "deny" },
    });
    expect(await refused.call(name, {})).toMatchObject({ block: true });
  });

  test("审批弹窗只给「仅此次 / 拒绝」：单开关工具没有可记住的路径规则", async () => {
    const h = harness({ policy: { spawn_subagent: P("ask") } });
    await h.call("spawn_subagent", { task: "T" });
    expect(h.asked[0]?.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
  });
});

describe("出厂值：deps.toolPolicy 缺省时按矩阵出厂", () => {
  test("list_directories / spawn_subagent 放行；switch_directory / workflow_run 弹窗", async () => {
    const allow = harness();
    expect(await allow.call("list_directories", {})).toBeUndefined();
    expect(await allow.call("spawn_subagent", { task: "T" })).toBeUndefined();
    expect(await allow.call("browser_snapshot", {})).toBeUndefined();
    expect(allow.asked).toHaveLength(0);

    for (const name of ["switch_directory", "workflow_run"]) {
      const h = harness();
      await h.call(name, name === "workflow_run" ? { script: "x" } : {});
      expect(h.asked).toHaveLength(1);
    }
  });
});

describe("无人值守（子会话）", () => {
  test("ask 的单开关工具被拒，记 unattended 审计", async () => {
    // switch_directory 由 DIRECTORY_TOOLS 单独放行，见下一条
    const h = harness({
      unattended: true,
      policy: { workflow_run: P("ask") },
    });
    const r = await h.call("workflow_run", { script: "x" });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("没有人工审批通道");
    expect(h.asked).toHaveLength(0);
    expect(h.audits.at(-1)?.detail).toMatchObject({
      tool: "workflow_run",
      decision: "deny",
      by: "unattended",
    });
  });

  test("switch_directory / list_directories 无人值守仍放行（可切换范围由池限定）", async () => {
    const h = harness({
      unattended: true,
      policy: { switch_directory: P("ask"), list_directories: P("ask") },
    });
    expect(
      await h.call("switch_directory", { directory: "x" }),
    ).toBeUndefined();
    expect(await h.call("list_directories", {})).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });
});

describe("完全允许档", () => {
  test("ask 的单开关工具也放行", async () => {
    const h = harness({
      tier: "full",
      policy: { spawn_subagent: P("ask"), workflow_run: P("ask") },
    });
    expect(await h.call("spawn_subagent", { task: "T" })).toBeUndefined();
    expect(await h.call("workflow_run", { script: "x" })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });
});

describe("switch_mode", () => {
  test("默认弹窗；allow 放行；list 始终不弹", async () => {
    const h = harness();
    expect(await h.call("switch_mode", { mode: "Plan" })).toBeUndefined();
    expect(h.asked).toHaveLength(1);

    const allowed = harness({ policy: { switch_mode: P("allow") } });
    expect(await allowed.call("switch_mode", { mode: "Plan" })).toBeUndefined();
    expect(allowed.asked).toHaveLength(0);

    const list = harness();
    for (const m of ["list", " LIST ", "", undefined])
      expect(await list.call("switch_mode", { mode: m })).toBeUndefined();
    expect(list.asked).toHaveLength(0);
  });
});

describe("workflow_run", () => {
  const SCRIPT = "return await agent('x');\n";
  const NAMED_SCRIPT = "return await agent('named');\n";

  test("allow 放行，且命名流程仍被解析并改写 input", async () => {
    const h = harness({
      policy: { workflow_run: P("allow") },
      named: () => ({
        ok: true,
        script: NAMED_SCRIPT,
        args: { scope: "week" },
        layer: "project",
      }),
    });
    const input: Record<string, unknown> = { name: "review" };
    expect(await h.call("workflow_run", input)).toBeUndefined();
    expect(h.resolved).toEqual([{ name: "review", args: undefined }]);
    expect(input).toEqual({
      script: NAMED_SCRIPT,
      args: { scope: "week" },
      label: "review",
    });
    expect(h.asked).toHaveLength(0);
  });

  test("ask 弹窗", async () => {
    const h = harness({ policy: { workflow_run: P("ask") } });
    const input: Record<string, unknown> = { script: SCRIPT };
    expect(await h.call("workflow_run", input)).toBeUndefined();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.detail).toMatchObject({
      tool: "workflow_run",
      summary: SCRIPT,
    });
  });

  test("allow 时无人值守也放行（与完全允许档一致）", async () => {
    const h = harness({
      unattended: true,
      policy: { workflow_run: P("allow") },
    });
    expect(await h.call("workflow_run", { script: SCRIPT })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });
});

describe("browser_open", () => {
  // 要不要问取决于目标（公网 / 本工作区文件 / 自起的服务），工具解析完才知道，所以由工具自己审批。
  test.each(["allow", "ask"] as const)(
    "规则是 %s 时权限层都不拦、不弹窗",
    async (policy) => {
      const h = harness({ policy: { browser_open: P(policy) } });
      expect(
        await h.call("browser_open", { target: "https://example.test/a" }),
      ).toBeUndefined();
      expect(h.asked).toHaveLength(0);
    },
  );

  test("无人值守也不在这一层拦（子会话本来就没有浏览器工具）", async () => {
    const h = harness({
      unattended: true,
      policy: { browser_open: P("ask") },
    });
    expect(
      await h.call("browser_open", { target: "https://example.test/a" }),
    ).toBeUndefined();
  });
});

describe("fixed 的框架工具：自身放行", () => {
  test.each([
    "ask_user",
    "call_tool",
    "job_start",
    "job_list",
    "job_stop",
    "job_remind",
    "deliver",
    "post",
    "todo_write",
    "get_goal",
    "create_goal",
    "update_goal",
  ])("%s 不弹窗", async (name) => {
    const h = harness({ tier: "rules" });
    expect(await h.call(name, {})).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });

  test("transfer_files 仍走两端各自判定，不走单开关分支", async () => {
    // 单开关「放行」若生效就不会弹卡片；两端在 cwd 之外要审批，证明走的是两端判定
    const h = harness({ policy: { transfer_files: P("allow") }, cwd: "/work" });
    const r = await h.call("transfer_files", {
      from: "/elsewhere/a.txt",
      to: "/elsewhere/b.txt",
    });
    expect(r).toBeUndefined();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.detail).toMatchObject({ tool: "transfer_files" });
  });
});
