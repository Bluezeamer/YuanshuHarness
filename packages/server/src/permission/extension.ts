// 权限扩展：拦截 tool_call，按 decide 放行或弹审批（ADR-0030）。任何异常、拒绝、超时、撤销都 block。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PromptResult, PromptSpec } from "../session/prompts.js";
import type { VariableMeta } from "../store/secrets.js";
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
import {
  findSensitiveBelow,
  type PathEnv,
  pathOf,
  resolveTarget,
} from "./paths.js";
import { isRootShell, probeCommandLine, type SudoState } from "./sudo.js";
import { effectiveTier, variableUses } from "./variables.js";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
const SUMMARY_MAX = 300;

/** 自动审核结论；`ask` 表示降级给用户。 */
export type ReviewVerdict =
  | { decision: "allow" }
  | { decision: "ask"; reason?: string }
  | { decision: "deny"; reason: string };

/** 会话此刻所在的环境与工作目录；每次工具调用即时读取，切换 workspace 立刻生效。 */
export interface Where {
  env: PathEnv;
  cwd: string;
}

export interface PermissionDeps {
  where: () => Where;
  /** 每次调用即时读取，档位改动立刻生效。 */
  tier: () => Tier;
  rules: () => { path: { access: Access; value: string }[]; command: string[] };
  addRule: (r: RememberRule) => void;
  ask: (spec: PromptSpec) => Promise<PromptResult>;
  /** 已登记变量的元数据（不含值）；缺省视为没有变量（ADR-0052）。 */
  variables?: () => readonly VariableMeta[];
  /** sudo 探测，绑定到会话当前环境；缺省不探测（ADR-0054）。 */
  sudo?: {
    probe: (cwd: string, args: string[]) => Promise<SudoState>;
    /** 批准了 sudo 命令之后调用：sudoers 可能被改了。 */
    invalidate: () => void;
  };
  /** 二档审核；缺省（无审核方）时同一档。 */
  review?: (input: {
    tool: string;
    summary: string;
    input: Record<string, unknown>;
  }) => Promise<ReviewVerdict>;
  /** 记录需要裁决的调用的结论（规则内自动放行不记）。 */
  audit?: (rec: {
    actor: "user" | "system";
    summary: string;
    detail: Record<string, unknown>;
  }) => void;
}

const clip = (s: string) =>
  s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s;

/** 记住时的目录：目标是目录取自身，否则取父目录。 */
async function dirOf(p: string, env: PathEnv): Promise<string> {
  if ((await env.stat(p).catch(() => null))?.isDirectory) return p;
  return pathOf(env).dirname(p);
}

async function classify(
  tool: string,
  input: Record<string, unknown>,
  { env, cwd }: Where,
  // 用了隐私变量的命令不走只读白名单：`echo @tok | rev` 之类会把编码后的值带进输出。
  extra: { usesVars: boolean; rootShell: boolean },
): Promise<{ action: Action | null; summary: string }> {
  if (COMMAND_TOOLS.has(tool)) {
    const line = typeof input.command === "string" ? input.command : "";
    const { words, opaque } = await analyzeCommand(line);
    const segs = await parseCommand(line);
    const operands = await operandsInside(line, cwd, env);
    return {
      summary: clip(line),
      action: {
        kind: "command",
        line,
        words,
        resolved: operands.resolved,
        opaque,
        // 只读白名单还要求路径操作数都在 cwd 内；出界的转规则外审批（可按原规则记住）
        readOnly:
          !extra.usesVars && operands.inside && (await isReadOnlyCommand(line)),
        normalized: await normalizeCommand(line),
        rememberable: await rememberable(line),
        sudo: segs
          ? segs.some((s) => s.some(isSudoWord))
          : words.some(isSudoWord),
        ...(extra.rootShell ? { rootShell: true } : {}),
      },
    };
  }
  const access: Access = WRITE_TOOLS.has(tool) ? "write" : "read";
  const raw =
    typeof input.path === "string" && input.path !== "" ? input.path : cwd;
  const p = await resolveTarget(raw, cwd, env);
  // 悬空/循环链接等无法解析：按 cwd 外处理，只交人工、不可记住
  if (p === null) return { summary: clip(raw), action: null };
  // 决定实际读哪些文件的选择器：grep 的 glob、find 的 pattern（grep 的 pattern 是内容正则，不是路径）
  const sel =
    tool === "grep" ? input.glob : tool === "find" ? input.pattern : null;
  const selectors =
    typeof sel === "string" && sel !== ""
      ? [sel]
      : // 无选择器的 grep/find 会连隐藏文件一起读：目录树里有敏感文件就按敏感处理
        (tool === "grep" || tool === "find") && (await isDirectory(p, env))
        ? [await findSensitiveBelow(p, env)].filter(
            (x): x is string => x !== null,
          )
        : [];
  return {
    summary: clip(p),
    action: {
      kind: "path",
      access,
      targets: [{ path: p, dir: await dirOf(p, env) }],
      ...(selectors.length ? { selectors } : {}),
    },
  };
}

const isDirectory = async (p: string, env: PathEnv): Promise<boolean> =>
  (await env.stat(p).catch(() => null))?.isDirectory === true;

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
  // 审计失败不能改变裁决：这里是 fail-closed 路径，审计抛错不得变成拒绝。
  const note = (
    actor: "user" | "system",
    decision: "allow" | "deny" | "remember",
    by: "user" | "review" | "timeout" | "cancelled" | "error",
    tool: string,
    summary: string,
    reason?: string,
  ) => {
    try {
      deps.audit?.({
        actor,
        summary: `${decision} ${tool}: ${summary}`,
        detail: {
          op: tool,
          target: summary,
          result: decision,
          tool,
          decision,
          by,
          ...(reason ? { reason } : {}),
        },
      });
    } catch {}
  };
  return (pi) => {
    pi.on("tool_call", async (e) => {
      try {
        if (e.toolName === "ask_user") return;
        const input = e.input as Record<string, unknown>;
        const isCommand = COMMAND_TOOLS.has(e.toolName);
        const line =
          isCommand && typeof input.command === "string" ? input.command : "";
        const uses = deps.variables
          ? await variableUses(line, deps.variables())
          : [];
        const rootShell = /\bsu(do)?\b/.test(line) && (await isRootShell(line));
        // 完全允许档只在用了变量或开 root shell 时才继续往下判（ADR-0007）。
        if (deps.tier() === "full" && uses.length === 0 && !rootShell) return;
        // 命令生效的档位：workspace 与所用变量取最严的一档。
        const tier = effectiveTier(deps.tier(), uses);
        const problems = uses.filter((u) => u.problem);
        const known =
          READ_TOOLS.has(e.toolName) ||
          WRITE_TOOLS.has(e.toolName) ||
          isCommand;
        let d: ReturnType<typeof decide>;
        let summary: string;
        let sudoNote = "";
        if (known) {
          const where = deps.where();
          const r = await classify(e.toolName, input, where, {
            usesVars: uses.length > 0,
            rootShell,
          });
          summary = r.summary;
          const rules = deps.rules();
          d = r.action
            ? decide(r.action, {
                tier,
                cwd: where.cwd,
                pathRules: rules.path,
                commandRules: rules.command,
                pm: pathOf(where.env),
              })
            : { verdict: "ask", remember: null, reviewable: false };
        } else {
          // 未知工具（自定义/MCP）视为规则外，不可记住；无能力信息，auto 档也只交人工。
          summary = clip(JSON.stringify(input));
          d = { verdict: "ask", remember: null, reviewable: false };
        }
        // 超出适用范围的变量用法一律交人工，已记住的规则也不放行。
        if (problems.length > 0)
          d = { verdict: "ask", remember: null, reviewable: false };
        if (d.verdict === "allow") return;

        // 需要密码却没按范围提供 sudo 变量：不弹窗，直接告诉模型怎么写（ADR-0054）。
        const supplied = uses.some(
          (u) => u.meta.scopeKind === "sudo" && !u.problem,
        );
        if (isCommand && deps.sudo && !supplied && !rootShell) {
          const state = await probeCommandLine(
            deps.sudo.probe,
            line,
            deps.where().cwd,
          );
          if (state === "password") {
            const names = (deps.variables?.() ?? [])
              .filter((v) => v.scopeKind === "sudo")
              .map((v) => `@${v.name}`);
            return {
              block: true,
              reason: names.length
                ? `sudo 需要密码，这条命令没有提供。可用的 sudo 密码变量：${names.join("、")}。写成：printf '%s\\n' ${names[0]} | sudo -S -p '' <命令>`
                : "sudo 需要密码，但没有登记 sudo 范围的隐私变量。请让用户在设置里登记 sudo 密码，或为这条命令配置 NOPASSWD 免密。",
            };
          }
          if (state === "nopasswd") sudoNote = "sudo 免密可用（NOPASSWD）。";
        }

        let downgrade = "";
        if (tier === "auto" && d.reviewable && deps.review) {
          const v = await deps.review({
            tool: e.toolName,
            summary,
            input: redact(e.toolName, input),
          });
          if (v.decision === "allow") {
            note("system", "allow", "review", e.toolName, summary);
            return;
          }
          if (v.decision === "deny") {
            note("system", "deny", "review", e.toolName, summary, v.reason);
            return { block: true, reason: `自动审核拒绝：${v.reason}` };
          }
          downgrade = `审核方拿不准，交由你决定${v.reason ? `（${v.reason}）` : ""}`;
        }

        // 弹窗只写变量名与用途类说明，值从不进入这一层。
        const notes = [
          ...(downgrade ? [downgrade] : []),
          ...uses.map((u) =>
            u.problem
              ? `隐私变量 @${u.meta.name} 超出适用范围：${u.problem}`
              : u.meta.scopeKind === "sudo"
                ? `将使用隐私变量 @${u.meta.name} 作为 sudo 密码，只传给这一条命令。`
                : `将使用隐私变量 @${u.meta.name}，只传给这一条命令。`,
          ),
          ...(rootShell
            ? ["警告：这条命令会打开 root shell，任何档位下都需要人工批准。"]
            : []),
          ...(sudoNote ? [sudoNote] : []),
        ];
        const options = [
          { id: "allow", label: "仅此次通过" },
          { id: "deny", label: "拒绝" },
          ...(d.remember ? [{ id: "remember", label: "通过并记住" }] : []),
        ];
        const r = await deps.ask({
          source: "approval",
          kind: "choice",
          title: `允许执行 ${e.toolName}？`,
          body: notes.length ? `${notes.join("\n")}\n\n${summary}` : summary,
          options,
          detail: { tool: e.toolName, summary },
        });
        if (r.outcome === "timeout") {
          note("system", "deny", "timeout", e.toolName, summary);
          return { block: true, reason: "审批超时，已拒绝" };
        }
        if (r.outcome === "cancelled") {
          note("system", "deny", "cancelled", e.toolName, summary);
          return { block: true, reason: "审批已取消，已拒绝" };
        }
        if (r.optionId === "remember" && d.remember) {
          deps.addRule(d.remember);
          note("user", "remember", "user", e.toolName, summary);
        } else if (r.optionId === "allow") {
          note("user", "allow", "user", e.toolName, summary);
        } else {
          note("user", "deny", "user", e.toolName, summary);
          return { block: true, reason: "用户拒绝了该操作" };
        }
        // 批准的 sudo 命令可能改了 sudoers：丢掉该环境的探测缓存。
        if (/\bsudo\b/.test(line)) deps.sudo?.invalidate();
      } catch {
        note("system", "deny", "error", e.toolName, "");
        return { block: true, reason: "权限检查出错，已拒绝" };
      }
    });
  };
}
