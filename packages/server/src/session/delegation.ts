// 「子代理与模式」内置段（subagent.md §7）：我们生成的英文说明，用户不可改。
// 只在会话有相关工具时才有：能派发子代理，或有可切换的模式。它进冻结物，之后 Agent 清单或模式清单变了，
// 靠状态通知里的「段已变化」告诉模型（与其他我们生成的段同一条路）。

export const DELEGATION_TAG = "delegation";

export interface DelegationInput {
  /** 会话有 spawn_subagent */
  canSpawn: boolean;
  /** 会话有 team_create */
  canTeam: boolean;
  /** 会话有 workflow_run */
  canWorkflow: boolean;
  /** 会话是子代理：不能切模式 */
  isSubagent: boolean;
  /** 可切换的模式数（子代理继承来的模式也会算进去，所以子代理另有 isSubagent 判断） */
  modeCount: number;
  /** 可以派发的 Agent 定义；description 约定写成「何时该用我」 */
  agents: readonly { name: string; description: string }[];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function delegationSection(i: DelegationInput): string | null {
  const parts: string[] = [];
  if (i.canSpawn) {
    parts.push(
      [
        "You can delegate work to subagents.",
        "- spawn_subagent starts one. By default the call waits until the subagent delivers, and its delivery is the tool result. To run several in parallel, issue several spawn_subagent calls in the same message. If a subagent runs longer than remind_after, the call returns early and the subagent keeps running in the background; you are notified when it delivers.",
        "- Do NOT poll or sleep waiting for a subagent: do other work that does not overlap with it, or briefly tell the user it was dispatched and end your turn.",
        '- context "fresh" (default): the subagent starts from an empty context, so write the task completely. context "fork": it starts from your conversation so far, up to but not including the message that contains the call, so state your intent in the task.',
        "- A subagent has no approval channel (anything that needs approval is refused) and its permissions are never wider than yours. message_subagent talks to one you dispatched, or wakes one that has already delivered.",
        i.agents.length > 0
          ? `- Agent definitions you can dispatch (the agent parameter; default: your own):\n${i.agents
              .map(
                (a) =>
                  `  - ${a.name}${a.description.trim() ? `: ${oneLine(a.description)}` : ""}`,
              )
              .join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (i.canTeam && !i.isSubagent) {
    parts.push(
      [
        "You can create a team with team_create: named members that run in parallel, message each other with post, and share a bulletin board. A team is worth it only when the members must coordinate on one piece of work; independent jobs are cheaper as plain subagents.",
        "- The team shares your working directory with no isolation: put the split of files and directories into each member's task. Members never commit to git: review the combined changes with team_diff, then commit yourself.",
        "- A member's delivery reaches you as a message of its own. Board announcements are not pushed to you, private messages from members are. Check on everyone with team_status when you want to verify; the goal is done when you say so.",
      ].join("\n"),
    );
  }
  if (i.canWorkflow) {
    parts.push(
      "For large, fixed-shape work (dozens to hundreds of agents whose intermediate results you do not need to read), workflow_run runs a script that orchestrates the agents for you; its tool description explains the script API. Saved workflows can be found with workflow_list and run with the name parameter of workflow_run. Few parallel tasks are better as several spawn_subagent calls.",
    );
  }
  if (i.modeCount > 0 && !i.isSubagent) {
    parts.push(
      [
        "Modes: switch_mode changes your working mode, which can change your instructions and the tools you have. The user is asked to approve a switch; if refused, stay in the current mode.",
        i.canSpawn
          ? "A subagent inherits your current mode and cannot switch modes. Only when you have no active mode may you choose one for it with the mode parameter of spawn_subagent."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } else if (i.isSubagent && i.canSpawn) {
    parts.push(
      "You are a subagent: you work in the mode you inherited and cannot switch modes.",
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
