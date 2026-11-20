import { describe, expect, test } from "vitest";
import type { VariableMeta } from "../store/secrets.js";
import { BOUNDARIES } from "./boundaries.js";
import { permissionExtension } from "./extension.js";
import { dirAt, locateAt } from "./testkit.js";
import type { Tier } from "./tier.js";

// 每条硬边界一个真实样例，驱动权限扩展本身：清单与行为对不上就会失败。
const tokenVar: VariableMeta = {
  id: "v1",
  name: "TOK",
  purpose: "",
  scopeKind: "domain",
  scopeTarget: "example.com",
  // auto 档的变量，唯一挡住它的就是适用范围
  tier: "auto",
  maskable: true,
  createdAt: "t",
  group: null,
};

const SAMPLES: Record<
  string,
  { tool: string; input: Record<string, unknown> }
> = {
  "root-shell": { tool: "bash", input: { command: "sudo -s" } },
  sensitive: { tool: "read", input: { path: "/tmp/ws/.env" } },
  sudo: { tool: "bash", input: { command: "sudo apt update" } },
  // 脚本文件形式：包装里的内容看不到
  opaque: { tool: "bash", input: { command: "bash run.sh" } },
  // file:// 前缀属于“无法可靠解析”的一类
  "unresolvable-path": { tool: "read", input: { path: "file:///etc/hosts" } },
  "unknown-tool": { tool: "mcp__x__y", input: { a: 1 } },
  "variable-scope": {
    tool: "bash",
    input: { command: "curl https://other.org -H @TOK" },
  },
};

function harness(tier: Tier) {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const reviewed: string[] = [];
  const asked: string[] = [];
  permissionExtension({
    directoryCtx: dirAt("/tmp/ws", { tier }),
    tier: () => tier,
    locate: locateAt("/tmp/ws", { tier }),
    ask: async (spec) => {
      asked.push(spec.title);
      return { outcome: "answered", optionId: "deny" } as never;
    },
    variables: () => [tokenVar],
    review: async (call) => {
      reviewed.push(call.tool);
      return { decision: "allow" };
    },
  })({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as never);
  return {
    run: (s: { tool: string; input: Record<string, unknown> }) =>
      handler?.({ toolName: s.tool, input: s.input }),
    reviewed,
    asked,
  };
}

describe("硬性边界清单与权限扩展一致", () => {
  test("每条边界都有样例，样例也都在清单里", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      BOUNDARIES.map((b) => b.id).sort(),
    );
  });

  test.each(BOUNDARIES.map((b) => [b.id, b] as const))(
    "%s：auto 档不交审核模型，必弹人工",
    async (id) => {
      const h = harness("auto");
      await h.run(SAMPLES[id] as never);
      expect(h.reviewed).toEqual([]);
      expect(h.asked).toHaveLength(1);
    },
  );

  test.each(BOUNDARIES.map((b) => [b.id, b] as const))(
    "%s：完全允许档下的行为与 inFull 一致",
    async (id, b) => {
      const h = harness("full");
      await h.run(SAMPLES[id] as never);
      expect(h.asked).toHaveLength(b.inFull ? 1 : 0);
    },
  );
});
