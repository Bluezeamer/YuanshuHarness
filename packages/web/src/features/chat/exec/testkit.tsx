// 执行体与右侧状态测试的共用装置（只被 *.test.tsx 引用，不进产物）：数据夹具与 fetch 接线。
import { vi } from "vitest";
import type {
  ExecutionBody,
  Flows,
  SessionContext,
  WorkflowPhase,
  WorkflowRun,
} from "../../../api/flows";
import type { JobInfo } from "../../../api/jobs";
import type { TeamView } from "../../../api/team";
import { installChatApi, msgs } from "../../../test/chatFakes";

export const jobInfo = (over: Partial<JobInfo> = {}): JobInfo => ({
  id: "j1",
  sessionId: "s1",
  kind: "command",
  name: "bash",
  label: "npm run dev",
  ref: null,
  state: "running",
  exitCode: null,
  remindMs: 0,
  input: "npm run dev -- --port 5173",
  startedAt: new Date(Date.now() - 65_000).toISOString(),
  endedAt: null,
  ...over,
});

export const exec = (over: Partial<ExecutionBody> = {}): ExecutionBody => ({
  id: "x1",
  parentId: "s1",
  depth: 1,
  source: "task",
  member: null,
  run: null,
  name: "回归审阅",
  role: "代码审查",
  model: "Claude Opus 4.8",
  state: "run",
  outcome: null,
  result: null,
  ctx: { used: 38_000, win: 200_000 },
  tools: ["grep", "read_file"],
  since: new Date(Date.now() - 125_000).toISOString(),
  ended: null,
  task: "核对重复投递",
  log: [],
  ...over,
});

export const phase = (over: Partial<WorkflowPhase> = {}): WorkflowPhase => ({
  name: "查",
  run: 0,
  done: 0,
  failed: 0,
  queued: 0,
  ...over,
});

export const wfRun = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "r1",
  label: "代码审查",
  state: "run",
  since: new Date(Date.now() - 60_000).toISOString(),
  ended: null,
  phases: [phase({ run: 1 })],
  started: 1,
  limit: 1000,
  ...over,
});

export const FLOWS: Flows = {
  executions: [
    exec(),
    exec({
      id: "x2",
      name: "能力审计",
      role: "调研助理",
      state: "done",
      outcome: "ok",
      ctx: { used: 142_000, win: 200_000 },
      tools: ["read_file"],
    }),
    exec({
      id: "x3",
      name: "前端实现",
      role: "编码",
      state: "idle",
      ctx: { used: 0, win: 128_000 },
      tools: [],
    }),
  ],
  workflow: [],
};

export const CONTEXT: SessionContext = {
  files: [],
  skills: [
    {
      name: "review",
      source: "library",
      path: "/skills/review/SKILL.md",
      loadedAt: "t",
    },
    { name: "deploy", source: "directory", path: null, loadedAt: "t" },
  ],
  mcp: [
    {
      name: "github",
      state: "ready",
      tools: 3,
      global: true,
      transport: "http",
    },
    {
      name: "postgres",
      state: "failed",
      tools: 0,
      error: "连接被拒 · 127.0.0.1:5432",
      global: false,
      transport: "stdio",
    },
  ],
};

export interface Server {
  team: TeamView | number;
  flows: Flows | number;
  context: SessionContext | number;
  jobs: JobInfo[];
  hits: string[];
  count(suffix: string): number;
}

// 在 installChatApi 的 fetch 外再包一层：flows / context 走夹具，其余（历史、用量）仍走它。
export function installFlowsApi(over: Partial<Server> = {}): Server {
  installChatApi(msgs(0, 1));
  const base = globalThis.fetch;
  const server: Server = {
    flows: FLOWS,
    team: { board: { file: "/c/b.md", count: 0, recent: [] }, changes: null },
    context: CONTEXT,
    jobs: [],
    hits: [],
    count: (s) => server.hits.filter((h) => h.endsWith(s)).length,
    ...over,
  };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const reply = (v: object | number) =>
      typeof v === "number"
        ? new Response("{}", { status: v })
        : new Response(JSON.stringify(v), { status: 200 });
    if (input.endsWith("/flows")) {
      server.hits.push(input);
      return reply(server.flows);
    }
    if (input.endsWith("/team")) {
      server.hits.push(input);
      return reply(server.team);
    }
    if (input.endsWith("/context")) {
      server.hits.push(input);
      return reply(server.context);
    }
    if (input.endsWith("/jobs")) {
      server.hits.push(input);
      return reply({ jobs: server.jobs });
    }
    if (input.endsWith("/stop") && init?.method === "POST") {
      server.hits.push(input);
      return reply({ job: null, stopped: [] });
    }
    return base(input, init);
  });
  return server;
}
