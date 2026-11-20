// 子代理测试的公共装配：真实会话池 + stub 模型 + 后台任务 + 子代理运行时。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnChangeStore } from "../../src/changes/store.js";
import { ChangeTracker } from "../../src/changes/tracker.js";
import { JobManager } from "../../src/job/manager.js";
import { ensureBuiltinAgents } from "../../src/prompt/builtin-agents.js";
import { AttachmentDirectories } from "../../src/session/attachments.js";
import type { PoolDeps, SessionPool } from "../../src/session/pool.js";
import { SessionConfigService } from "../../src/session/session-config.js";
import type { SubagentLimits } from "../../src/store/defaults.js";
import { JobStore } from "../../src/store/jobs.js";
import { SessionConfigStore } from "../../src/store/session-configs.js";
import { SubagentStore } from "../../src/store/subagents.js";
import { TeamStore } from "../../src/store/teams.js";
import { CollabArea } from "../../src/subagent/collab.js";
import { type SpawnCall, SubagentRuntime } from "../../src/subagent/runtime.js";
import { withTools } from "../../src/subagent/tools.js";
import { memberHooks, TeamRuntime } from "../../src/team/runtime.js";
import { teamExtension } from "../../src/team/tools.js";
import { membersIdle } from "../../src/team/view.js";
import { NamedWorkflows } from "../../src/workflow/named.js";
import { WorkflowRuntime } from "../../src/workflow/runtime.js";
import { workflowExtension } from "../../src/workflow/tools.js";
import { stubSessionFactory, testData, testPool, testPresets } from "./stub.js";

export const BRIEF = "You are a subagent dispatched by another agent session";

export const textOf = (c: unknown): string =>
  typeof c === "string" ? c : JSON.stringify(c);
export type Msg = { role: string; content?: unknown };

/** 请求是不是来自子代理：它的第一条 user 消息带开场说明。 */
export const isChild = (body: Record<string, unknown>) =>
  ((body.messages ?? []) as Msg[]).some(
    (m) => m.role === "user" && textOf(m.content).includes(BRIEF),
  );

export const MEMBER_BRIEF = "You are a member of a team of agents";

/** 请求来自哪个团队成员：开场消息末尾写着 You are "名字"；不是成员返回 null。 */
export function memberOf(body: Record<string, unknown>): string | null {
  for (const m of (body.messages ?? []) as Msg[]) {
    const t = m.role === "user" ? textOf(m.content) : "";
    if (!t.includes(MEMBER_BRIEF)) continue;
    // textOf 对分段内容会做 JSON 序列化，引号可能被转义成 \"
    return /You are \\?"([^"\\]+)\\?"\./.exec(t)?.[1] ?? null;
  }
  return null;
}

export function subagentWorld(
  stub: { url: string },
  o: {
    builtinTools?: boolean;
    limits?: SubagentLimits;
    remindMs?: number;
    // 要额外挂进会话池的依赖（需要用到世界里的库时用函数形式）
    deps?: (data: ReturnType<typeof testData>) => Partial<PoolDeps>;
    // 团队板子摘要用的辅助调用；缺省时 team_status 附最近的原文
    summarize?: (leadId: string, board: string) => Promise<string>;
    // 开启改动追踪（会话轮次与团队整体）；team_diff 需要它
    tracker?: boolean;
    // 缩小一次工作流运行的 agent 总数上限
    workflowTotalMax?: number;
    // 命名流程的全局层目录；缺省在测试数据目录里
    workflows?: { globalDir: string };
    // 辅助模型（页面阅读 agent 用）；缺省没配
    auxModel?: () => { provider: string; model: string } | null;
  } = {},
) {
  const data = testData();
  const p = testPresets(data);
  // 页面阅读 agent 用内置预设：开了辅助模型时一并写进库
  if (o.auxModel) ensureBuiltinAgents({ cards: p.cards, presets: p.presets });
  // 附件区（隐藏 directory，按工作区一块，属主要问池）：页面阅读子代理的 directory 就是它。
  // 池在下面才建，所以用惰性闭包，与 server.ts 的接线一致。
  const attachments = new AttachmentDirectories(
    data.directories,
    data.dir,
    (sessionId) => pool?.workspaceIdOf(sessionId) ?? sessionId,
  );
  const subagents = new SubagentStore(data.db);
  // 会话配置；这里不碰模型解析，给个永远找不到的占位
  const configs = new SessionConfigService({
    store: new SessionConfigStore(data.db),
    defaults: data.defaults,
    resolver: { has: () => false } as never,
  });
  let pool: SessionPool | undefined;
  const jobs = new JobManager({
    store: new JobStore(data.db),
    dir: join(data.dir, "jobs"),
    notify: (id, text, job) =>
      pool?.get(id)?.notify(text, "steer", job) ?? false,
    remindMs: () => o.remindMs ?? 600_000,
  });
  // 让下一个新建的会话在开始运行之前就发送失败（模拟没有模型 / 缺密钥）
  const hooks = { failNext: null as string | null };
  const base = stubSessionFactory(stub, {}, o.builtinTools ?? false);
  const factory: typeof base = async (opts) => {
    const session = await base(opts);
    if (hooks.failNext !== null) {
      const message = hooks.failNext;
      hooks.failNext = null;
      (session as unknown as { prompt: () => Promise<never> }).prompt =
        async () => {
          throw new Error(message);
        };
    }
    return session;
  };
  // 协作区放在工作目录之外（真实部署里它在数据目录下、项目之外），否则文件工具按「cwd 内」放行，测不出内置放行。
  const collabBase = mkdtempSync(join(tmpdir(), "yuanshu-collab-w-"));
  const teams = new TeamStore(data.db);
  const collab = new CollabArea(join(collabBase, "collab"), (root) =>
    membersIdle(teams, subagents, root),
  );
  const tracker = o.tracker
    ? new ChangeTracker({ dir: join(collabBase, "turn-changes") })
    : undefined;
  const t = testPool(factory, data, {
    presetView: p.view,
    ...(tracker ? { tracker, changes: new TurnChangeStore(data.db) } : {}),
    subagents,
    teams,
    configs,
    jobs,
    collab,
    attachments,
    agentDefs: () =>
      p.presets
        .list("agent")
        .map((a) => ({ name: a.name, description: a.description })),
    ...o.deps?.(data),
  });
  pool = t.pool;
  const rt = new SubagentRuntime({
    pool: t.pool,
    store: subagents,
    jobs,
    directories: data.directories,
    presets: p.presets,
    hasModel: () => true,
    auxModel: o.auxModel ?? (() => null),
    limits: () => o.limits ?? data.defaults.subagentLimits(),
    collab,
    members: memberHooks(teams, collab),
  });
  const teamRt = new TeamRuntime({
    pool: t.pool,
    rt,
    teams,
    subagents,
    jobs,
    collab,
    ...(o.summarize ? { summarize: o.summarize } : {}),
    ...(tracker
      ? {
          changes: {
            tracker,
            context: (id: string) => t.pool.directoryContext(id),
          },
        }
      : {}),
  });
  const workflowRt = new WorkflowRuntime({
    rt,
    jobs,
    store: subagents,
    collab,
    limits: () => o.limits ?? data.defaults.subagentLimits(),
    ...(o.workflowTotalMax ? { totalMax: o.workflowTotalMax } : {}),
  });
  // 命名流程：全局层放在测试数据目录里，项目层随会话当前 directory。
  const globalDir = o.workflows?.globalDir ?? join(data.dir, "ys", "workflows");
  const named = new NamedWorkflows({
    globalDir,
    project: (id) => {
      const ctx = t.pool.directoryContext(t.pool.info(id)?.directoryId ?? "");
      return ctx ? { env: ctx.env, path: ctx.root } : null;
    },
  });
  t.pool.attachNamedWorkflows(named);
  t.pool.attachSubagents(
    withTools(
      withTools(rt.hooks(), (id) => teamExtension(teamRt, id)),
      (id) => workflowExtension(workflowRt, named, id),
    ),
  );
  return {
    pool: t.pool,
    data,
    attachments,
    teams,
    teamRt,
    workflowRt,
    named,
    presets: p.presets,
    view: p.view,
    coder: p.coder,
    reviewer: p.reviewer,
    subagents,
    jobs,
    rt,
    collab,
    hooks,
    async close() {
      // 先中止所有任务，等子代理的停止收尾（它们还要读写库），再关库
      jobs.shutdown();
      await new Promise((r) => setTimeout(r, 100));
      t.pool.dispose();
      data.close(true);
      rmSync(collabBase, { recursive: true, force: true });
    },
  };
}

export type World = ReturnType<typeof subagentWorld>;

const CALL: SpawnCall = { toolCallId: "call_t", signal: undefined, branch: [] };

/** 派发一个子代理但不等它：等子会话登记进来后返回它的 id（阻塞的结果由调用方自己处理）。 */
export async function spawnChild(
  w: World,
  parentId: string,
  input: Parameters<SubagentRuntime["spawn"]>[1],
  call: Partial<SpawnCall> = {},
): Promise<{ childId: string; done: ReturnType<SubagentRuntime["spawn"]> }> {
  const before = new Set(w.subagents.children(parentId).map((r) => r.childId));
  const done = w.rt.spawn(parentId, input, { ...CALL, ...call });
  done.catch(() => {});
  for (let i = 0; i < 400; i++) {
    const row = w.subagents
      .children(parentId)
      .find((r) => !before.has(r.childId));
    if (row) return { childId: row.childId, done };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("子会话没有登记");
}
