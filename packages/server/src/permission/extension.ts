// 权限扩展：拦截 tool_call，按 decide 放行或弹审批（ADR-0030）。任何异常、拒绝、超时、撤销都 block。
import { statSync } from "node:fs";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PromptResult, PromptSpec } from "../session/prompts.js";
import type { Tier } from "../store/workspaces.js";
import {
  analyzeCommand,
  isReadOnlyCommand,
  isSudoWord,
  normalizeCommand,
  operandsInside,
  parseCommand,
  rememberable,
} from "./bash.js";
import {
  type Access,
  type Action,
  decide,
  type RememberRule,
} from "./decide.js";
import { resolveTarget } from "./paths.js";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
const SUMMARY_MAX = 300;

/** 自动审核结论；`ask` 表示降级给用户。 */
export type ReviewVerdict =
  | { decision: "allow" }
  | { decision: "ask"; reason?: string }
  | { decision: "deny"; reason: string };

export interface PermissionDeps {
  cwd: string;
  /** 每次调用即时读取，档位改动立刻生效。 */
  tier: () => Tier;
  rules: () => { path: { access: Access; value: string }[]; command: string[] };
  addRule: (r: RememberRule) => void;
  ask: (spec: PromptSpec) => Promise<PromptResult>;
  /** 二档审核；缺省（无审核方）时同一档。 */
  review?: (input: {
    tool: string;
    summary: string;
    input: Record<string, unknown>;
  }) => Promise<ReviewVerdict>;
}

const clip = (s: string) =>
  s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s;

/** 记住时的目录：目标是目录取自身，否则取父目录。 */
function dirOf(p: string): string {
  try {
    if (statSync(p).isDirectory()) return p;
  } catch {
    // 尚不存在：按文件处理
  }
  return path.dirname(p);
}

async function classify(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<{ action: Action | null; summary: string }> {
  if (COMMAND_TOOLS.has(tool)) {
    const line = typeof input.command === "string" ? input.command : "";
    const { words, opaque } = await analyzeCommand(line);
    const segs = await parseCommand(line);
    return {
      summary: clip(line),
      action: {
        kind: "command",
        line,
        words,
        opaque,
        // 只读白名单还要求路径操作数都在 cwd 内；出界的转规则外审批（可按原规则记住）
        readOnly:
          (await isReadOnlyCommand(line)) && (await operandsInside(line, cwd)),
        normalized: await normalizeCommand(line),
        rememberable: await rememberable(line),
        sudo: segs
          ? segs.some((s) => s.some(isSudoWord))
          : words.some(isSudoWord),
      },
    };
  }
  const access: Access = WRITE_TOOLS.has(tool) ? "write" : "read";
  const raw =
    typeof input.path === "string" && input.path !== "" ? input.path : cwd;
  const p = resolveTarget(raw, cwd);
  // 悬空/循环链接等无法解析：按 cwd 外处理，只交人工、不可记住
  if (p === null) return { summary: clip(raw), action: null };
  // 决定实际读哪些文件的选择器：grep 的 glob、find 的 pattern（grep 的 pattern 是内容正则，不是路径）
  const sel =
    tool === "grep" ? input.glob : tool === "find" ? input.pattern : null;
  return {
    summary: clip(p),
    action: {
      kind: "path",
      access,
      targets: [{ path: p, dir: dirOf(p) }],
      ...(typeof sel === "string" && sel !== "" ? { selectors: [sel] } : {}),
    },
  };
}

const sizeOf = (v: unknown): number =>
  typeof v === "string"
    ? v.length
    : Array.isArray(v)
      ? v.reduce((n: number, x) => n + sizeOf(x), 0)
      : v && typeof v === "object"
        ? Object.values(v).reduce((n: number, x) => n + sizeOf(x), 0)
        : 0;

/** 送审脱敏：写类工具只留路径与各内容字段的长度，write.content、edit 新旧文本等不出现在审核输入里。 */
function redact(
  tool: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!WRITE_TOOLS.has(tool)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) =>
      k === "path" ? [k, v] : [`${k}Length`, sizeOf(v)],
    ),
  );
}

export function permissionExtension(deps: PermissionDeps): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (e) => {
      try {
        if (e.toolName === "ask_user") return;
        const tier = deps.tier();
        if (tier === "full") return;
        const input = e.input as Record<string, unknown>;
        const known =
          READ_TOOLS.has(e.toolName) ||
          WRITE_TOOLS.has(e.toolName) ||
          COMMAND_TOOLS.has(e.toolName);
        let d: ReturnType<typeof decide>;
        let summary: string;
        if (known) {
          const r = await classify(e.toolName, input, deps.cwd);
          summary = r.summary;
          const rules = deps.rules();
          d = r.action
            ? decide(r.action, {
                tier,
                cwd: deps.cwd,
                pathRules: rules.path,
                commandRules: rules.command,
              })
            : { verdict: "ask", remember: null, reviewable: false };
        } else {
          // 未知工具（自定义/MCP）视为规则外，不可记住；无能力信息，auto 档也只交人工。
          summary = clip(JSON.stringify(input));
          d = { verdict: "ask", remember: null, reviewable: false };
        }
        if (d.verdict === "allow") return;

        let downgrade = "";
        if (tier === "auto" && d.reviewable && deps.review) {
          const v = await deps.review({
            tool: e.toolName,
            summary,
            input: redact(e.toolName, input),
          });
          if (v.decision === "allow") return;
          if (v.decision === "deny")
            return { block: true, reason: `自动审核拒绝：${v.reason}` };
          downgrade = `审核方拿不准，交由你决定${v.reason ? `（${v.reason}）` : ""}`;
        }

        const options = [
          { id: "allow", label: "仅此次通过" },
          { id: "deny", label: "拒绝" },
          ...(d.remember ? [{ id: "remember", label: "通过并记住" }] : []),
        ];
        const r = await deps.ask({
          source: "approval",
          kind: "choice",
          title: `允许执行 ${e.toolName}？`,
          body: downgrade ? `${downgrade}\n\n${summary}` : summary,
          options,
          detail: { tool: e.toolName, summary },
        });
        if (r.outcome === "timeout")
          return { block: true, reason: "审批超时，已拒绝" };
        if (r.outcome === "cancelled")
          return { block: true, reason: "审批已取消，已拒绝" };
        if (r.optionId === "allow") return;
        if (r.optionId === "remember" && d.remember) {
          deps.addRule(d.remember);
          return;
        }
        return { block: true, reason: "用户拒绝了该操作" };
      } catch {
        return { block: true, reason: "权限检查出错，已拒绝" };
      }
    });
  };
}
