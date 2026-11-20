// 对话标签的右侧状态：目标 / 计划 / 团队 / 工作流 / 子代理 / 后台任务 / 已加载能力，有内容才出现，没有就不占位。
// 对话窗格够宽时常驻（各块依次排开）；窄时收成一列竖排的文字标签，鼠标移到标签上向左展开那一块，
// 展开的整块区域（标签列 + 卡片）都算「在里面」，鼠标要完全离开才收起（X08）。
// 只读执行面，不是配置入口。子代理树只放模型自己派发的；团队成员与工作流的 agent 各有自己的块。

import { type ReactNode, useState } from "react";
import type { JobSnapshot } from "../../../api";
import { Dot, IconButton } from "../../../ui";
import type { TabAfx } from "../../workspace/model/types";
import {
  useFlows,
  useJobs,
  useSessionContext,
  useTeam,
} from "../exec/useFlows";
import type { ChatSession } from "../hooks";
import { CapsBody, GoalBody, PlanBody } from "./Blocks";
import { JobsBody } from "./JobsBody";
import { visibleJobs } from "./jobs";
import { SubToggle, SubTree, type SubUi } from "./SubTree";
import { anyLive, buildForest, statusOf } from "./subTree";
import { TeamBody } from "./TeamBody";
import { useGoalEditor } from "./useGoalEditor";
import { useNow } from "./useNow";
import { WorkflowBody } from "./WorkflowBody";
import { visibleRuns } from "./workflow";

/** 对话窗格宽度达到这个值，状态栏常驻；更窄收成竖排标签 */
export const WIDE_AT = 1000;

type Key = "goal" | "plan" | "team" | "flow" | "sub" | "job" | "cap";

interface Item {
  key: Key;
  title: string;
  /** 竖排标签前的小点：有东西在动才脉动 */
  live: boolean;
  aside?: ReactNode;
  body: ReactNode;
}

const Block = ({ it }: { it: Item }) => (
  <section className="ch-sec" data-block={it.key}>
    <div className="ch-sec-h">
      <span className="t-group">{it.title}</span>
      {it.aside}
    </div>
    {it.body}
  </section>
);

const toggled = (list: readonly string[] | undefined, id: string) => {
  const cur = list ?? [];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  return next.length > 0 ? next : undefined;
};

export function StatusPanel({
  sessionId,
  session,
  afx,
  patchAfx,
  width,
  onOpenExecution,
  onOpenJob,
  onOpenFile,
  onOpenTeamDiff,
}: {
  sessionId: string;
  session: ChatSession;
  afx: TabAfx | undefined;
  patchAfx(patch: Partial<TabAfx>): void;
  /** 对话标签容器（.ch-shell）的真实宽度 */
  width: number;
  onOpenExecution(id: string): void;
  /** 点后台任务：开任务标签 */
  onOpenJob(job: JobSnapshot): void;
  /** 打开 Server 本机上的文件（公告板）的预览标签 */
  onOpenFile(path: string): void;
  /** 打开团队建队以来某文件的对比标签 */
  onOpenTeamDiff(path: string): void;
}) {
  const { state, actions } = session;
  const flows = useFlows(sessionId, state.flowsRev);
  const context = useSessionContext(sessionId, state.contextRev);
  const [key, setKey] = useState<Key | null>(null);
  const editor = useGoalEditor(state.goal, actions);
  const jobs = useJobs(sessionId, state.jobsRev);

  const executions = flows.data?.executions ?? [];
  const forest = buildForest(executions, sessionId);
  const members = executions.filter((x) => x.source === "team");
  const team = useTeam(
    sessionId,
    state.flowsRev,
    members.length > 0,
    members.some((m) => statusOf(m) === "live"),
  );
  const allRuns = flows.data?.workflow ?? [];
  // 有结束的（「N 分钟前」与折叠要随时间变）或在跑的才走表
  const now = useNow(forest.length > 0 || allRuns.length > 0);
  const runs = visibleRuns(allRuns, now);
  // 后台任务：只列在跑的，每秒走一次表（已用时）；结束由 jobs.updated 触发重取后消失
  const shownJobs = visibleJobs(jobs.data ?? []);
  const jobNow = useNow(shownJobs.length > 0, 1000);
  const ui: SubUi = {
    all: afx?.subAll === true,
    setAll: (all) => patchAfx({ subAll: all ? true : undefined }),
    open: new Set(afx?.subOpen),
    toggleOpen: (id) => patchAfx({ subOpen: toggled(afx?.subOpen, id) }),
    seen: new Set(afx?.subSeen),
    markSeen: (id) => patchAfx({ subSeen: toggled(afx?.subSeen, id) }),
    now,
    onOpen: onOpenExecution,
  };

  const items: Item[] = [];
  const { goal, todos } = state;
  // 完成的目标不再占右栏（结果看对话流里的卡片）；暂停与受阻的在等人处理，一直显示
  if (goal && goal.state !== "complete")
    items.push({
      key: "goal",
      title: "目标",
      live: goal.state === "active" && state.running,
      body: (
        <GoalBody
          sessionId={sessionId}
          goal={goal}
          editor={editor}
          actions={actions}
        />
      ),
    });
  if (todos.length > 0) {
    const done = todos.filter((t) => t.status === "completed").length;
    items.push({
      key: "plan",
      title: "计划",
      live: todos.some((t) => t.status === "in_progress"),
      aside: (
        <span className="t-mono ch-dim">
          {done} / {todos.length}
        </span>
      ),
      body: <PlanBody todos={todos} />,
    });
  }
  if (members.length > 0)
    items.push({
      key: "team",
      title: "团队",
      live: members.some((m) => statusOf(m) === "live"),
      body: (
        <TeamBody
          members={members}
          team={team.data}
          onOpen={onOpenExecution}
          onOpenBoard={onOpenFile}
          onOpenDiff={onOpenTeamDiff}
        />
      ),
    });
  if (runs.length > 0)
    items.push({
      key: "flow",
      title: "工作流",
      live: runs.some((r) => r.state === "run"),
      body: <WorkflowBody runs={runs} now={now} />,
    });
  if (forest.length > 0)
    items.push({
      key: "sub",
      title: "子代理",
      live: anyLive(forest),
      aside: <SubToggle forest={forest} ui={ui} />,
      body: <SubTree forest={forest} rootLive={state.running} ui={ui} />,
    });
  if (shownJobs.length > 0)
    items.push({
      key: "job",
      title: "后台任务",
      live: true,
      body: (
        <JobsBody
          jobs={shownJobs}
          now={jobNow}
          onOpen={onOpenJob}
          onChanged={jobs.reload}
        />
      ),
    });
  const ctx = context.data;
  if (ctx && ctx.skills.length + ctx.mcp.length > 0)
    items.push({
      key: "cap",
      title: "已加载能力",
      live: false,
      body: <CapsBody ctx={ctx} />,
    });
  if (items.length === 0) return null;

  const label = "目标、计划、团队、工作流、子代理、后台任务与能力";
  if (width >= WIDE_AT)
    return (
      <aside className="ch-status" aria-label={label}>
        {items.map((it) => (
          <Block key={it.key} it={it} />
        ))}
      </aside>
    );

  // 正在编辑目标时卡片不能因为鼠标移开而收走
  const shown = items.find((it) => it.key === (editor.editing ? "goal" : key));
  return (
    <aside
      className="ch-rail"
      aria-label={label}
      onPointerLeave={() => setKey(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setKey(null);
      }}
    >
      {items.map((it) => (
        <IconButton
          key={it.key}
          className="ch-rail-tab"
          label={it.title}
          title={undefined}
          pressed={shown?.key === it.key}
          data-rail={it.key}
          onPointerEnter={() => setKey(it.key)}
          onFocus={() => setKey(it.key)}
          icon={
            <span className="ch-rail-in">
              <Dot
                size="sm"
                tone={it.live ? "live" : "idle"}
                motion={it.live ? "pulse" : undefined}
              />
              <span className="t-aux ch-rail-label">{it.title}</span>
            </span>
          }
        />
      ))}
      {shown && (
        <div className="ch-rail-pop">
          <div className="ch-rail-card">
            <Block it={shown} />
          </div>
        </div>
      )}
    </aside>
  );
}
