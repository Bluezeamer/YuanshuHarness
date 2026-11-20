import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// 占位工具 call_tool（prompt-delivery.md §4）：新增的工具不进冻结声明（模型直接调用成功率低），
// 由状态通知列出签名，模型经 call_tool { name, arguments } 调用。解析器是纯函数，每步失败就返回
// 英文错误并写明「工具没有执行」，不猜；内层调用走与模型直接调用同样的校验、钩子与权限。

export const CALL_TOOL = "call_tool";

export type Parsed =
  | { ok: true; name: string; args: Record<string, unknown> }
  | { ok: false; error: string };

const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");

const sig = (name: string, args: unknown) =>
  `call_tool({ "name": ${JSON.stringify(name)}, "arguments": ${JSON.stringify(args)} })`;

function closest(name: string, all: readonly string[]): string[] {
  const n = norm(name);
  return all
    .filter((t) => norm(t).includes(n) || n.includes(norm(t)))
    .slice(0, 3);
}

/** 工具名：去空白与 `functions.` 前缀；大小写与 -/_ 差异在唯一匹配时接受，其余不近似。 */
function resolveName(
  raw: unknown,
  callable: readonly string[],
): { name: string } | { error: string } {
  if (typeof raw !== "string" || raw.trim() === "")
    return {
      error: `"name" must be the name of the tool to call. Callable tools: ${callable.join(", ")}.`,
    };
  const name = raw.trim().replace(/^functions\./, "");
  if (callable.includes(name)) return { name };
  const hit = callable.filter((t) => norm(t) === norm(name));
  if (hit.length === 1) return { name: hit[0] as string };
  const near = closest(name, callable);
  return {
    error: `There is no callable tool named "${name}".${near.length ? ` Closest: ${near.join(", ")}.` : ""} Callable tools: ${callable.join(", ")}.`,
  };
}

/** arguments 归一：省略 → {}；对象原样；字符串按 JSON 解析一次，只做去围栏与去尾随逗号两种确定性修复。 */
function normalizeArgs(
  raw: unknown,
): { args: Record<string, unknown> } | { error: string } {
  if (raw === undefined || raw === null) return { args: {} };
  if (typeof raw === "object" && !Array.isArray(raw))
    return { args: raw as Record<string, unknown> };
  if (typeof raw !== "string")
    return { error: '"arguments" must be a JSON object.' };
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  for (const text of [raw, unfenced, unfenced.replace(/,(\s*[}\]])/g, "$1")]) {
    try {
      const v = JSON.parse(text) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v))
        return { args: v as Record<string, unknown> };
    } catch {
      // 换下一种修复
    }
  }
  return { error: '"arguments" is a string that is not valid JSON.' };
}

/** 外层参数 → 目标工具名与参数。schema 校验由 validate 步完成。 */
export function parseCall(outer: unknown, callable: readonly string[]): Parsed {
  const fail = (error: string): Parsed => ({
    ok: false,
    error: `${error} The tool was NOT executed.`,
  });
  if (typeof outer !== "object" || outer === null || Array.isArray(outer))
    return fail(`call_tool takes an object like ${sig("<tool>", {})}.`);
  const o = outer as Record<string, unknown>;
  const n = resolveName(o.name, callable);
  if ("error" in n) return fail(n.error);
  // 顶层平铺（缺 arguments 但有别的键）：不自动搬，给出改正后的完整调用。
  const { name: _n, arguments: raw, ...flat } = o;
  if (raw === undefined && Object.keys(flat).length > 0)
    return fail(
      `The tool's parameters must be inside "arguments". Call it like ${sig(n.name, flat)}.`,
    );
  const a = normalizeArgs(raw);
  if ("error" in a) return fail(a.error);
  return { ok: true, name: n.name, args: a.args };
}

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
}

/** 按目标工具的 schema 校验；失败改写成「哪里错 → 合法的是什么 → 怎么改」。 */
export function validateCall(
  tool: RegisteredTool,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const checked = validateToolArguments(tool as never, {
      type: "toolCall",
      id: "call_tool",
      name: tool.name,
      arguments: args as never,
    }) as Record<string, unknown>;
    return { ok: true, args: checked };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `The arguments for "${tool.name}" are invalid:\n${why}\nExpected parameters (JSON schema): ${JSON.stringify(tool.parameters)}\nFix them and call again, like ${sig(tool.name, args)}. The tool was NOT executed.`,
    };
  }
}

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

/**
 * call_tool 本身：框架工具，自身权限放行，审批发生在内层。
 * callable：此刻可调用的工具名（启用集合去掉框架工具与 call_tool 自己）。
 */
export function callToolExtension(opts: {
  callable: () => string[];
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: CALL_TOOL,
      label: "call_tool",
      description:
        "Call a tool that is not in your tool list, using the signature given in a system state update. Pass { name, arguments } where name is the tool's name and arguments is an object matching its parameters.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the tool to call" },
          arguments: {
            description: "Arguments object for that tool (omit for none)",
          },
        },
        required: ["name"],
      } as never,
      // 外层参数交给我们校验：pi 的外层校验文案不带签名。
      prepareArguments: (a: unknown) => a as never,
      async execute(_id, params, signal, _update, ctx) {
        const callable = opts.callable();
        const parsed = parseCall(params, callable);
        if (!parsed.ok) return text(parsed.error, true) as never;
        const tool = ctx.tools.find((t) => t.name === parsed.name);
        if (tool) {
          const v = validateCall(tool as never, parsed.args);
          if (!v.ok) return text(v.error, true) as never;
        }
        const out = await ctx.executeTool(parsed.name, parsed.args, {
          ...(signal ? { signal } : {}),
        });
        // 内层 isError 原样透传，不再包一层。
        return out.isError
          ? ({ ...out.result, isError: true } as never)
          : (out.result as never);
      },
    });
  };
}
