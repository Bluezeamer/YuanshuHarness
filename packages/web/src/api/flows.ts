import { type CallResult, call, enc } from "./http";

// 对话标签右侧状态的数据：执行体清单（flows）与会话此刻看得见的东西（context）。
// 形状对应服务端 api/flows.ts 与 session/context.ts。

export interface FlowLogItem {
  kind: "tool" | "note";
  name?: string;
  text: string;
}

export interface ExecutionBody {
  /** 子会话 id；子代理就是会话池里的普通会话 */
  id: string;
  parentId: string;
  depth: number;
  /** 模型自己派发的 / 团队成员 / 动态工作流里的 agent；子代理树只放 task */
  source: "task" | "team" | "workflow";
  /** 团队成员的名字 */
  member: string | null;
  /** 工作流 agent 所属的运行（工作流任务 id）与阶段 */
  run: { id: string; phase: string | null } | null;
  name: string;
  /** agent 名 */
  role: string;
  model: string | null;
  /** 在跑 / 已落终态 / 登记为运行中但此刻没有在执行 */
  state: "run" | "done" | "idle";
  outcome: "ok" | "failed" | "interrupted" | null;
  result: string | null;
  ctx: { used: number; win: number | null };
  tools: string[];
  /** 子会话创建时间（ISO） */
  since: string;
  /** 落终态的时间（ISO）；还在跑为 null */
  ended: string | null;
  task: string;
  log: FlowLogItem[];
}

/** 一次工作流运行里一个阶段的 agent 个数；引擎事前数不出总数，所以只有已发生的和正在排队的 */
export interface WorkflowPhase {
  /** 脚本没调 phase() 为 null */
  name: string | null;
  run: number;
  done: number;
  failed: number;
  /** 已调用 agent()、还在等名额的个数 */
  queued: number;
}

export interface WorkflowRun {
  /** 工作流任务 id */
  id: string;
  label: string;
  state: "run" | "ok" | "failed" | "stopped" | "interrupted";
  since: string;
  /** 结束时间（ISO）；还在跑为 null */
  ended: string | null;
  /** 按阶段第一次出现的先后 */
  phases: WorkflowPhase[];
  /** 已启动的 agent 数（不含排队的）与单次运行的上限 */
  started: number;
  limit: number;
}

export interface Flows {
  executions: ExecutionBody[];
  workflow: WorkflowRun[];
}

export const getFlows = (
  token: string | null,
  sessionId: string,
): Promise<CallResult<Flows>> =>
  call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/flows`,
    token,
    undefined,
    (b: Partial<Flows>) => {
      if (!Array.isArray(b.executions) || !Array.isArray(b.workflow))
        throw new Error("shape");
      return { executions: b.executions, workflow: b.workflow };
    },
  );

export interface ContextFile {
  path: string;
  hostId: string;
  /** 估算 token */
  tokens: number;
  reads: number;
  /** 本会话改过 */
  modified: boolean;
  truncated?: true;
  lastAt: string;
}

export interface ContextSkill {
  name: string;
  source: "library" | "directory";
  /** 实际注入的 SKILL.md 路径；拿不到来源时为 null */
  path: string | null;
  loadedAt: string;
}

export interface ContextMcp {
  name: string;
  /** connecting：连接是后台建的，还没有结果；pending：这个会话开着的时候才登记的，下一条消息或重载时才会连 */
  state: "ready" | "connecting" | "pending" | "failed" | "disabled";
  tools: number;
  error?: string;
  /** 全局：每个会话都带上 */
  global: boolean;
  transport: "stdio" | "http";
  /** 运行位置：http 是「Server」，stdio 是逻辑 local 目录所在的主机；会话没在内存里时不给 */
  where?: string;
}

export interface SessionContext {
  files: ContextFile[];
  filesTruncated?: true;
  skills: ContextSkill[];
  mcp: ContextMcp[];
}

// 重载会话的 MCP 与环境（用户在主机上装好依赖之后）；会话运行中是 conflict。连接结果之后看 context。
export const reloadSession = (
  token: string | null,
  sessionId: string,
): Promise<CallResult<undefined>> =>
  call(
    "POST",
    `/api/v1/sessions/${enc(sessionId)}/reload`,
    token,
    undefined,
    () => undefined,
  );

export const getSessionContext = (
  token: string | null,
  sessionId: string,
): Promise<CallResult<SessionContext>> =>
  call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/context`,
    token,
    undefined,
    (b: Partial<SessionContext>) => {
      if (!Array.isArray(b.files)) throw new Error("shape");
      return {
        files: b.files,
        ...(b.filesTruncated ? { filesTruncated: true as const } : {}),
        skills: Array.isArray(b.skills) ? b.skills : [],
        mcp: Array.isArray(b.mcp) ? b.mcp : [],
      };
    },
  );
