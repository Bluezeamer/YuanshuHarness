import type { Goal } from "../../../api";
import type { SessionContext } from "../../../api/flows";
import {
  Button,
  ConfirmButton,
  Dot,
  fmtDateTime,
  Input,
  ListRow,
  PeekCard,
} from "../../../ui";
import { CheckIcon } from "../../../ui/icons";
import { RichInput } from "../input/RichInput";
import type { Todo } from "../model/conversation";
import { GOAL_STATE_TEXT, reasonText, roundsText } from "../model/goal";
import { MessageAttachments } from "../tab/MessageAttachments";
import { MCP_STATE_TEXT, MCP_TONE } from "../tab/mcpModel";
import type { GoalActions, GoalEditor } from "./useGoalEditor";

// 状态点：完成是勾，当前是脉动的点，其余是静止的点
export const Tick = ({
  done,
  current,
}: {
  done?: boolean;
  current?: boolean;
}) =>
  done ? (
    <CheckIcon size={12} />
  ) : (
    <Dot
      size="sm"
      tone={current ? "live" : "idle"}
      motion={current ? "pulse" : undefined}
    />
  );

// 目标：正文 + 谁设的、状态与原因、已用轮数；暂停 / 继续（暂停与受阻的目标靠「继续」重新计数）、编辑（双击正文也行）、删除。
export function GoalBody({
  sessionId,
  goal,
  editor,
  actions,
}: {
  sessionId: string;
  goal: Goal;
  editor: GoalEditor;
  actions: GoalActions;
}) {
  const stopped = goal.state === "paused" || goal.state === "blocked";
  const status = [
    GOAL_STATE_TEXT[goal.state],
    ...(goal.reason ? [reasonText(goal.reason)] : []),
  ].join("：");
  return (
    <>
      {editor.editing ? (
        <form
          className="ch-goal-form"
          onSubmit={(e) => {
            e.preventDefault();
            editor.save();
          }}
        >
          <RichInput
            sessionId={sessionId}
            label="编辑长期目标"
            autoFocus
            rows={4}
            value={editor.text}
            onChange={editor.setText}
            sink={editor.files}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                editor.cancel();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                editor.save();
              }
            }}
          />
          <div className="ch-goal-max t-aux ch-dim">
            <span>轮数上限</span>
            <Input
              mono
              inputMode="numeric"
              aria-label="轮数上限"
              placeholder="不限"
              value={editor.max}
              onChange={(e) => editor.setMax(e.target.value)}
            />
          </div>
          {editor.why && (
            <p className="ch-err t-aux" role="alert">
              {editor.why}
            </p>
          )}
          <div className="ch-goal-act">
            <Button size="sm" variant="ghost" onClick={editor.cancel}>
              取消
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="submit"
              disabled={!editor.text.trim() || editor.maxInvalid}
            >
              保存
            </Button>
          </div>
        </form>
      ) : (
        <>
          {/* 单击不响应（保留划选），双击才进入编辑 */}
          <p className="t-plain ch-goal" onDoubleClick={editor.open}>
            {goal.text}
          </p>
          {goal.attachments && (
            <MessageAttachments
              sessionId={sessionId}
              attachments={goal.attachments}
            />
          )}
          <p className="t-aux ch-dim" data-goal-status={goal.state}>
            {goal.by === "model" ? "模型设定" : "你设定"} · 自{" "}
            {fmtDateTime(goal.since)} · {status} ·{" "}
            {roundsText(goal.rounds, goal.maxRounds)} 轮
          </p>
          {goal.reason?.detail && (
            <p className="t-aux ch-dim ch-goal-detail">{goal.reason.detail}</p>
          )}
          <div className="ch-goal-act">
            <Button
              size="sm"
              variant="ghost"
              data-goalact="edit"
              onClick={editor.open}
            >
              编辑
            </Button>
            {stopped ? (
              <Button
                size="sm"
                variant="ghost"
                data-goalact="resume"
                onClick={() => actions.resumeGoal()}
              >
                继续
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                data-goalact="pause"
                onClick={() => actions.pauseGoal()}
              >
                暂停
              </Button>
            )}
            <ConfirmButton
              size="sm"
              variant="ghost"
              data-goalact="del"
              armedLabel="确认删除"
              timeoutMs={3200}
              onConfirm={() => actions.clearGoal()}
            >
              删除
            </ConfirmButton>
          </div>
        </>
      )}
    </>
  );
}

// 计划：模型自己的待办，当前项脉动
export function PlanBody({ todos }: { todos: readonly Todo[] }) {
  return (
    <ul className="ch-plan">
      {todos.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 计划步骤可重名，按序位
        <li key={i} data-done={t.status === "completed" || undefined}>
          <span className="ch-plan-mark">
            <Tick
              done={t.status === "completed"}
              current={t.status === "in_progress"}
            />
          </span>
          <span className={t.status === "in_progress" ? "t-entry" : "t-plain"}>
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

const SOURCE = { library: "库", directory: "目录" } as const;
// 已加载能力：技能与 MCP 一行一个，悬停看来源（路径或失败原因）
export function CapsBody({ ctx }: { ctx: SessionContext }) {
  return (
    <>
      {ctx.skills.map((s) => (
        <ListRow
          key={`skill:${s.source}:${s.name}`}
          size="compact"
          label={s.name}
          trail={<span className="t-aux">技能</span>}
          data-cap="skill"
          peek={
            <PeekCard
              title={s.name}
              facts={[
                ["来源", SOURCE[s.source]],
                ["路径", s.path ?? "来源路径未提供"],
              ]}
            />
          }
        />
      ))}
      {ctx.mcp.map((m) => (
        <ListRow
          key={`mcp:${m.name}`}
          size="compact"
          lead={<Dot size="sm" tone={MCP_TONE[m.state]} />}
          label={m.name}
          trail={<span className="t-aux">MCP</span>}
          data-cap="mcp"
          data-state={m.state}
          peek={
            <PeekCard
              title={m.name}
              facts={[
                ["状态", MCP_STATE_TEXT[m.state]],
                ["工具", `${m.tools} 个`],
                ...(m.error ? ([["原因", m.error]] as const) : []),
              ]}
            />
          }
        />
      ))}
    </>
  );
}
