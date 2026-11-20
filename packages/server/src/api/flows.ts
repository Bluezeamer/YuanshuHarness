import type { FastifyInstance } from "fastify";
import type { JobManager } from "../job/manager.js";
import type { SessionPool } from "../session/pool.js";
import type { CallStore } from "../store/calls.js";
import type { ChatEntry } from "../store/history.js";
import type { PromptPresetStore } from "../store/prompt-presets.js";
import type { SubagentRow, SubagentStore } from "../store/subagents.js";
import type { TeamStore } from "../store/teams.js";
import { WORKFLOW_LIMITS } from "../workflow/runtime.js";

// 日志文本、结论摘要的截断长度与日志条数上限。
const TEXT_MAX = 200;
const LOG_MAX = 50;

export interface FlowLogItem {
  kind: "tool" | "note";
  name?: string;
  text: string;
}

// 右栏「执行体」的一行：都是子代理会话，按来源分三种。
export interface ExecutionBody {
  // 子会话 id；点行即在窗格里开这个会话。
  id: string;
  // 派发它的会话（可能是根，也可能是另一个子代理）与深度（根的直接子为 1）。
  parentId: string;
  depth: number;
  // 来源：模型自己派发的 / 团队成员 / 动态工作流里的 agent。子代理树只放 task，另两种有各自的块。
  source: "task" | "team" | "workflow";
  // 团队成员的名字；其他来源为 null。
  member: string | null;
  // 工作流 agent 所属的运行（工作流任务 id）与阶段；其他来源为 null。
  run: { id: string; phase: string | null } | null;
  name: string;
  // agent 名。
  role: string;
  model: string | null;
  // 子会话在跑 / 已落终态 / 登记为运行中但此刻没有在执行。
  state: "run" | "done" | "idle";
  // 终态的结局；还在跑为 null。
  outcome: "ok" | "failed" | "interrupted" | null;
  // 终态的结论或失败原因（截断）；完整内容在子会话历史里。
  result: string | null;
  ctx: { used: number; win: number | null };
  tools: string[];
  since: string;
  // 落终态的时间；还在跑为 null。右栏据此把结束够久的子代理折起来。
  ended: string | null;
  task: string;
  log: FlowLogItem[];
}

// 一次工作流运行里一个阶段的 agent 个数。引擎事前数不出总数，所以只有已发生的和正在排队的。
export interface WorkflowPhase {
  // 没有阶段（脚本没调 phase()）为 null。
  name: string | null;
  run: number;
  done: number;
  failed: number;
  // 已调用 agent()、还在等名额的个数；只有运行期间有。
  queued: number;
}

export interface WorkflowRun {
  // 工作流任务 id。
  id: string;
  label: string;
  state: "run" | "ok" | "failed" | "stopped" | "interrupted";
  since: string;
  ended: string | null;
  // 按阶段第一次出现的先后。
  phases: WorkflowPhase[];
  // 已启动的 agent 数（不含排队的），与单次运行的上限。
  started: number;
  limit: number;
}

export interface Flows {
  executions: ExecutionBody[];
  // 这棵子树里出现过 agent 的工作流运行；没有为空数组。
  workflow: WorkflowRun[];
}

type FlowsDeps = {
  pool: SessionPool;
  subagents: SubagentStore;
  calls: CallStore;
  presets: Pick<PromptPresetStore, "get">;
  jobs: Pick<JobManager, "get">;
  teams: Pick<TeamStore, "member">;
  // 一次运行里各阶段排队的 agent 个数（阶段缺省是空串）；运行已结束为 undefined。
  queued(runId: string): ReadonlyMap<string, number> | undefined;
};

const clip = (s: string, n = TEXT_MAX) =>
  s.length > n ? `${s.slice(0, n)}…` : s;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// 工具调用参数是 JSON：取第一个字符串值（路径、命令、查询之类）当摘要，解析不了就用原文。
function briefArgs(args: string): string {
  try {
    const v: unknown = JSON.parse(args);
    if (v && typeof v === "object") {
      const s = Object.values(v).find((x) => typeof x === "string");
      if (typeof s === "string") return s;
    }
  } catch {
    // 参数被截断时不是合法 JSON，用原文
  }
  return args;
}

// 日志：助手的工具调用与文字，按时间取最近 LOG_MAX 条，每条文本截断。
export function logOf(history: ChatEntry[]): FlowLogItem[] {
  const log: FlowLogItem[] = [];
  for (const m of history) {
    if (m.role !== "assistant") continue;
    for (const b of m.blocks ?? [{ type: "text" as const, text: m.text }]) {
      if (b.type === "tool")
        log.push({
          kind: "tool",
          name: b.name,
          text: clip(oneLine(briefArgs(b.args))),
        });
      else if (b.type === "text" && b.text.trim() !== "")
        log.push({ kind: "note", text: clip(oneLine(b.text)) });
    }
  }
  return log.slice(-LOG_MAX);
}

const OUTCOME = {
  done: "ok",
  failed: "failed",
  interrupted: "interrupted",
} as const;

const RUN_STATE = {
  running: "run",
  done: "ok",
  failed: "failed",
  stopped: "stopped",
  interrupted: "interrupted",
} as const;

// 按运行聚合工作流 agent：每个阶段「运行中 / 已完成 / 失败」，再加上还在排队的。
function workflowRuns(
  executions: readonly ExecutionBody[],
  deps: Pick<FlowsDeps, "jobs" | "queued">,
): WorkflowRun[] {
  const byRun = new Map<string, ExecutionBody[]>();
  for (const x of executions)
    if (x.run) byRun.set(x.run.id, [...(byRun.get(x.run.id) ?? []), x]);
  const runs: WorkflowRun[] = [];
  for (const [id, agents] of byRun) {
    const job = deps.jobs.get(id);
    if (!job) continue;
    const phases = new Map<string, WorkflowPhase>();
    const phase = (name: string | null) => {
      const key = name ?? "";
      let p = phases.get(key);
      if (!p) {
        p = { name, run: 0, done: 0, failed: 0, queued: 0 };
        phases.set(key, p);
      }
      return p;
    };
    for (const x of agents) {
      const p = phase(x.run?.phase ?? null);
      if (x.state !== "done") p.run++;
      else if (x.outcome === "ok") p.done++;
      else p.failed++;
    }
    for (const [name, n] of deps.queued(id) ?? [])
      phase(name === "" ? null : name).queued = n;
    runs.push({
      id,
      label: job.label,
      state: RUN_STATE[job.state],
      since: job.startedAt,
      ended: job.endedAt,
      phases: [...phases.values()],
      started: agents.length,
      limit: WORKFLOW_LIMITS.totalMax,
    });
  }
  return runs;
}

export function buildFlows(rootId: string, deps: FlowsDeps): Flows {
  const { pool, subagents, calls, presets, teams } = deps;
  const byParent = new Map<string, SubagentRow[]>();
  for (const r of subagents.list())
    byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);

  const body = (row: SubagentRow): ExecutionBody => {
    const entry = pool.get(row.childId);
    const rt = entry?.runtimeInfo();
    const last = calls.list(row.childId, { limit: 1 }).calls[0];
    const role =
      presets.get(row.spec.agentPresetId)?.name ?? row.spec.agentPresetId;
    let history: ChatEntry[] = [];
    try {
      history = pool.history(row.childId) ?? [];
    } catch {
      // 历史文件读不了：这一行只是没有日志，不影响清单
    }
    const member = teams.member(row.childId);
    return {
      id: row.childId,
      parentId: row.parentId,
      depth: row.depth,
      source: row.runId !== null ? "workflow" : member ? "team" : "task",
      member: member?.name ?? null,
      run: row.runId !== null ? { id: row.runId, phase: row.phase } : null,
      name: clip(oneLine(row.task), 40),
      role,
      model: last?.model ?? rt?.model ?? null,
      state: row.state === "running" ? (entry?.busy ? "run" : "idle") : "done",
      outcome: row.state === "running" ? null : OUTCOME[row.state],
      result: row.result === null ? null : clip(oneLine(row.result)),
      ctx: {
        // 口径同 /sessions/:id/usage 的 context.used：最近一次调用的整次占用。
        used: last
          ? last.tokens.system +
            last.tokens.tools +
            last.tokens.history +
            last.tokens.current +
            last.tokens.out
          : 0,
        win: last?.window ?? rt?.window ?? null,
      },
      tools: pool.enabledTools(row.childId),
      since: pool.info(row.childId)?.createdAt ?? row.createdAt,
      ended: row.finishedAt,
      task: row.task,
      log: logOf(history),
    };
  };

  // 整棵子树，先父后子。
  const executions: ExecutionBody[] = [];
  const walk = (id: string) => {
    for (const row of byParent.get(id) ?? []) {
      executions.push(body(row));
      walk(row.childId);
    }
  };
  walk(rootId);
  return { executions, workflow: workflowRuns(executions, deps) };
}

// 右栏运行态的数据源：该会话派发出的整棵子代理子树。变化通过 WS 的 flows.updated 提示重新拉取。
export async function flowsApi(
  app: FastifyInstance,
  opts: FlowsDeps,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/flows",
    async (req, reply) => {
      if (!opts.pool.info(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return buildFlows(req.params.id, opts);
    },
  );
}
