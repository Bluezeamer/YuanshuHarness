// 权限扩展：拦截 tool_call，按 decide 放行或弹审批（ADR-0030）。任何异常、拒绝、超时、撤销都 block。
import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { CANVAS_DIR } from "../canvas/layout.js";
import type { ExecEnv } from "../env/types.js";
import {
  DETAIL_STRING_MAX,
  type PromptResult,
  type PromptSpec,
  withUserNote,
} from "../session/prompts.js";
import { TRANSFER_TOOL } from "../session/transfer-tool.js";
import { COLLAB_ENV_ID } from "../store/environments.js";
import { expiresAt, isExpired, type VariableMeta } from "../store/secrets.js";
import type { NamedRun } from "../workflow/named.js";
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
  type Decision,
  decide,
  type RememberRule,
} from "./decide.js";
import { isInteractive } from "./interactive.js";
import {
  findSensitiveBelow,
  isInside,
  type PathEnv,
  pathOf,
  resolveTarget,
} from "./paths.js";
import { bracedNames } from "./placeholders.js";
import { INPUT_MAX as REVIEW_INPUT_MAX } from "./review.js";
import {
  isRootShell,
  mentionsSudo,
  probeCommandLine,
  type SudoState,
} from "./sudo.js";
import type { Tier } from "./tier.js";
import {
  isFlatTool,
  matrixTool,
  type Policy,
  type ToolPolicy,
} from "./tool-matrix.js";
import { effectiveTier, variableUses } from "./variables.js";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
// 自带校验的工具，不走审批：ask_user 是交互通道。job_* 是框架工具：job_start 的内层调用走自己的权限判定，
// 其余只动调用方自己名下的任务。todo_write 只写会话自己的任务清单。
// browser_open 自己审批：要不要问取决于目标是公网、本工作区文件还是自起的服务，只有工具解析完才知道。
// browser_upload 自己审批：卡片要写明文件与目标站点，目标站点取自页面此刻的真实地址，工具解析完才知道。
const SELF_GATED = new Set<string>([
  "ask_user",
  "todo_write",
  // 目标工具只写会话自己的目标状态。
  "get_goal",
  "create_goal",
  "update_goal",
  "browser_open",
  "browser_upload",
  // 框架工具：自身放行，审批发生在 call_tool 包着的内层调用上。
  "call_tool",
  "job_start",
  "job_list",
  "job_stop",
  "job_remind",
  "deliver",
  "post",
]);
// 只改变工具落点的 directory 工具：无人值守时放行，可切换的范围由池限定在子会话的子集内。
const DIRECTORY_TOOLS = new Set(["list_directories", "switch_directory"]);
const SUMMARY_MAX = 300;
// 附件区（虚拟主机 attachment）：只放行它根内的路径，不看档位、规则与敏感文件名；越界已在地址解析里报错。
const ATTACHMENT_OUTSIDE = "Paths on the attachment host must stay inside it.";
// 附件区对 agent 只读：写与改一律拒绝（任何档位），读与作为传输源照常。
const ATTACHMENT_READONLY =
  "The attachment host is read-only. Copy the file into a directory first (transfer_files), then change the copy.";
// 协作区（虚拟主机 collab）：同一棵树的会话都能读，子代理只写自己的子目录。
const COLLAB_DENIED =
  "That path in the collab host is not yours to change. Subagents can write only under their own folder; everything in the tree can be read.";
// 画布文件夹由 canvas_edit 管：write / edit 写 .canvas/ 在任何档位下都被拦，读不拦（canvas.md §4）。
const CANVAS_GUARDED =
  ".canvas/ is managed by the canvas_edit tool. Use canvas_edit to change canvas files (reading them with read, grep, find or ls is fine). If canvas_edit is not available, tell the user.";

/** 自动审核结论；`ask` 表示降级给用户。 */
export type ReviewVerdict =
  | { decision: "allow" }
  | { decision: "ask"; reason?: string }
  | { decision: "deny"; reason: string };

/** 硬拦截：不进档位与规则判定，也没有审批出口（附件区的路径护栏）。 */
export type Blocked = { verdict: "deny"; reason: string };

/** 会话此刻所在的环境与工作目录；每次工具调用即时读取，切换 directory 立刻生效。 */
export interface Where {
  env: PathEnv;
  cwd: string;
}

/** 某个 directory 的判定上下文：跨 directory 的工具对每一端各取各的，而不是会话当前的。 */
export interface DirectoryCtx {
  id: string;
  name: string;
  /** 目录的引用写法 `<host>:<name>`。 */
  ref: string;
  where: Where;
  /** 生效的档位（含会话配置与子会话上限）。 */
  tier: Tier;
  rules: { path: { access: Access; value: string }[]; command: string[] };
  /** 记住的规则落在这个 directory 上；子会话不产生新规则。 */
  addRule: (r: RememberRule) => void;
}

/**
 * 一个目标地址的判定上下文：`host:path` 的展示形式、该环境、真实路径与归属目录。
 * 结构与 session/address.ts 的 Located 对应，不互相引用（这是结构类型）。
 */
export interface Located {
  host: string;
  shown: string;
  env: PathEnv;
  path: string;
  ctx: DirectoryCtx;
}

export interface PermissionDeps {
  /** 每次调用即时读取，档位改动立刻生效。 */
  tier: () => Tier;
  /**
   * 命令类工具（bash）的判定上下文：host 是 `<host>:<name>` 或缺省（= 当前目录）；
   * 解析失败抛 Error，信息直接给模型看。
   */
  directoryCtx: (host: string | undefined) => Promise<DirectoryCtx>;
  /**
   * 解析目标（session/address.ts 的 AddressBook.locate）：六个文件工具与 transfer_files 的两端都经它。
   * host 与 path 各自可缺省；`ctx` 是归属目录的判定上下文。不可解析时抛 Error，信息直接给模型看。
   */
  locate: (
    host: string | undefined,
    path: string | undefined,
  ) => Promise<Located>;
  ask: (spec: PromptSpec) => Promise<PromptResult>;
  /** 已登记变量的元数据（不含值，含过期与策略）；缺省视为没有变量（ADR-0052）。 */
  variables?: () => readonly VariableMeta[];
  /** sudo 探测，绑定到命令实际执行的环境；缺省不探测（ADR-0054）。 */
  sudo?: {
    probe: (env: ExecEnv, cwd: string, args: string[]) => Promise<SudoState>;
    /** 批准了 sudo 命令之后调用：那个环境的 sudoers 可能被改了。 */
    invalidate: (envId: string) => void;
  };
  /** 二档审核；缺省（无审核方）时同一档。 */
  review?: (input: {
    tool: string;
    summary: string;
    input: Record<string, unknown>;
  }) => Promise<ReviewVerdict>;
  /**
   * 无人值守（subagent 子会话，ADR-0060）：没有弹窗通道。需要人工的动作（root shell、
   * 要密码的 sudo、占终端的命令）和拿不准的调用一律拒绝，且不产生新的记住规则。
   */
  unattended?: boolean;
  /**
   * 协作区（subagent.md §8）：同一棵树的会话都能读，子代理只写自己的子目录。
   * 只对虚拟主机 collab 上的目标生效，不看档位、不弹审批。
   */
  collab?: { allows: (access: "read" | "write", absPath: string) => boolean };
  /**
   * 内置工具的出厂规则矩阵（当前生效值，cwd 内/外 × 放行/审批）；缺省按出厂默认。
   * 「放行」不越过敏感路径、解释器前缀不可记住等不变式。
   */
  toolPolicy?: (tool: string) => ToolPolicy | null;
  /** MCP 工具的审批档（按服务一档，不分 cwd 内外）；tool 不是已注册的 MCP 工具时返回 null。 */
  mcpApproval?: (tool: string) => Policy | null;
  /**
   * 命名流程（workflow.md §6）：workflow_run 给了 name 时在审批前解析成脚本与填好默认值的 args，
   * 直接改写 event.input，让「批准的就是运行的」只读一次文件。缺省时只认 script。
   */
  namedWorkflows?: {
    resolveRun: (name: string, args: unknown) => Promise<NamedRun>;
  };
  /** 记录需要裁决的调用的结论（规则内自动放行不记）。 */
  audit?: (rec: {
    actor: "user" | "system";
    summary: string;
    /** 目标环境；缺省由接线补成会话当前环境。 */
    environmentId?: string;
    detail: Record<string, unknown>;
  }) => void;
  /** 隐私变量引用记录；目录、主机、run 由调用方补全。缺省不记录。 */
  references?: {
    record: (rec: {
      name: string;
      toolCallId: string;
      result: RefResult;
      /** 命令实际所在（或被访问的）目录与主机。 */
      directoryId: string;
      hostId: string;
      /** 整条命令原文；落库前由引用记录的 store 遮罩并截取。 */
      command?: string;
    }) => void;
  };
}

type RefResult = "ok" | "denied" | "expired" | "unknown" | "dropped";

const clip = (s: string) =>
  s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s;

/** 只取字符串，别的当缺省（模型的入参不保证对）。 */
const strOr = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** 记住时的目录：目标是目录取自身，否则取父目录。 */
async function dirOf(p: string, env: PathEnv): Promise<string> {
  if ((await env.stat(p).catch(() => null))?.isDirectory) return p;
  return pathOf(env).dirname(p);
}

/** 命令类工具的动作：按这条命令实际所在目录判（bash 的 host 只选目录，不看 path）。 */
async function classifyCommand(
  input: Record<string, unknown>,
  { env, cwd }: Where,
  // 用了隐私变量的命令不走只读白名单：`echo @tok | rev` 之类会把编码后的值带进输出。
  extra: { usesVars: boolean; rootShell: boolean },
): Promise<{ action: Action; summary: string; full: string }> {
  const line = typeof input.command === "string" ? input.command : "";
  const { words, opaque } = await analyzeCommand(line);
  const segs = await parseCommand(line);
  const operands = await operandsInside(line, cwd, env);
  return {
    summary: clip(line),
    full: line,
    action: {
      kind: "command",
      line,
      words,
      resolved: operands.resolved,
      inside: operands.inside,
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

/** 把 sudo 探测绑到这条命令实际所在的环境（probeCommandLine 的签名不动；接线给的是真的 ExecEnv）。 */
const probeOf =
  (sudo: NonNullable<PermissionDeps["sudo"]>, ctx: DirectoryCtx) =>
  (cwd: string, args: string[]) =>
    sudo.probe(ctx.where.env as ExecEnv, cwd, args);

/** 文件类工具的选择器：grep 的 glob、find 的 pattern 决定实际读哪些文件（grep 的 pattern 是内容正则，不是路径）。 */
function selectorsOf(tool: string, input: Record<string, unknown>): string[] {
  const sel =
    tool === "grep" ? input.glob : tool === "find" ? input.pattern : null;
  return typeof sel === "string" && sel !== "" ? [sel] : [];
}

const isDirectory = async (p: string, env: PathEnv): Promise<boolean> =>
  (await env.stat(p).catch(() => null))?.isDirectory === true;

/**
 * 一个目标地址的判定：源端按「读」、目标端按「写」，用归属目录自己的档位、规则与 cwd。
 * 单端的 read/write 与 transfer_files 的两端都走这里——同一个问题只一种解法。
 * 展示用路径取地址的 `host:path` 形式（解析符号链接后的真实位置）。
 */
async function judgeTarget(
  access: Access,
  located: Located,
  policy: ToolPolicy | undefined,
  o: {
    // 工具自己的文件选择器（grep 的 glob、find 的 pattern）：决定实际读哪些文件，同样要过敏感与边界。
    selectors?: string[];
    // 读目录会带走整棵树（不带选择器的 grep / find、传输的源端）：树里有敏感名条目就按敏感处理。
    scanTree?: boolean;
    // 协作区的读写判定：由调用方按会话所在的那棵树给（不是全局）。
    collabAllows?: (access: "read" | "write", absPath: string) => boolean;
  } = {},
): Promise<{ d: Decision | Blocked; shown: string }> {
  const ctx = located.ctx;
  const { env, cwd } = ctx.where;
  const pm = pathOf(env);
  const virtual = env.kind === "virtual";
  // 展示形式：`host:真实路径`；虚拟主机只给它内部的相对形式，不暴露 Server 的真实路径。
  const shownOf = (p: string) =>
    virtual
      ? `${located.host}:/${pm.relative(cwd, p)}`
      : `${located.host}:${p}`;
  const fallback = located.shown;
  // 两个虚拟主机的护栏都在 full 档放行之前判（不看档位）：附件区只读，协作区按会话所在的那棵树判读写。
  if (virtual) {
    const real = await resolveTarget(located.path, cwd, env);
    const shown = real === null ? fallback : shownOf(real);
    if (env.id === COLLAB_ENV_ID) {
      const allowed =
        real !== null && (o.collabAllows?.(access, real) ?? false);
      return {
        shown,
        d: allowed
          ? { verdict: "allow" }
          : { verdict: "deny", reason: COLLAB_DENIED },
      };
    }
    if (access === "write")
      return {
        d: { verdict: "deny", reason: ATTACHMENT_READONLY },
        shown: fallback,
      };
    if (ctx.tier === "full")
      return { d: { verdict: "allow" }, shown: fallback };
    // 只放行它自己根内的路径，不看规则与敏感文件名（越界已在 locate 里报错）。
    const inside = real !== null && isInside(cwd, real, pm);
    return {
      shown,
      d: inside
        ? { verdict: "allow" }
        : { verdict: "deny", reason: ATTACHMENT_OUTSIDE },
    };
  }
  if (ctx.tier === "full") return { d: { verdict: "allow" }, shown: fallback };
  const real = await resolveTarget(located.path, cwd, env);
  // 悬空/循环链接等无法解析：按 cwd 外处理，只交人工、不可记住
  if (real === null)
    return {
      shown: fallback,
      d: { verdict: "ask", remember: null, reviewable: false },
    };
  const sensitive =
    o.scanTree && access === "read" && (await isDirectory(real, env))
      ? await findSensitiveBelow(real, env)
      : null;
  const all = [...(o.selectors ?? []), ...(sensitive ? [sensitive] : [])];
  return {
    shown: shownOf(real),
    d: decide(
      {
        kind: "path",
        access,
        targets: [{ path: real, dir: await dirOf(real, env) }],
        ...(all.length ? { selectors: all } : {}),
      },
      {
        tier: ctx.tier,
        cwd,
        pathRules: ctx.rules.path,
        commandRules: ctx.rules.command,
        pm,
        ...(policy ? { policy } : {}),
      },
    ),
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
  // 审计失败不能改变裁决：这里是 fail-closed 路径，审计抛错不得变成拒绝。
  const note = (
    actor: "user" | "system",
    decision: "allow" | "deny" | "remember",
    by:
      | "user"
      | "review"
      | "timeout"
      | "cancelled"
      | "error"
      | "unattended"
      | "rule",
    tool: string,
    summary: string,
    reason?: string,
    // 目标环境：命令与文件类调用记它们实际碰的那个环境，不记会话当前的。
    environmentId?: string,
  ) => {
    try {
      deps.audit?.({
        actor,
        summary: `${decision} ${tool}: ${summary}`,
        ...(environmentId ? { environmentId } : {}),
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
  // 无人值守的拒绝：记审计（拓扑上的被拒计数由此而来），并让模型把缺少的权限写进最终结果。
  const denyUnattended = (
    tool: string,
    summary: string,
    why: string,
    environmentId?: string,
  ) => {
    note("system", "deny", "unattended", tool, summary, why, environmentId);
    return {
      block: true,
      reason: `子会话没有人工审批通道，操作已拒绝（${why}）。请改用允许范围内的做法；确实需要这项权限时，不要重试，在最终结果里写明缺少什么，由父会话决定。`,
    };
  };
  // 虚拟主机的写护栏：附件区一律只读，协作区交给 collabAllows 判（同树可读、只写自己那份）。
  // 返回要 block 的结果；放行时返回 null。
  const virtualWriteDenied = async (
    located: Located,
    tool: string,
  ): Promise<ToolCallEventResult | null> => {
    if (located.env.id !== COLLAB_ENV_ID) {
      note(
        "system",
        "deny",
        "rule",
        tool,
        clip(located.shown),
        ATTACHMENT_READONLY,
      );
      return { block: true, reason: ATTACHMENT_READONLY };
    }
    if (!deps.collab) return { block: true, reason: COLLAB_DENIED };
    const real = await resolveTarget(
      located.path,
      located.ctx.where.cwd,
      located.env,
    );
    if (real !== null && deps.collab.allows("write", real)) return null;
    note("system", "deny", "rule", tool, clip(located.shown), COLLAB_DENIED);
    return { block: true, reason: COLLAB_DENIED };
  };
  // 引用记录失败不能影响裁决。目录与主机是命令实际所在（或被访问）的那个，不取会话当前的。
  const recordRef = (
    toolCallId: string,
    name: string,
    result: RefResult,
    command: string,
    at: { directoryId: string; hostId: string },
  ) => {
    try {
      deps.references?.record({
        name,
        toolCallId,
        result,
        directoryId: at.directoryId,
        hostId: at.hostId,
        ...(command ? { command } : {}),
      });
    } catch {}
  };
  // transfer_files 同时碰两个地址，不能按会话当前 directory 一次判完：两端各按各自的归属目录
  // 判定（源端读、目标端写），任一端「禁止」就拒绝，任一端要审批就合并成一个弹窗，两端都放行才执行。
  // auto 档不送自动审核：审核方只看得到 path 类字段，地址会被抹成长度，没法据此判断；
  // 需要审批的一律交人工，无人值守的子会话照例拒绝。
  const transferGate = async (
    input: Record<string, unknown>,
  ): Promise<ToolCallEventResult | undefined> => {
    const { from, to, from_host: fromHost, to_host: toHost } = input;
    if (typeof from !== "string" || typeof to !== "string")
      return { block: true, reason: "Both from and to are required." };
    let src: Located;
    let dst: Located;
    try {
      src = await deps.locate(strOr(fromHost), from);
      dst = await deps.locate(strOr(toHost), to);
    } catch (err) {
      // 地址不合法、主机不可用：执行时也是同样的错，把原因直接给模型
      return {
        block: true,
        reason:
          err instanceof Error
            ? err.message
            : "Transfer endpoints could not be resolved.",
      };
    }
    const side = async (
      label: string,
      verb: string,
      access: Access,
      at: Located,
      tool: "read" | "write",
    ) => ({
      label,
      verb,
      ctx: at.ctx,
      ...(await judgeTarget(access, at, deps.toolPolicy?.(tool) ?? undefined, {
        scanTree: access === "read",
        ...(deps.collab ? { collabAllows: deps.collab.allows } : {}),
      })),
    });
    const srcSide = await side("Source", "read", "read", src, "read");
    const dstSide = await side("Destination", "write", "write", dst, "write");
    const sides = [srcSide, dstSide];
    const at = (s: typeof srcSide) => s.shown;
    const full = `from ${at(srcSide)} to ${at(dstSide)}${input.overwrite === true ? " (overwrite allowed)" : ""}`;
    const summary = clip(full);
    for (const s of sides) {
      if (s.d.verdict !== "deny") continue;
      const why = `${s.label} (${s.ctx.name}): ${s.d.reason}`;
      note("system", "deny", "rule", TRANSFER_TOOL, summary, why);
      return { block: true, reason: why };
    }
    const asks = sides.flatMap((s) =>
      s.d.verdict === "ask" ? [{ s, remember: s.d.remember }] : [],
    );
    if (asks.length === 0) return;
    const notes = asks.map(
      ({ s }) => `${s.label} needs approval: ${s.verb} ${at(s)}`,
    );
    if (deps.unattended)
      return denyUnattended(TRANSFER_TOOL, summary, notes.join("；"));
    // 弹窗展示有上限：看不全的内容不让批准
    if (full.length > DETAIL_STRING_MAX) {
      note(
        "system",
        "deny",
        "error",
        TRANSFER_TOOL,
        summary,
        "输入过长，无法完整展示",
      );
      return {
        block: true,
        reason: `路径过长，超过 ${DETAIL_STRING_MAX} 个字符，无法完整展示给用户审批。请换更短的路径。`,
      };
    }
    // 要审批的每一端都有可记住的规则才提供「记住」，各记到各自的 directory
    const canRemember = asks.every(({ remember }) => remember !== null);
    const r = await deps.ask({
      source: "approval",
      input: "text",
      title: `允许执行 ${TRANSFER_TOOL}？`,
      body: `${notes.join("\n")}\n\n${summary}`,
      options: [
        { id: "allow", label: "仅此次通过" },
        { id: "deny", label: "拒绝" },
        ...(canRemember ? [{ id: "remember", label: "通过并记住" }] : []),
      ],
      detail: { tool: TRANSFER_TOOL, summary: full },
    });
    if (r.outcome === "timeout") {
      note("system", "deny", "timeout", TRANSFER_TOOL, summary);
      return { block: true, reason: "审批超时，已拒绝" };
    }
    if (r.outcome === "cancelled") {
      note("system", "deny", "cancelled", TRANSFER_TOOL, summary);
      return { block: true, reason: "审批已取消，已拒绝" };
    }
    if (r.optionId === "remember" && canRemember) {
      for (const { s, remember } of asks) if (remember) s.ctx.addRule(remember);
      note("user", "remember", "user", TRANSFER_TOOL, summary);
    } else if (r.optionId === "allow") {
      note("user", "allow", "user", TRANSFER_TOOL, summary);
    } else {
      note("user", "deny", "user", TRANSFER_TOOL, summary);
      return { block: true, reason: withUserNote("用户拒绝了该操作", r) };
    }
  };
  // 单开关工具的当前策略；非单开关工具返回 null。deps.toolPolicy 缺省（测试）时按出厂值。
  const flatPolicy = (tool: string): Policy | null =>
    isFlatTool(tool)
      ? ((deps.toolPolicy?.(tool) ?? matrixTool(tool)?.factory)?.inside ?? null)
      : null;
  // switch_mode：模式能「增加」基线外的工具，模型自己切进去等于自己加工具，所以真切换要人批（"list" 只是查看）。
  // 通过档不弹；自动审核档也不送审：给自己加工具不由审核模型代批。
  const switchModeGate = async (
    input: Record<string, unknown>,
  ): Promise<ToolCallEventResult | undefined> => {
    if (deps.tier() === "full") return;
    const want = String(input.mode ?? "").trim();
    if (want === "" || want.toLowerCase() === "list") return;
    if (flatPolicy("switch_mode") === "allow") return;
    const leaving = want.toLowerCase() === "none";
    const summary = clip(leaving ? "退出当前模式" : `切换到模式「${want}」`);
    const r = await deps.ask({
      source: "approval",
      input: "text",
      title: "允许切换工作模式？",
      body: `${summary}\n\n模式会改变提示词与可用工具${leaving ? "；退出后被该模式限制的工具会恢复" : ""}。`,
      options: [
        { id: "allow", label: "仅此次通过" },
        { id: "deny", label: "拒绝" },
      ],
      detail: { tool: "switch_mode", summary },
    });
    if (r.outcome === "timeout") {
      note("system", "deny", "timeout", "switch_mode", summary);
      return { block: true, reason: "审批超时，已拒绝" };
    }
    if (r.outcome === "cancelled") {
      note("system", "deny", "cancelled", "switch_mode", summary);
      return { block: true, reason: "审批已取消，已拒绝" };
    }
    if (r.optionId === "allow") {
      note("user", "allow", "user", "switch_mode", summary);
      return;
    }
    note("user", "deny", "user", "switch_mode", summary);
    return {
      block: true,
      reason: withUserNote("用户拒绝了切换模式", r),
    };
  };
  // workflow_run：一次运行可能启动几十到上千个模型会话，数量由脚本决定、事前估不出来，
  // 所以每次运行前让人看到脚本再批。通过档不弹；自动审核档也不送审：开销大小不由审核模型代判。
  // 命名流程（workflow.md §6）在弹窗前就把 name 解析成脚本与填好默认值的 args，并把 event.input
  // 改写成等价形式：弹窗里的文本与 execute 拿到的文本是同一份（文件只读一次）。
  const workflowGate = async (
    input: Record<string, unknown>,
  ): Promise<ToolCallEventResult | undefined> => {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    let layer = "";
    if (name !== "") {
      if (input.script !== undefined) {
        const why =
          "workflow_run takes either name or script, not both. Pass name for a saved workflow, or script for a new one.";
        note("system", "deny", "error", "workflow_run", name, why);
        return { block: true, reason: why };
      }
      const resolved = deps.namedWorkflows
        ? await deps.namedWorkflows.resolveRun(name, input.args)
        : {
            ok: false as const,
            error: "Named workflows are not available in this session.",
          };
      if (!resolved.ok) {
        note("system", "deny", "error", "workflow_run", name, "解析失败");
        return { block: true, reason: resolved.error };
      }
      layer = resolved.layer;
      input.script = resolved.script;
      if (resolved.args === undefined) delete input.args;
      else input.args = resolved.args;
      // 标签缺省取名称：解析后 name 就没了，任务清单要靠它认出这次运行
      if (typeof input.label !== "string" || input.label.trim() === "")
        input.label = name;
      delete input.name;
    } else if (input.script === undefined) {
      const why =
        "workflow_run needs either name (a saved workflow: see workflow_list) or script.";
      note("system", "deny", "error", "workflow_run", "", why);
      return { block: true, reason: why };
    }
    if (deps.tier() === "full" || flatPolicy("workflow_run") === "allow")
      return;
    const script = String(input.script ?? "");
    const summary = clip(script);
    const args = input.args;
    const argsJson = args === undefined ? "" : (JSON.stringify(args) ?? "");
    // summary 是给用户看的完整内容：脚本后面接 args，两段都看不全就不让批。
    const full =
      argsJson === "" ? script : `${script}\n\n--- args ---\n${argsJson}`;
    if (deps.unattended)
      return denyUnattended("workflow_run", summary, "运行工作流需要人工批准");
    if (full.length > DETAIL_STRING_MAX) {
      note(
        "system",
        "deny",
        "error",
        "workflow_run",
        summary,
        "脚本过长，无法完整展示",
      );
      return {
        block: true,
        reason: `脚本过长无法完整展示审批：脚本只做编排，请把大块数据写进文件、在 args 里传路径（展示上限 ${DETAIL_STRING_MAX} 个字符）。`,
      };
    }
    const label = typeof input.label === "string" ? input.label.trim() : "";
    const shownArgs =
      argsJson.length > SUMMARY_MAX
        ? `${argsJson.slice(0, SUMMARY_MAX)}…（已截断，完整内容见下方）`
        : argsJson;
    const facts = [
      ...(name === "" ? [] : [`命名流程：${name}（${layer}）`]),
      ...(label === "" || label === name ? [] : [`标签：${label}`]),
      ...(typeof input.concurrency === "number"
        ? [`并发数：${input.concurrency}`]
        : []),
      ...(argsJson === "" ? [] : [`args：${shownArgs}`]),
    ];
    const noteAbout = "每个 agent() 是一个完整的模型会话，数量由脚本决定。";
    const r = await deps.ask({
      source: "approval",
      input: "text",
      title: "允许运行工作流？",
      body:
        facts.length === 0 ? noteAbout : `${facts.join("\n")}\n\n${noteAbout}`,
      options: [
        { id: "allow", label: "仅此次通过" },
        { id: "deny", label: "拒绝" },
      ],
      detail: { tool: "workflow_run", summary: full },
    });
    if (r.outcome === "timeout") {
      note("system", "deny", "timeout", "workflow_run", summary);
      return { block: true, reason: "审批超时，已拒绝" };
    }
    if (r.outcome === "cancelled") {
      note("system", "deny", "cancelled", "workflow_run", summary);
      return { block: true, reason: "审批已取消，已拒绝" };
    }
    if (r.optionId === "allow") {
      note("user", "allow", "user", "workflow_run", summary);
      return;
    }
    note("user", "deny", "user", "workflow_run", summary);
    return {
      block: true,
      reason: withUserNote(
        "用户拒绝了这次运行。不要原样重试：请先向用户确认想要的范围，或换别的做法。",
        r,
      ),
    };
  };
  // 画布文件夹的写保护：write / edit 的目标落在它归属目录的 `.canvas/`（含目录本身）就拦，
  // 读不拦。任何档位都拦，所以不能放进 decide（full 档在那里直接放行）。
  const canvasGuard = async (
    e: ToolCallEvent,
    located: Located,
  ): Promise<ToolCallEventResult | undefined> => {
    const pm = pathOf(located.env);
    const target = pm.resolve(located.ctx.where.cwd, located.path);
    if (!isInside(pm.join(located.ctx.where.cwd, CANVAS_DIR), target, pm))
      return;
    note(
      "system",
      "deny",
      "rule",
      e.toolName,
      clip(located.shown),
      CANVAS_GUARDED,
    );
    return { block: true, reason: CANVAS_GUARDED };
  };
  return (pi) => {
    // 裁决本体。ref 收集本次调用用到的变量；done 表示 expired/denied 已经记过。
    const gate = async (
      e: ToolCallEvent,
      ref: {
        uses: { meta: VariableMeta }[];
        done: boolean;
        line: string;
        at: { directoryId: string; hostId: string } | null;
      },
    ): Promise<ToolCallEventResult | undefined> => {
      try {
        const input = e.input as Record<string, unknown>;
        const isCommand = COMMAND_TOOLS.has(e.toolName);
        const host = strOr(input.host);
        // 命令类工具的目标目录（bash 的 host 只选目录）：解析失败（裸主机、不在清单里的目录、
        // 环境不可用）与文件工具一样，把英文原因直接给模型，不弹审批。
        let cmd: { ctx: DirectoryCtx; line: string } | null = null;
        if (isCommand) {
          try {
            cmd = {
              ctx: await deps.directoryCtx(host),
              line: typeof input.command === "string" ? input.command : "",
            };
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            note(
              "system",
              "deny",
              "rule",
              e.toolName,
              clip(
                [host, strOr(input.command)]
                  .filter((x) => x !== undefined)
                  .join(" "),
              ),
              why,
            );
            return { block: true, reason: why };
          }
        }
        // 文件类工具的目标地址：六个文件工具按 path，传输工具的两端在 transferGate 里各自解析。
        // 解析失败（未知主机、裸绝对路径、主机不可用等）直接把英文原因给模型，不弹审批。
        let located: Located | null = null;
        if (READ_TOOLS.has(e.toolName) || WRITE_TOOLS.has(e.toolName)) {
          try {
            located = await deps.locate(
              host,
              typeof input.path === "string" ? input.path : undefined,
            );
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            note(
              "system",
              "deny",
              "rule",
              e.toolName,
              clip(
                [host, strOr(input.path)]
                  .filter((x) => x !== undefined)
                  .join(" "),
              ),
              why,
            );
            return { block: true, reason: why };
          }
        }
        // 隐私变量引用与审计都落在调用实际碰的目录与环境上，不取会话当前的。
        const refAt = cmd
          ? { directoryId: cmd.ctx.id, hostId: cmd.ctx.where.env.id }
          : located
            ? { directoryId: located.ctx.id, hostId: located.ctx.where.env.id }
            : null;
        ref.at = refAt;
        const envIdOf = refAt?.hostId;
        if (WRITE_TOOLS.has(e.toolName) && located !== null) {
          // 虚拟主机的写护栏：附件区只读、协作区按子树判，都是任何档位都拦，
          // 所以不能等 decide（full 档在下面直接放行）。
          if (located.env.kind === "virtual") {
            const reason = await virtualWriteDenied(located, e.toolName);
            if (reason !== null) return reason;
          }
          const blocked = await canvasGuard(e, located);
          if (blocked) return blocked;
        }
        if (e.toolName === "switch_mode") return await switchModeGate(input);
        if (e.toolName === "workflow_run") return await workflowGate(input);
        if (SELF_GATED.has(e.toolName)) return;
        if (deps.unattended && DIRECTORY_TOOLS.has(e.toolName)) return;
        // 传输两端各有自己的 directory，档位与规则都不取会话当前的，不走下面的单端流程。
        if (e.toolName === TRANSFER_TOOL) return await transferGate(input);
        // MCP 工具按服务一档，不分 cwd 内外；「放行」不再弹窗。
        const mcpTier = deps.mcpApproval?.(e.toolName) ?? null;
        if (mcpTier === "allow") return;
        // 单开关工具「放行」：不弹窗，不看 cwd。
        if (flatPolicy(e.toolName) === "allow") return;
        const line = cmd?.line ?? "";
        if (deps.unattended && cmd) {
          const state = deps.sudo
            ? await probeCommandLine(
                probeOf(deps.sudo, cmd.ctx),
                line,
                cmd.ctx.where.cwd,
              )
            : "unknown";
          const r = await isInteractive(line, state);
          if (r.interactive)
            return denyUnattended(
              e.toolName,
              clip(line),
              r.reason,
              cmd.ctx.where.env.id,
            );
        }
        // 引用分析（S4b）：过期与策略禁止在这里直接拦截；其余 ok/dropped 由外层按最终裁决落记录。
        const vars = deps.variables?.() ?? [];
        const uses = isCommand ? await variableUses(line, vars) : [];
        ref.uses = uses;
        ref.line = line;
        // 未登记的 `{{@x}}` 只留一条 unknown，命令照常走（Handlebars 等模板里的字面量不能被拦）。
        if (isCommand) {
          const known = new Set(vars.map((v) => v.name));
          for (const name of bracedNames(line))
            if (!known.has(name) && refAt)
              recordRef(e.toolCallId, name, "unknown", line, refAt);
        }
        const now = Date.now();
        const expiredUses = uses.filter((u) => isExpired(u.meta, now));
        if (expiredUses.length > 0) {
          for (const u of expiredUses)
            if (refAt)
              recordRef(e.toolCallId, u.meta.name, "expired", line, refAt);
          ref.done = true;
          const names = expiredUses.map((u) => {
            const at = expiresAt(u.meta);
            return `{{@${u.meta.name}}}（${at ? new Date(at).toISOString().split("T")[0] : ""}）`;
          });
          return {
            block: true,
            reason: `隐私变量已过期：${names.join("、")}`,
          };
        }
        const denied = uses.filter((u) => u.meta.policy === "deny");
        if (denied.length > 0) {
          for (const u of denied)
            if (refAt)
              recordRef(e.toolCallId, u.meta.name, "denied", line, refAt);
          ref.done = true;
          return {
            block: true,
            reason: `隐私变量策略为禁止：${denied.map((u) => `{{@${u.meta.name}}}`).join("、")}`,
          };
        }
        const rootShell = isCommand && (await isRootShell(line));
        const sudoUsed = isCommand && (await mentionsSudo(line));
        const policy = deps.toolPolicy?.(e.toolName) ?? undefined;
        // 目录的档位：命令类取命令实际所在目录的，文件类取目标地址归属目录的（与后面 decide 同一个）。
        const tierOf = cmd?.ctx.tier ?? located?.ctx.tier ?? deps.tier();
        // 完全允许档只在用了变量、开 root shell、用了 sudo（要探测密码）时才继续往下判（ADR-0007）。
        if (tierOf === "full" && uses.length === 0 && !rootShell && !sudoUsed)
          return;
        const problems = uses.filter((u) => u.problem);
        // 策略「自动放行」且用法在范围内的变量，不再额外加严：既不拉低档位，也不取消只读白名单。
        // 界面新建的变量档位固定是 rules，不这样的话「自动放行」在任何档位下都还是要弹审批。
        // 超出范围的用法不在这里管：后面 problems 会强制交人工。
        const gating = uses.filter((u) => u.meta.policy !== "allow");
        // 生效的档位：目录与仍有约束的变量取最严的一档。
        const tier = effectiveTier(tierOf, gating);
        let d: ReturnType<typeof decide>;
        let summary: string;
        let full: string;
        let sudoNote = "";
        if (located) {
          // 文件类工具：按目标地址的归属目录判，规则与「记住」都落在那个目录上。
          const access: Access = WRITE_TOOLS.has(e.toolName) ? "write" : "read";
          const selectors = selectorsOf(e.toolName, input);
          summary = clip(located.shown);
          full = located.shown;
          const j = await judgeTarget(access, located, policy, {
            selectors,
            scanTree:
              (e.toolName === "grep" || e.toolName === "find") &&
              selectors.length === 0,
            ...(deps.collab ? { collabAllows: deps.collab.allows } : {}),
          });
          if (j.d.verdict === "deny") {
            note(
              "system",
              "deny",
              "rule",
              e.toolName,
              summary,
              j.d.reason,
              located.ctx.where.env.id,
            );
            return { block: true, reason: j.d.reason };
          }
          d = j.d;
        } else if (cmd) {
          // 命令类工具：按命令实际所在的目录判（bash 的 host 只选目录），规则与「记住」都落在那个目录上。
          const ctx = cmd.ctx;
          const r = await classifyCommand(input, ctx.where, {
            usesVars: gating.length > 0,
            rootShell,
          });
          summary = r.summary;
          full = r.full;
          d = decide(r.action, {
            tier,
            cwd: ctx.where.cwd,
            pathRules: ctx.rules.path,
            commandRules: ctx.rules.command,
            pm: pathOf(ctx.where.env),
            ...(policy ? { policy } : {}),
          });
        } else {
          // 未知工具（自定义/MCP）视为规则外，不可记住；无能力信息，auto 档也只交人工。
          summary = clip(JSON.stringify(input));
          full = JSON.stringify(input);
          d = { verdict: "ask", remember: null, reviewable: false };
        }
        // 超出适用范围的变量用法、以及策略为 ask 的变量，一律交人工，已记住的规则也不放行。
        if (problems.length > 0 || uses.some((u) => u.meta.policy === "ask"))
          d = { verdict: "ask", remember: null, reviewable: false };
        if (d.verdict === "allow" && !sudoUsed) return;

        // 需要密码却没按范围提供 sudo 变量：不弹窗，直接告诉模型怎么写（ADR-0054）。
        const supplied = uses.some(
          (u) => u.meta.scopeKind === "sudo" && !u.problem,
        );
        if (cmd && deps.sudo && !supplied && !rootShell) {
          const state = await probeCommandLine(
            probeOf(deps.sudo, cmd.ctx),
            line,
            cmd.ctx.where.cwd,
          );
          if (state === "password") {
            const names = (deps.variables?.() ?? [])
              .filter((v) => v.scopeKind === "sudo")
              .map((v) => `{{@${v.name}}}`);
            if (deps.unattended)
              note(
                "system",
                "deny",
                "unattended",
                e.toolName,
                clip(line),
                "sudo 需要密码",
                cmd.ctx.where.env.id,
              );
            return {
              block: true,
              reason: names.length
                ? `sudo 需要密码，这条命令没有提供。可用的 sudo 密码变量：${names.join("、")}。写成：printf '%s\\n' ${names[0]} | sudo -S -p '' <命令>`
                : "sudo 需要密码，但没有登记 sudo 范围的隐私变量。请让用户在设置里登记 sudo 密码，或为这条命令配置 NOPASSWD 免密。",
            };
          }
          if (state === "nopasswd") sudoNote = "sudo 免密可用（NOPASSWD）。";
        }
        if (d.verdict === "allow") {
          if (cmd) deps.sudo?.invalidate(cmd.ctx.where.env.id);
          return;
        }

        let downgrade = "";
        if (tier === "auto" && d.reviewable && deps.review) {
          const reviewInput = redact(e.toolName, input);
          // 审核方只看得到被截短的输入；命令超出就不让它凭前半段放行。
          if (
            isCommand &&
            JSON.stringify(reviewInput).length > REVIEW_INPUT_MAX
          ) {
            downgrade = "命令太长，自动审核看不全，交由你决定";
          } else {
            const v = await deps.review({
              tool: e.toolName,
              summary,
              input: reviewInput,
            });
            if (v.decision === "allow") {
              note(
                "system",
                "allow",
                "review",
                e.toolName,
                summary,
                undefined,
                envIdOf,
              );
              return;
            }
            if (v.decision === "deny") {
              note(
                "system",
                "deny",
                "review",
                e.toolName,
                summary,
                v.reason,
                envIdOf,
              );
              return { block: true, reason: `自动审核拒绝：${v.reason}` };
            }
            downgrade = `审核方拿不准，交由你决定${v.reason ? `（${v.reason}）` : ""}`;
          }
        }

        // 弹窗只写变量名与用途类说明，值从不进入这一层。显式点名了目录才写明这次在哪运行。
        const notes = [
          ...(downgrade ? [downgrade] : []),
          ...(cmd && host !== undefined
            ? [`运行位置：${cmd.ctx.ref}（${cmd.ctx.where.cwd}）`]
            : []),
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
        if (deps.unattended)
          return denyUnattended(
            e.toolName,
            summary,
            notes.length ? notes.join("；") : "超出规则范围，需要人工批准",
            envIdOf,
          );
        const options = [
          { id: "allow", label: "仅此次通过" },
          { id: "deny", label: "拒绝" },
          ...(d.remember ? [{ id: "remember", label: "通过并记住" }] : []),
        ];
        // 弹窗展示有上限：看不全的内容不让批准，免得用户批准了没看到的部分。
        if (full.length > DETAIL_STRING_MAX) {
          note(
            "system",
            "deny",
            "error",
            e.toolName,
            summary,
            "输入过长，无法完整展示",
            envIdOf,
          );
          return {
            block: true,
            reason: `输入超过 ${DETAIL_STRING_MAX} 个字符，无法完整展示给用户审批。请拆成多条较短的调用，或先把内容写成脚本文件再执行。`,
          };
        }
        const r = await deps.ask({
          source: "approval",
          input: "text",
          title: `允许执行 ${e.toolName}？`,
          body: notes.length ? `${notes.join("\n")}\n\n${summary}` : summary,
          options,
          detail: { tool: e.toolName, summary: full },
        });
        if (r.outcome === "timeout") {
          note(
            "system",
            "deny",
            "timeout",
            e.toolName,
            summary,
            undefined,
            envIdOf,
          );
          return { block: true, reason: "审批超时，已拒绝" };
        }
        if (r.outcome === "cancelled") {
          note(
            "system",
            "deny",
            "cancelled",
            e.toolName,
            summary,
            undefined,
            envIdOf,
          );
          return { block: true, reason: "审批已取消，已拒绝" };
        }
        // 「记住」落在目标目录上：命令记在它执行的那个目录，文件记在归属目录。
        const ruleCtx = cmd?.ctx ?? located?.ctx ?? null;
        if (r.optionId === "remember" && d.remember && ruleCtx) {
          ruleCtx.addRule(d.remember);
          note(
            "user",
            "remember",
            "user",
            e.toolName,
            summary,
            undefined,
            envIdOf,
          );
        } else if (r.optionId === "allow") {
          note(
            "user",
            "allow",
            "user",
            e.toolName,
            summary,
            undefined,
            envIdOf,
          );
        } else {
          note("user", "deny", "user", e.toolName, summary, undefined, envIdOf);
          return {
            block: true,
            reason: withUserNote("用户拒绝了该操作", r),
          };
        }
        // 批准的 sudo 命令可能改了 sudoers：丢掉那个环境的探测缓存。
        if (cmd && deps.sudo && (await mentionsSudo(line)))
          deps.sudo.invalidate(cmd.ctx.where.env.id);
      } catch {
        note("system", "deny", "error", e.toolName, "");
        return { block: true, reason: "权限检查出错，已拒绝" };
      }
    };
    pi.on("tool_call", async (e) => {
      const ref = {
        uses: [] as { meta: VariableMeta }[],
        done: false,
        line: "",
        at: null as { directoryId: string; hostId: string } | null,
      };
      const res = await gate(e, ref);
      // 放行 = ok；被拦（拒绝、超时、取消、审核否决等）= dropped。过期与策略禁止已在 gate 内记过。
      const at = ref.at;
      if (!ref.done && at)
        for (const u of ref.uses)
          recordRef(
            e.toolCallId,
            u.meta.name,
            res?.block ? "dropped" : "ok",
            ref.line,
            at,
          );
      return res;
    });
  };
}
