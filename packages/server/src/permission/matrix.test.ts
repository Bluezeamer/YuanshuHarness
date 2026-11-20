import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { PromptSpec } from "../session/prompts.js";
import type { Access } from "./decide.js";
import { permissionExtension } from "./extension.js";
import { dirAt, locateAt } from "./testkit.js";
import type { Tier } from "./tier.js";
import type { Policy, ToolPolicy } from "./tool-matrix.js";

const root = mkdtempSync(path.join(tmpdir(), "yuanshu-matrix-"));
const cwd = path.join(root, "ws");
const out = path.join(root, "elsewhere");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const inFile = path.join(cwd, "a.txt");
const outFile = path.join(out, "b.txt");

function harness(
  o: {
    tier?: Tier;
    policy?: Record<string, ToolPolicy>;
    mcp?: Record<string, Policy>;
    pathRules?: { access: Access; value: string }[];
    unattended?: boolean;
  } = {},
) {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const asked: PromptSpec[] = [];
  const reviewed: string[] = [];
  permissionExtension({
    directoryCtx: dirAt(cwd, {
      tier: o.tier ?? "rules",
      rules: { path: o.pathRules ?? [], command: [] },
    }),
    tier: () => o.tier ?? "rules",
    locate: locateAt(cwd, {
      tier: o.tier ?? "rules",
      rules: { path: o.pathRules ?? [], command: [] },
    }),
    ask: async (spec) => {
      asked.push(spec);
      return { outcome: "answered", optionId: "deny" } as never;
    },
    review: async (c) => {
      reviewed.push(c.tool);
      return { decision: "allow" };
    },
    toolPolicy: (t) => o.policy?.[t] ?? null,
    mcpApproval: (t) => o.mcp?.[t] ?? null,
    ...(o.unattended ? { unattended: true } : {}),
  })({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as never);
  return {
    asked,
    reviewed,
    run: (tool: string, input: Record<string, unknown>) =>
      handler?.({ toolName: tool, input, toolCallId: "c1" }) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
  };
}

const P = (inside: Policy, outside: Policy): ToolPolicy => ({
  inside,
  outside,
});

describe("缺省矩阵与现状一致", () => {
  test("文件类内放行、外审批；命令类内外审批（只读白名单仍直放）", async () => {
    const h = harness();
    expect(await h.run("read", { path: inFile })).toBeUndefined();
    expect(
      await h.run("write", { path: inFile, content: "x" }),
    ).toBeUndefined();
    expect(h.asked).toHaveLength(0);
    await h.run("read", { path: outFile });
    expect(h.asked).toHaveLength(1);
    expect(await h.run("bash", { command: "ls" })).toBeUndefined();
    await h.run("bash", { command: "touch a.txt" });
    expect(h.asked).toHaveLength(2);
  });
});

describe("完全允许档与无法解析的路径", () => {
  test("完全允许档不看矩阵：直接放行", async () => {
    const h = harness({ tier: "full", policy: { read: P("ask", "ask") } });
    expect(await h.run("read", { path: outFile })).toBeUndefined();
    expect(await h.run("bash", { command: "rm -rf x" })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });

  test("无法解析的路径按 cwd 外处理：只交人工", async () => {
    const ask = harness();
    await ask.run("read", { path: "file:///etc/hosts" });
    expect(ask.asked).toHaveLength(1);
  });
});

describe("矩阵「审批」「放行」的落点", () => {
  test("cwd 内改成审批：里面也弹，弹窗可记住；记住的规则覆盖后不再弹", async () => {
    const h = harness({ policy: { read: P("ask", "ask") } });
    await h.run("read", { path: inFile });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.options?.map((o) => o.id)).toEqual([
      "allow",
      "deny",
      "remember",
    ]);
    const covered = harness({
      policy: { read: P("ask", "ask") },
      pathRules: [{ access: "read", value: cwd }],
    });
    expect(await covered.run("read", { path: inFile })).toBeUndefined();
    expect(covered.asked).toHaveLength(0);
  });

  test("完全允许档下审批档不起作用（只有禁止越过档位）", async () => {
    const h = harness({ tier: "full", policy: { read: P("ask", "ask") } });
    expect(await h.run("read", { path: inFile })).toBeUndefined();
  });

  test("cwd 外改成放行：不再弹；敏感路径仍必须人工且不可记住", async () => {
    const h = harness({ policy: { read: P("allow", "allow") } });
    expect(await h.run("read", { path: outFile })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
    await h.run("read", { path: path.join(cwd, ".env") });
    await h.run("read", { path: path.join(out, ".ssh", "id_rsa") });
    expect(h.asked).toHaveLength(2);
    for (const a of h.asked)
      expect(a.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
  });

  test("敏感路径放行也要审批，auto 档不交审核模型", async () => {
    const h = harness({
      tier: "auto",
      policy: { read: P("allow", "allow") },
    });
    await h.run("read", { path: path.join(cwd, ".env") });
    expect(h.asked).toHaveLength(1);
    expect(h.reviewed).toEqual([]);
  });

  test("bash 内放行：普通命令直放；解释器前缀、sudo、不透明包装、敏感词仍要审批且不可记住", async () => {
    const h = harness({ policy: { bash: P("allow", "ask") } });
    expect(await h.run("bash", { command: "touch a.txt" })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
    for (const command of [
      "env A=1 touch b.txt",
      "sudo ls",
      "bash run.sh",
      "cat .env",
    ])
      await h.run("bash", { command });
    expect(h.asked).toHaveLength(4);
    for (const a of h.asked)
      expect(a.options?.map((o) => o.id)).not.toContain("remember");
  });

  test("bash 内放行不覆盖 cwd 外的路径操作数", async () => {
    const h = harness({ policy: { bash: P("allow", "ask") } });
    await h.run("bash", { command: `touch ${outFile}` });
    expect(h.asked).toHaveLength(1);
  });
});

describe("MCP 审批（按服务一档，不分 cwd 内外）", () => {
  const tool = "mcp__srv__do";
  test("默认（ask / 未登记）：弹窗，且不可记住、不交审核模型", async () => {
    const h = harness({ tier: "auto" });
    await h.run(tool, { a: 1 });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
    expect(h.reviewed).toEqual([]);
    const ask = harness({ mcp: { [tool]: "ask" } });
    await ask.run(tool, {});
    expect(ask.asked).toHaveLength(1);
  });

  test("放行：不弹窗", async () => {
    const allow = harness({ mcp: { [tool]: "allow" } });
    expect(await allow.run(tool, {})).toBeUndefined();
    expect(allow.asked).toHaveLength(0);
  });

  test("只作用于该服务的工具；其他未知工具照旧", async () => {
    const h = harness({ mcp: { [tool]: "allow" } });
    await h.run("mcp__other__do", {});
    expect(h.asked).toHaveLength(1);
  });

  test("完全允许档下默认 / 审批的 MCP 工具仍直接放行（与现状一致）", async () => {
    const h = harness({ tier: "full", mcp: { [tool]: "ask" } });
    expect(await h.run(tool, {})).toBeUndefined();
  });
});
