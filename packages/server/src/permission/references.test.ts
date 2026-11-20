import { describe, expect, test } from "vitest";
import type { RefResult } from "../store/references.js";
import type { VariableMeta } from "../store/secrets.js";
import { permissionExtension } from "./extension.js";
import { bracedNames, findPlaceholders, substitute } from "./placeholders.js";
import { dirAt, locateAt } from "./testkit.js";
import type { Tier } from "./tier.js";

const meta = (over: Partial<VariableMeta> = {}): VariableMeta => ({
  id: "v1",
  name: "gitlab.token",
  purpose: "GitLab 令牌",
  scopeKind: "any",
  scopeTarget: null,
  tier: "rules",
  maskable: true,
  createdAt: "2026-10-20T00:00:00Z",
  group: null,
  policy: "allow",
  expiry: { kind: "never" },
  rotatedAt: null,
  ...over,
});

// 与 sudo-flow.test.ts 同一套手法：直接拿到 tool_call 处理器，记录 ask 与 references.record。
function harness(opts: {
  vars?: VariableMeta[];
  tier?: Tier;
  answer?: string;
}) {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const asked: Array<{ options: { id: string }[] }> = [];
  const refs: Array<{
    name: string;
    toolCallId: string;
    result: RefResult;
    command?: string;
  }> = [];
  permissionExtension({
    directoryCtx: dirAt("/tmp/ws", { tier: opts.tier ?? "full" }),
    locate: locateAt("/tmp/ws"),
    tier: () => opts.tier ?? "full",
    ask: async (spec) => {
      asked.push(spec as never);
      return { outcome: "answered", optionId: opts.answer ?? "allow" } as never;
    },
    variables: () => opts.vars ?? [],
    references: { record: (r) => refs.push(r) },
  })({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as never);
  return {
    run: (command: string, toolCallId = "tc1") =>
      handler?.({
        toolName: "bash",
        toolCallId,
        input: { command },
      }) as Promise<{ block: true; reason: string } | undefined>,
    asked,
    refs,
  };
}

const CMD =
  "curl -H 'Authorization: {{@gitlab.token}}' https://gitlab.example.com";

describe("引用记录：每种 result 各一条", () => {
  test("ok：放行后记一条", async () => {
    const h = harness({ vars: [meta()] });
    expect(await h.run(CMD)).toBeUndefined();
    expect(h.refs).toEqual([
      {
        name: "gitlab.token",
        toolCallId: "tc1",
        result: "ok",
        directoryId: "id-proj",
        hostId: "local",
        command: CMD,
      },
    ]);
  });

  test("denied：policy=deny 直接拦截，只记 denied，不再记 ok/dropped", async () => {
    const h = harness({ vars: [meta({ policy: "deny" })] });
    const r = await h.run(CMD);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("策略为禁止");
    expect(h.refs.map((x) => x.result)).toEqual(["denied"]);
    expect(h.refs[0]?.command).toBe(CMD);
  });

  test("expired：到期的变量被拦截，只记 expired", async () => {
    const h = harness({
      vars: [meta({ expiry: { kind: "at", at: "2020-01-01T00:00:00Z" } })],
    });
    const r = await h.run(CMD);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("已过期");
    expect(h.refs.map((x) => x.result)).toEqual(["expired"]);
    expect(h.refs[0]?.command).toBe(CMD);
  });

  test("unknown：未登记的 {{@x}} 留一条记录，命令照常放行", async () => {
    const h = harness({ vars: [] });
    expect(await h.run("echo '{{@no.such.var}}'")).toBeUndefined();
    expect(h.refs).toEqual([
      {
        name: "no.such.var",
        toolCallId: "tc1",
        result: "unknown",
        directoryId: "id-proj",
        hostId: "local",
        command: "echo '{{@no.such.var}}'",
      },
    ]);
  });

  test("dropped：已登记变量的命令后来被用户拒绝 → dropped", async () => {
    const h = harness({
      vars: [meta({ policy: "ask" })],
      answer: "deny",
    });
    const r = await h.run(CMD);
    expect(r?.block).toBe(true);
    expect(h.refs.map((x) => x.result)).toEqual(["dropped"]);
    expect(h.refs[0]?.command).toBe(CMD);
  });

  test("命令里引用了多个变量：每条记录都带整条命令原文（遮罩与截取在 store 里做）", async () => {
    const h = harness({
      vars: [meta(), meta({ id: "v2", name: "other.token" })],
    });
    const cmd = "curl -u {{@other.token}} -H '{{@gitlab.token}}' https://x.io";
    expect(await h.run(cmd)).toBeUndefined();
    // 记录顺序跟占位符在命令里出现的顺序
    expect(h.refs.map((x) => [x.name, x.command])).toEqual([
      ["other.token", cmd],
      ["gitlab.token", cmd],
    ]);
  });
});

describe("policy=ask", () => {
  test("full 档与已记住规则都不放行：必须弹审批，且不可记住", async () => {
    const h = harness({
      vars: [meta({ policy: "ask", tier: "full" })],
      tier: "full",
    });
    expect(await h.run(CMD)).toBeUndefined();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.options.map((o) => o.id)).not.toContain("remember");
    expect(h.refs.map((x) => x.result)).toEqual(["ok"]);
  });

  test("对照：policy=allow 且变量档位 full 时，同一条命令不弹窗", async () => {
    const h = harness({ vars: [meta({ tier: "full" })], tier: "full" });
    expect(await h.run(CMD)).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });
});

describe("policy=allow（自动放行）", () => {
  // 界面新建的变量档位固定是 rules；自动放行不能因此在任何档位下都还要弹审批
  test("完全允许档 + 默认 rules 档位的变量：不弹窗", async () => {
    const h = harness({ vars: [meta({ tier: "rules" })], tier: "full" });
    expect(await h.run(CMD)).toBeUndefined();
    expect(h.asked).toHaveLength(0);
    expect(h.refs.map((x) => x.result)).toEqual(["ok"]);
  });

  test("对照：同一条命令、同一档位，策略 ask 的变量仍要弹窗", async () => {
    const h = harness({
      vars: [meta({ policy: "ask", tier: "full" })],
      tier: "full",
    });
    await h.run(CMD);
    expect(h.asked).toHaveLength(1);
  });

  test("用法超出范围的自动放行变量仍交人工（范围问题不能被「自动放行」吞掉）", async () => {
    const h = harness({
      vars: [meta({ scopeKind: "domain", scopeTarget: "gitlab.example.com" })],
      tier: "full",
    });
    await h.run(
      "curl -H 'Authorization: {{@gitlab.token}}' https://other.example.org",
    );
    expect(h.asked).toHaveLength(1);
  });
});

describe("{{@名称}} 语法与转义", () => {
  test("bracedNames：跳过被 \\{{@ 转义的字面量", () => {
    expect(bracedNames("echo {{@aaa}} \\{{@bbb}} {{@ccc.dd}}")).toEqual([
      "aaa",
      "ccc.dd",
    ]);
  });

  test("转义的字面量不产生占位符命中，也不记 unknown", async () => {
    const known = new Set(["tok.en"]);
    expect(findPlaceholders("echo \\{{@tok.en}}", known)).toEqual([]);
    const h = harness({ vars: [] });
    expect(await h.run("echo \\{{@tok.en}}")).toBeUndefined();
    expect(h.refs).toEqual([]);
  });

  test("substitute：新文法名含 . 和 -，改写成 hex 编码的合法 shell 变量名", async () => {
    const r = await substitute(
      "curl -H '{{@gitlab.token}}' x",
      new Map([["gitlab.token", "glpat-secret"]]),
    );
    const key = Object.keys(r.env)[0] as string;
    expect(key).toMatch(/^YUANSHU_VAR_0[0-9a-f]+$/);
    expect(r.env[key]).toBe("glpat-secret");
    expect(r.command).toBe(`curl -H ''"\${${key}}"'' x`);
    expect(r.command).not.toContain("glpat-secret");
  });

  test("旧文法的 @name 仍按原样改写，且 @name 不吞 {{@name}} 内部", async () => {
    const r = await substitute(
      "echo @Tok {{@tok}}",
      new Map([
        ["Tok", "value-one"],
        ["tok", "value-two"],
      ]),
    );
    expect(r.env).toEqual({
      YUANSHU_VAR_Tok: "value-one",
      YUANSHU_VAR_tok: "value-two",
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 期望的是 shell 的 ${} 字面量
    expect(r.command).toBe('echo "${YUANSHU_VAR_Tok}" "${YUANSHU_VAR_tok}"');
  });
});
