import type { JobView } from "../job/tools.js";
import type { SubagentStore } from "../store/subagents.js";
import type { TeamStore } from "../store/teams.js";

/** 有队且成员全都没在运行：这时 lead 可以直接改公告板里已有的内容（team.md §3） */
export const membersIdle = (
  teams: TeamStore,
  subagents: SubagentStore,
  leadId: string,
): boolean =>
  teams.get(leadId) !== undefined &&
  teams
    .members(leadId)
    .every((m) => subagents.get(m.childId)?.state !== "running");

/** lead 的 job_list 里团队只占一行，成员的任务不逐个列出，停止走 team_stop（team.md §2） */
export function teamJobView(
  teams: TeamStore,
  subagents: SubagentStore,
): JobView {
  return {
    refusal: (row, tool) =>
      row.ref !== null && teams.member(row.ref) !== undefined
        ? `This job is a team member, not a plain job. ${tool === "job_stop" ? "Stop it with team_stop { member }" : "Manage it with the team_* tools; team_status shows it"}.`
        : null,
    lines: (owner) => {
      if (!teams.get(owner)) return [];
      const members = teams.members(owner);
      const running = members.filter(
        (m) => subagents.get(m.childId)?.state === "running",
      ).length;
      return [
        `team: ${members.length} member${members.length === 1 ? "" : "s"}, ${running} running (use team_status for details, team_stop to stop)`,
      ];
    },
  };
}
