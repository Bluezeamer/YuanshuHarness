// 动态工作流运行时（workflow.md §3–§5）：脚本在沙箱里跑（sandbox.ts），每个 agent() 是一个子代理
// （沿用 subagent/ 的会话、权限、协作区、链式停止）。整次运行是一个任务：job_stop 停掉它，名下所有
// 子代理一并停；阻塞调用到提醒时间转后台，同 spawn_subagent。
import { z } from "zod";
import { blockOrDetach } from "../job/block.js";
import {
  clampRemindMs,
  type JobHandle,
  type JobManager,
} from "../job/manager.js";
import { duration } from "../job/messages.js";
import type { SubagentLimits } from "../store/defaults.js";
import type { SubagentStore } from "../store/subagents.js";
import type { CollabArea } from "../subagent/collab.js";
import { SUBAGENT_LIMITS } from "../subagent/limits.js";
import {
  type RoundResult,
  type SpawnCall,
  SubagentError,
  type SubagentRuntime,
  type ToolText,
} from "../subagent/runtime.js";
import { runScript, type SandboxHost, UsageError } from "./sandbox.js";

/** 信息直接给模型看。 */
export class WorkflowError extends Error {}

export const WORKFLOW_LIMITS = {
  /** 脚本源码字符上限 */
  scriptMax: 100_000,
  /** args 序列化后的字符上限 */
  argsMax: 1_000_000,
  /** 同时在跑的 agent() 缺省值 */
  concurrency: 10,
  /** concurrency 参数的上限，超过按它取 */
  concurrencyMax: 50,
  /** 单次运行启动的 agent() 总数，防跑飞的循环；超了整次运行失败 */
  totalMax: 1000,
  /** 结果超过这个字符数就落协作区文件，只回传路径与开头 */
  inlineResultMax: 20_000,
  previewChars: 1000,
} as const;

export interface RunInput {
  script: string;
  args?: unknown;
  concurrency?: number;
  label?: string;
}

export interface WorkflowDeps {
  rt: SubagentRuntime;
  jobs: JobManager;
  store: SubagentStore;
  collab: CollabArea;
  limits: () => SubagentLimits;
  /** 测试里缩小总数上限 */
  totalMax?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const AGENT_OPTIONS = new Set([
  "label",
  "phase",
  "schema",
  "agent",
  "model",
  "remind_after",
]);

interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: z.ZodType;
  agent?: string;
  model?: string;
}

// agent() 的选项：未知选项、类型不对、不支持的 schema 都是用错钩子，整个脚本失败。
function parseOpts(raw: Record<string, unknown>): {
  opts: AgentOpts;
  schemaText?: string;
} {
  for (const k of Object.keys(raw))
    if (!AGENT_OPTIONS.has(k))
      throw new UsageError(
        `agent(): unknown option "${k}". Options: ${[...AGENT_OPTIONS].join(", ")}.`,
      );
  const str = (k: string) => {
    const v = raw[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.trim() === "")
      throw new UsageError(
        `agent(): option "${k}" must be a non-empty string.`,
      );
    return v;
  };
  const opts: AgentOpts = {};
  const label = str("label");
  const phase = str("phase");
  const agent = str("agent");
  const model = str("model");
  if (label !== undefined) opts.label = label;
  if (phase !== undefined) opts.phase = phase;
  if (agent !== undefined) opts.agent = agent;
  if (model !== undefined) opts.model = model;
  // 阻塞的子代理在工作流里没有人需要被提醒；接受这个选项（文档里有）但不起作用
  if (
    raw.remind_after !== undefined &&
    (typeof raw.remind_after !== "number" || raw.remind_after < 0)
  )
    throw new UsageError(`agent(): option "remind_after" must be a number.`);
  if (raw.schema === undefined) return { opts };
  if (
    typeof raw.schema !== "object" ||
    raw.schema === null ||
    Array.isArray(raw.schema)
  )
    throw new UsageError(
      `agent(): option "schema" must be a JSON Schema object.`,
    );
  try {
    opts.schema = z.fromJSONSchema(raw.schema as never) as z.ZodType;
  } catch (e) {
    throw new UsageError(
      `agent(): unsupported schema (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  return { opts, schemaText: JSON.stringify(raw.schema) };
}

// 同时在跑的数量：满了排队，先来先到；排队时被中止就放弃
class Slots {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly size: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("stopped");
    if (this.active < this.size) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(go);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("stopped"));
      };
      const go = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.queue.push(go);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return () => this.release();
  }

  // 放出一个排队的时它顶替当前名额，计数不变
  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

const stillRunningText = (id: string, ranMs: number, remindMs: number) =>
  `The workflow is still running after ${duration(ranMs)}. It was NOT stopped: it continues in the background as job ${id}. You will be notified when it finishes, and every ${duration(remindMs)} while it runs. Don't poll: do other work that does not overlap with it, or end your turn. Options: job_list { "id": "${id}" } to see its log (phases and agent progress), job_stop to stop the whole run.`;

const abortedText = (id: string) =>
  `Your call was interrupted while waiting. The workflow was NOT stopped: it continues in the background as job ${id}, and you will be notified when it finishes.`;

export class WorkflowRuntime {
  // 正在排队等名额的 agent() 个数：运行号 → 阶段（没有阶段是空串）→ 个数。只在运行期间有。
  private readonly waiting = new Map<string, Map<string, number>>();

  constructor(private readonly deps: WorkflowDeps) {}

  /** 一次运行里各阶段排队等名额的 agent 个数；运行结束后没有 */
  queued(runId: string): ReadonlyMap<string, number> | undefined {
    return this.waiting.get(runId);
  }

  private wait(runId: string, phase: string, by: 1 | -1): void {
    const phases = this.waiting.get(runId);
    if (!phases) return;
    const n = (phases.get(phase) ?? 0) + by;
    if (n > 0) phases.set(phase, n);
    else phases.delete(phase);
  }

  async run(
    callerId: string,
    input: RunInput,
    call: SpawnCall,
  ): Promise<ToolText> {
    const { jobs } = this.deps;
    const script = input.script;
    if (script.trim() === "")
      throw new WorkflowError("script cannot be empty.");
    if (script.length > WORKFLOW_LIMITS.scriptMax)
      throw new WorkflowError(
        `script is longer than ${WORKFLOW_LIMITS.scriptMax} characters.`,
      );
    if (JSON.stringify(input.args ?? null).length > WORKFLOW_LIMITS.argsMax)
      throw new WorkflowError(
        `args is larger than ${WORKFLOW_LIMITS.argsMax} characters; put the data in a file and pass the path.`,
      );
    const lim = this.deps.limits();
    const depth = (this.deps.store.get(callerId)?.depth ?? 0) + 1;
    if (depth > lim.maxDepth)
      throw new WorkflowError(
        `You are already at the maximum subagent depth (${lim.maxDepth}), so the agents of a workflow could not be started. Do the work yourself.`,
      );
    // 工作流的 agent 不占存活名额，并发只受自己的上限
    const concurrency = Math.min(
      input.concurrency ?? WORKFLOW_LIMITS.concurrency,
      WORKFLOW_LIMITS.concurrencyMax,
    );
    if (!(concurrency >= 1))
      throw new WorkflowError("concurrency must be a positive integer.");

    // 整次运行是一个任务：job_start 包着它时沿用那个任务，否则现登记一个
    const cur = jobs.current();
    const outer =
      cur && jobs.get(cur.id)?.name === "workflow_run" && !jobs.get(cur.id)?.ref
        ? cur
        : undefined;
    const remindMs = clampRemindMs(jobs.defaultRemindMs());
    const handle: JobHandle =
      outer ??
      jobs.register(callerId, {
        kind: "tool",
        name: "workflow_run",
        label: clip(oneLine(input.label ?? "workflow"), 60),
        remindMs,
      });
    if (!outer) handle.inline(true);

    const done = this.execute(callerId, handle, input, call, concurrency);
    if (outer) return done;
    return blockOrDetach({
      handle,
      done,
      remindMs,
      signal: call.signal,
      stillRunning: (ranMs) => stillRunningText(handle.id, ranMs, remindMs),
      interrupted: () => abortedText(handle.id),
    });
  }

  // 永不抛：出了意外也要结束任务并给出结果，否则阻塞的调用方会一直等
  private async execute(
    callerId: string,
    handle: JobHandle,
    input: RunInput,
    call: SpawnCall,
    concurrency: number,
  ): Promise<ToolText> {
    this.waiting.set(handle.id, new Map());
    try {
      return await this.drive(callerId, handle, input, call, concurrency);
    } catch (e) {
      const out: ToolText = {
        text: `Workflow failed: internal error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
      handle.end({ ok: false, text: out.text, callback: out.text });
      return out;
    } finally {
      this.waiting.delete(handle.id);
    }
  }

  private async drive(
    callerId: string,
    handle: JobHandle,
    input: RunInput,
    call: SpawnCall,
    concurrency: number,
  ): Promise<ToolText> {
    const { rt, jobs, store, collab } = this.deps;
    const totalMax = this.deps.totalMax ?? WORKFLOW_LIMITS.totalMax;
    const stop = new AbortController();
    // job_stop 停这次运行：脚本立刻结束，名下还在跑的子代理一并停
    const onStop = () => stop.abort();
    if (handle.signal.aborted) onStop();
    else handle.signal.addEventListener("abort", onStop, { once: true });

    const slots = new Slots(concurrency);
    const running = new Set<string>(); // 正在跑的子代理的任务 id
    let requested = 0; // agent() 被调用的次数：总数上限按它算，排队中的也算
    let launched = 0; // 真的启动了的子代理数：统计按它算
    let failed = 0;
    let phaseName = "";
    const write = (line: string) => handle.write(`${line}\n`);

    const stopChildren = async () => {
      await Promise.all(
        [...running].map((id) =>
          jobs.stop(callerId, id, "owner").catch(() => []),
        ),
      );
    };

    const host: SandboxHost = {
      phase: (title) => {
        phaseName = title;
        write(`== ${title}`);
      },
      log: (m) => write(`log: ${clip(oneLine(m), 500)}`),
      agent: async (prompt, raw) => {
        const { opts, schemaText } = parseOpts(raw);
        if (requested >= totalMax)
          throw new UsageError(
            `The run already started ${totalMax} agents, which is the limit for one run. Reduce the work or split it into several runs.`,
          );
        const n = ++requested;
        // 阶段按调用时算：排队期间脚本换了阶段，这个 agent 仍属于调用它的那一阶段
        const phase = opts.phase ?? phaseName;
        this.wait(handle.id, phase, 1);
        const release = await slots
          .acquire(stop.signal)
          .catch(() => null)
          .finally(() => this.wait(handle.id, phase, -1));
        if (release === null) return null;
        const label = opts.label ?? clip(oneLine(prompt), 50);
        const tag = `#${n}${phase ? ` [${phase}]` : ""}`;
        try {
          if (stop.signal.aborted) return null;
          write(`${tag} started: ${label}`);
          const task = schemaText
            ? `${prompt}\n\nDeliver your result with the deliver tool. Its summary must be ONE JSON document (and nothing else) that satisfies this JSON Schema:\n${schemaText}`
            : prompt;
          if (task.length > SUBAGENT_LIMITS.taskMax)
            throw new UsageError(
              `agent(): the prompt (with the schema, if any) is ${task.length} characters; the limit is ${SUBAGENT_LIMITS.taskMax}. Put the material in a file and pass its path.`,
            );
          let started: Awaited<ReturnType<SubagentRuntime["launch"]>>;
          try {
            started = await rt.launch(
              callerId,
              {
                task,
                ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
                ...(opts.model !== undefined ? { model: opts.model } : {}),
              },
              call,
              {
                kind: "workflow",
                label,
                runId: handle.id,
                phase: phase === "" ? null : phase,
              },
            );
          } catch (e) {
            // 不存在的 Agent / 模型之类是脚本写错了，整次运行失败；其余照常抛
            if (e instanceof SubagentError) throw new UsageError(e.message);
            throw e;
          }
          launched++;
          const jobId = started.handle.id;
          running.add(jobId);
          // 运行在这个子代理建好之前就被停了：补一刀
          if (stop.signal.aborted) await stopChildren();
          let r: RoundResult;
          try {
            r = await started.round.settled;
          } finally {
            running.delete(jobId);
          }
          const value = this.valueOf(r, opts.schema);
          if (value === null) {
            failed++;
            write(`${tag} failed: ${this.whyNot(r, opts.schema)}`);
          } else write(`${tag} done`);
          return value;
        } finally {
          release();
        }
      },
    };

    const result = await runScript(input.script, input.args ?? null, host, {
      signal: stop.signal,
    });
    handle.signal.removeEventListener("abort", onStop);
    stop.abort();
    await stopChildren();

    const stats = `agents: ${launched} started, ${failed} failed`;
    let out: ToolText;
    let stopped = false;
    if (result.ok) {
      const json = JSON.stringify(result.value);
      if (json.length <= WORKFLOW_LIMITS.inlineResultMax)
        out = { text: `Workflow finished (${stats}). Result:\n${json}` };
      else {
        const root = store.rootOf(callerId);
        const file = collab.writeOwn(root, handle.id, "result.json", json);
        out = {
          text: `Workflow finished (${stats}). The result is large (${file.bytes} bytes), so it was saved to host="collab", path="${collab.virtualPath(root, file.path)}"; read it with the read tool. Start of the result:\n${json.slice(0, WORKFLOW_LIMITS.previewChars)}…`,
        };
      }
    } else if (result.kind === "stopped") {
      stopped = true;
      out = {
        text: `The workflow was stopped (${stats}).`,
        isError: true,
      };
    } else {
      const head =
        result.kind === "usage"
          ? "Workflow failed: a workflow hook was used wrongly"
          : result.kind === "runtime"
            ? "Workflow failed: engine problem"
            : "Workflow failed";
      out = {
        text: `${head} (${stats}).\n${result.error}\nFix the script and run it again. Agents that already finished their work have left their changes behind.`,
        isError: true,
      };
    }
    write(out.text);
    // 回调给调用方的正文带框架标题，免得和普通用户消息混淆（后台运行时才用得上）
    const title = stopped ? "was stopped" : out.isError ? "failed" : "finished";
    handle.end({
      ok: !out.isError,
      text: out.text,
      callback: `[Workflow ${handle.id} ${title}]\n${out.text}`,
      ...(stopped ? { stopped: true } : {}),
    });
    return out;
  }

  // 一个 agent() 的返回值：交付的 summary（有报告时带上路径）；有 schema 则是校验后的对象；失败为 null
  private valueOf(r: RoundResult, schema: z.ZodType | undefined): unknown {
    if (r.kind !== "delivered") return null;
    if (schema) {
      try {
        const parsed = schema.safeParse(JSON.parse(r.summary));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    }
    return r.report
      ? `${r.summary}\n\nFull report file: ${r.report.path}`
      : r.summary;
  }

  private whyNot(r: RoundResult, schema: z.ZodType | undefined): string {
    switch (r.kind) {
      case "delivered":
        return schema ? "the delivery did not match the schema" : "";
      case "failed":
        return clip(oneLine(r.error), 200);
      case "stopped":
        return "stopped";
      case "undelivered":
        return "finished without delivering";
      case "unchanged":
        return "no delivery";
    }
  }
}
