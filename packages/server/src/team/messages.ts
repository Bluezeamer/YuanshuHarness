// 团队给模型看的文字（框架口吻，英文）：成员的开场说明、推送、工具结果。
import type { BriefContext } from "../subagent/runtime.js";

/**
 * 成员的开场消息。除最后几行（「你是谁」与自己的子目录）外所有成员逐字相同，包括公告板的初始内容，
 * 这样同一 Agent 的成员能共享缓存（team.md §3）。
 */
export function memberBrief(o: {
  name: string;
  board: string;
  ctx: BriefContext;
}): string {
  const { ctx } = o;
  const shared = [
    "You are a member of a team of agents working together on one goal. The session that created the team is the lead; it is also who your delivery goes to.",
    ctx.fork
      ? "Everything before this message is inherited context, kept as read-only reference. It is not a conversation to continue."
      : null,
    "",
    `Team board: host="collab", path="/board.md" (read it with the read tool whenever you want the overview). It only changes through the post tool, and the framework adds a heading like "## #12 · 14:03 · backend → all" to every entry: never write your own name or a heading in the text. Put only decisions that affect others, changes, bugs and completion on the board; details go into files in your own folder or into private messages.`,
    '- post { text, to? }: without "to" it is an announcement to all other members (they are notified, the lead is not). With "to" set to a member name or "lead" it is a private message (not on the board). If the lead\'s split of the work looks wrong or conflicts with yours, message the lead: discussion beats doing it wrong.',
    "- The team shares one working directory, with no isolation. Touch only the files and directories assigned to you in the tasks below. Do NOT commit, push, checkout or reset anything in git: the lead reviews the whole change and commits.",
    "- When your part is done, hand it over with deliver { summary, report? }: summary is a short conclusion (at most 2000 characters), report an optional long write-up stored as a file. You can call deliver more than once; the last call wins, and it is sent when you end your turn. Delivering is also recorded on the board for you.",
    '- After you have delivered, a new announcement or message may wake you. If it does not affect your delivery, reply with exactly "work done". Otherwise update your work and call deliver again.',
    '- deliver and post may be missing from your tool list; if so, call them through call_tool { "name": ..., "arguments": { ... } } as described in the system state update.',
    "- You have no human approval channel: operations that need approval are refused. If an operation is refused, do not retry it. Choose another way, or say in your delivery what you could not do.",
    ctx.depth >= ctx.maxDepth
      ? `- You are at the maximum subagent depth (${ctx.maxDepth}): you cannot dispatch further subagents.`
      : null,
    ctx.mode
      ? `- You work in the mode "${ctx.mode}", inherited from the lead; you cannot switch modes.`
      : null,
    ctx.collab
      ? `- Shared folder: the virtual host collab. Every session in the team can read all of it (read, ls, find and grep with host="collab").`
      : null,
    "",
    "Team board (initial content):",
    o.board.trim(),
  ];
  const own = [
    "",
    `You are "${o.name}". Do your part of the tasks on the board.`,
    ctx.collab
      ? `Your own folder, where you can write files without approval: host="collab", path="${ctx.collab.ownPath}/"`
      : null,
  ];
  return [...shared, ...own].filter((l) => l !== null).join("\n");
}

/** 板子摘要（辅助模型）的系统提示与用户消息：太长时只取最近的部分 */
export const BOARD_SUMMARY_SYSTEM =
  "You condense the bulletin board of a team of agents for the team lead. Reply with a short bullet list covering: decisions made, changes announced, bugs found, open questions. Use only what is on the board, invent nothing, and write no preamble.";

const BOARD_SUMMARY_MAX = 60_000;

export const boardSummaryPrompt = (board: string): string =>
  `Bulletin board:\n\n${board.length > BOARD_SUMMARY_MAX ? `(earlier entries omitted)\n${board.slice(-BOARD_SUMMARY_MAX)}` : board}`;

const WORK_DONE_TAIL =
  '\nIf this does not affect your delivery, reply with exactly "work done". Otherwise update your work and call deliver again.';

/** 公告推给成员；已交付被唤醒的那条要附上「work done」约定 */
export const announcementText = (
  seq: number,
  from: string,
  text: string,
  wake: boolean,
): string =>
  `[Team announcement #${seq} from ${from}]\n${text}${wake ? WORK_DONE_TAIL : ""}`;

export const privateText = (
  from: string,
  text: string,
  wake: boolean,
): string =>
  `[Private message from ${from === "lead" ? "the lead" : `team member ${from}`}]\n${text}${wake ? WORK_DONE_TAIL : ""}`;

export const createdText = (names: string[]): string =>
  `Team created with ${names.length} member${names.length === 1 ? "" : "s"}: ${names.join(", ")}. They are running now, and each member's delivery reaches you as a separate message; announcements on the board are not pushed to you, but private messages from members are. Do not poll: do other work that does not overlap with theirs, or end your turn. Use team_status when you want to check on everyone, and team_diff to see the combined changes before you commit. The board is host="collab", path="/board.md".`;
