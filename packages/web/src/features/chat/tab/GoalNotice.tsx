// 对话流里的目标卡片：续跑是很淡的一行，其余沿用系统回执的样子。

import type { GoalNotice } from "../../../api";
import { goalCard } from "./goalNotice";
import { Receipt } from "./Receipt";

export function GoalNoticeCard({ goal, ts }: { goal: GoalNotice; ts: string }) {
  const v = goalCard(goal, ts);
  if (v.line === "round")
    return (
      <div className="ch-goal-round t-aux" data-kind={v.kind}>
        {v.text}
        {v.time && <span className="t-mono">{v.time}</span>}
      </div>
    );
  return <Receipt r={v} />;
}
