import { isObject } from "../lib/validate.js";
import { Masker, type MaskVar } from "../permission/masking.js";
import type { AuditLog } from "../store/audit.js";
import type { Directory } from "../store/directories.js";
import { LOCAL_ENV_ID } from "../store/environments.js";
import type { Hook, HookStore } from "../store/hooks.js";
import { hookEnv, runCommand } from "./exec.js";
import { matches, type PointId, type PointInfo, pointInfo } from "./points.js";

// hook 运行时（ADR-0085、ADR-0086）：选出命中的 hook、遮罩载荷、执行、解释退出码与 stdout、写审计。

/** 一次触发所在的会话上下文，由会话池提供。 */
export interface HookCtx {
  sessionId: string;
  directoryId: string;
  /** 载荷里的 cwd（directory 路径，可能是远程路径）。 */
  cwd: string;
  /** 子进程实际的工作目录：directory 在本机时同 cwd，否则是 Server 的 cwd。 */
  execCwd: string;
  environmentId: string;
}

/** directory 在本机时 hook 在该目录里跑；远程 directory 的路径在宿主机上不存在，退回 Server 的 cwd。 */
export const hookCtx = (ws: Directory, sessionId: string): HookCtx => ({
  sessionId,
  directoryId: ws.id,
  cwd: ws.path,
  execCwd: ws.environmentId === LOCAL_ENV_ID ? ws.path : process.cwd(),
  environmentId: ws.environmentId,
});

export type HookResult = "ok" | "blocked" | "feedback" | "error" | "timeout";

/** 一批 hook 合起来的效果。 */
export interface HookOutcome {
  /** 非 null = 阻断，值是给模型 / 用户看的原因（已遮罩）。 */
  blocked: string | null;
  /** 追加给模型的上下文（已遮罩）。 */
  context: string[];
  /** PostToolUse 的反馈（已遮罩）。 */
  feedback: string[];
  /** PreToolUse 改写后的完整输入（已遮罩）；null = 不改。 */
  updatedInput: Record<string, unknown> | null;
}

export const emptyOutcome = (): HookOutcome => ({
  blocked: null,
  context: [],
  feedback: [],
  updatedInput: null,
});

/** 单个 hook 执行的明细；试跑接口原样返回。 */
export interface HookRun {
  hookId: string;
  hookName: string;
  result: HookResult;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** 解释后的效果（已遮罩）。 */
  reason?: string;
  context?: string;
  updatedInput?: Record<string, unknown>;
  error?: string;
}

export interface HookRuntimeDeps {
  store: HookStore;
  audit?: AuditLog;
  /** 每次触发即时读取，改了隐私变量立刻生效。 */
  variables: () => readonly MaskVar[];
}

const parseJsonObject = (text: string): Record<string, unknown> | null => {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
};

const clip = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}…` : s;

export class HookRuntime {
  constructor(private readonly deps: HookRuntimeDeps) {}

  /**
   * 触发一个点位。没有命中的 hook 时立即返回空效果；
   * 同一点位按创建顺序串行执行，阻断即停，updatedInput 逐个叠加。
   */
  async fire(
    point: PointId,
    ctx: HookCtx,
    data: Record<string, unknown>,
  ): Promise<HookOutcome> {
    const out = emptyOutcome();
    const info = pointInfo(point);
    if (!info) return out;
    const target = info.matchField
      ? (data[info.matchField] as string | undefined)
      : undefined;
    const hooks = this.deps.store
      .forPoint(point, ctx.directoryId)
      .filter((h) => matches(h.matcher, target));
    if (hooks.length === 0) return out;
    const masker = Masker.of(this.deps.variables());
    let current = data;
    for (const hook of hooks) {
      const run = await this.execute(hook, info, ctx, current, masker, false);
      if (run.result === "blocked") {
        out.blocked = `hook「${hook.name}」阻止了该操作：${run.reason ?? ""}`;
        break;
      }
      if (run.result === "feedback" && run.reason)
        out.feedback.push(`${hook.name}：${run.reason}`);
      if (run.context) out.context.push(run.context);
      if (run.updatedInput) {
        out.updatedInput = run.updatedInput;
        // 后面的 hook 看到的是改写后的输入。
        current = { ...current, tool_input: run.updatedInput };
      }
    }
    return out;
  }

  /** 试跑：不看 matcher、不看启用状态，用给定（或样例）载荷执行一次；照常写审计，带 test 标记。 */
  async test(
    hook: Hook,
    ctx: HookCtx,
    payload?: Record<string, unknown>,
  ): Promise<HookRun> {
    const info = pointInfo(hook.point);
    if (!info) throw new Error(`未知点位：${hook.point}`);
    return this.execute(
      hook,
      info,
      ctx,
      payload ?? info.sample,
      Masker.of(this.deps.variables()),
      true,
    );
  }

  private async execute(
    hook: Hook,
    info: PointInfo,
    ctx: HookCtx,
    data: Record<string, unknown>,
    masker: Masker,
    isTest: boolean,
  ): Promise<HookRun> {
    const payload = masker.maskDeep({
      hook_event_name: info.id,
      session_id: ctx.sessionId,
      directory_id: ctx.directoryId,
      cwd: ctx.cwd,
      ...data,
    });
    const exec = await runCommand({
      command: hook.command,
      stdin: JSON.stringify(payload),
      cwd: ctx.execCwd,
      env: hookEnv({
        YUANSHU_HOOK_EVENT: info.id,
        YUANSHU_SESSION_ID: ctx.sessionId,
        YUANSHU_PROJECT_DIR: ctx.cwd,
      }),
      timeoutMs: hook.timeoutSec * 1000,
    });
    const run = this.interpret(hook, info, exec, masker);
    this.deps.audit?.record({
      sessionId: ctx.sessionId === "" ? null : ctx.sessionId,
      actor: "system",
      kind: "hook",
      environmentId: ctx.environmentId,
      summary: `${info.id} ${hook.name}: ${run.result}`,
      detail: {
        op: info.id,
        target: hook.name,
        result: run.result,
        hookId: hook.id,
        point: info.id,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        ...(isTest ? { test: true } : {}),
        ...(run.reason ? { reason: run.reason } : {}),
        ...(run.error ? { error: run.error } : {}),
        ...(run.updatedInput ? { updated: true } : {}),
      },
    });
    return run;
  }

  // 退出码与 stdout 的解释（ADR-0085）。hook 自己的故障（无法启动、超时、非 0 非 2）一律放行，只记审计。
  private interpret(
    hook: Hook,
    info: PointInfo,
    exec: Awaited<ReturnType<typeof runCommand>>,
    masker: Masker,
  ): HookRun {
    const base = {
      hookId: hook.id,
      hookName: hook.name,
      exitCode: exec.exitCode,
      durationMs: exec.durationMs,
      stdout: masker.mask(exec.stdout),
      stderr: masker.mask(exec.stderr),
    };
    if (exec.timedOut)
      return {
        ...base,
        result: "timeout",
        error: `超过 ${hook.timeoutSec} 秒，已强制结束`,
      };
    if (exec.error) return { ...base, result: "error", error: exec.error };

    const json = exec.exitCode === 0 ? parseJsonObject(exec.stdout) : null;
    const m = (s: string) => clip(masker.mask(s), 4000);
    const textField = (k: string) =>
      typeof json?.[k] === "string" && json[k] !== ""
        ? (json[k] as string)
        : null;

    let want: "block" | null = null;
    let reason: string | null = null;
    if (exec.exitCode === 2) {
      want = "block";
      reason = exec.stderr.trim() || "hook 要求阻断（退出码 2，stderr 为空）";
    } else if (exec.exitCode === 0) {
      const d = json?.decision;
      if (d === "block" || d === "deny") {
        want = "block";
        reason = textField("reason") ?? "hook 要求阻断";
      }
    } else {
      return {
        ...base,
        result: "error",
        error: `退出码 ${String(exec.exitCode)}`,
      };
    }

    if (want === "block" && reason !== null) {
      if (info.blocking)
        return { ...base, result: "blocked", reason: m(reason) };
      if (info.id === "PostToolUse")
        return { ...base, result: "feedback", reason: m(reason) };
      return {
        ...base,
        result: "error",
        error: `${info.id} 不支持阻断，已忽略`,
      };
    }

    // 退出码 0：收集上下文与改写。
    let context: string | null = null;
    if (info.id === "PostToolUse" || info.id === "UserPromptSubmit") {
      context = textField("additionalContext");
      // UserPromptSubmit 的纯文本 stdout 也算上下文（Claude Code 习惯）。
      if (context === null && info.id === "UserPromptSubmit" && json === null) {
        const t = exec.stdout.trim();
        if (t !== "") context = t;
      }
    }
    const updated =
      info.id === "PreToolUse" && isObject(json?.updatedInput)
        ? masker.maskDeep(json.updatedInput as Record<string, unknown>)
        : null;
    return {
      ...base,
      result: "ok",
      ...(context !== null ? { context: m(context) } : {}),
      ...(updated ? { updatedInput: updated } : {}),
    };
  }
}
