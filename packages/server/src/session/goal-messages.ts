// 目标给模型看的文字（英文，框架口吻）：注入消息、收尾消息、三个工具的描述与结果。纯函数，便于单测。
import type { Goal } from "../store/session-state.js";
import { injectAttachmentMarkers } from "./attachments.js";
import { GOAL_MAX } from "./goal.js";

/** 收尾的两类原因：轮数用完、连续没有工具调用。 */
export type WrapUpReason =
  | { code: "round-limit"; max: number }
  | { code: "no-tool-calls"; rounds: number };

/** 宣布完成 / 受阻之后让模型接着写总结，不许再调工具。 */
export const WRAP_UP_INSTRUCTION =
  "Now write a short final message for the user: what was done, how it was verified, and what the user needs to do next (if anything). Mention only things you have evidence for in this session. Do not call any more tools.";

// 目标文本原样放进 <goal> 标签，自身出现的闭合标签要转义，否则多行文本能撕开这段框架。
const quoteGoal = (text: string): string =>
  text.replaceAll("</goal>", "<\\/goal>");

const roundHeader = (g: Goal, round: number): string =>
  g.maxRounds === null
    ? `[Goal round ${round}]`
    : `[Goal round ${round}/${g.maxRounds}]`;

/** 每轮注入的目标消息：目标文本只在这里出现，不再进系统提示。 */
export function roundMessage(g: Goal, round: number): string {
  const by = g.by === "user" ? "set by the user" : "set by you";
  return `${roundHeader(g, round)}
You have an active goal (${by}):
goal_id: ${g.id}, revision: ${g.revision}
<goal>
${injectAttachmentMarkers(quoteGoal(g.text), g.attachments ?? [])}
</goal>
Keep working toward it. Judge progress from the current workspace and tool results, not from what you said earlier.
Before you declare it complete, split the goal into concrete requirements and find evidence for each one in this session (file contents, command output, test results). If the evidence is weak or indirect, treat the requirement as not met.
When every requirement is met, call update_goal with action "complete". If a specific obstacle keeps you from making progress after repeated attempts, call update_goal with action "blocked" and describe the obstacle. Do not stop without calling one of the two.`;
}

/** harness 判定受阻时的收尾消息：说明原因，再写总结。 */
export function wrapUpMessage(reason: WrapUpReason): string {
  const why =
    reason.code === "round-limit"
      ? `The goal reached its round limit (${reason.max} rounds); it is now marked blocked. Summarize the progress so far and what remains.`
      : `The last ${reason.rounds} goal rounds made no tool calls; the goal is now marked blocked. Say what is stopping you.`;
  return `${why}
${WRAP_UP_INSTRUCTION}`;
}

export const GET_GOAL_DESCRIPTION = "Read the current goal and its state.";

export const CREATE_GOAL_DESCRIPTION =
  "Set a long-running goal for yourself when the task needs many steps or turns; you will be prompted again after each turn until you declare it complete or blocked. Only when no unfinished goal exists: if one is already set, update it instead.";

export const UPDATE_GOAL_DESCRIPTION =
  'Edit your own goal\'s text, or declare the goal complete or blocked. "complete" and "blocked" are accepted only during a goal round (or right after you created the goal), and "blocked" needs at least 3 rounds and a concrete reason. Pass the goal_id and revision from get_goal or from the goal message.';

export const NO_GOAL = "No goal is set.";

/** get_goal 的结果 */
export function goalText(g: Goal): string {
  const round =
    g.maxRounds === null
      ? `${g.rounds}/unlimited`
      : `${g.rounds}/${g.maxRounds}`;
  return [
    `goal_id: ${g.id}`,
    `revision: ${g.revision}`,
    `objective: ${g.text}`,
    ...(g.attachments ?? []).map((a) => `attachment: ${a.name} (${a.path})`),
    `set_by: ${g.by}`,
    `state: ${g.state}`,
    `round: ${round}`,
    ...(g.reason
      ? [
          `reason: ${g.reason.code}${g.reason.detail ? `: ${g.reason.detail}` : ""}`,
        ]
      : []),
  ].join("\n");
}

/** create_goal 的结果：说明之后会被继续驱动，并让它接着干活。 */
export function createdText(g: Goal): string {
  return `Goal ${g.id} created. After each of your turns the harness sends you the goal again, until you call update_goal with action "complete" or "blocked" (goal_id: ${g.id}, revision: ${g.revision}). Keep working toward it now.`;
}

/** update_goal 改了文本 / 上限 */
export function editedText(g: Goal): string {
  return `Goal ${g.id} updated (revision: ${g.revision}). Keep working toward it.`;
}

/** 模型宣布完成 / 受阻之后：状态已落定，再写总结 */
export function decidedText(g: Goal): string {
  return `Goal ${g.id} is now ${g.state}.\n${WRAP_UP_INSTRUCTION}`;
}

export const STALE_GOAL =
  "That goal_id or revision does not match the current goal. Call get_goal to read the current goal and its revision, then call update_goal again.";

export const USER_GOAL_LOCKED =
  "The goal was set by the user, so you can only declare it complete or blocked; ask the user to change its text.";

export const EDIT_NEEDS_OBJECTIVE =
  'action "edit" needs a non-empty objective.';

export const OUTSIDE_GOAL_ROUND =
  "complete and blocked are accepted only while a goal round is running (or right after you created the goal). Wait for the next goal message, then call update_goal again.";

export function blockTooEarly(minRounds: number, rounds: number): string {
  return `blocked needs at least ${minRounds} goal rounds in this start; only ${rounds} have run. Keep working, or ask the user for help.`;
}

export const BLOCK_NEEDS_REASON =
  'action "blocked" needs blocked_reason describing the concrete obstacle.';

export const OBJECTIVE_INVALID = `The objective must be non-empty text of at most ${GOAL_MAX} characters.`;

export const wrongState = (state: string | undefined): string =>
  `The goal is ${state ?? "missing"}, so it cannot be changed that way. Call get_goal to see its current state.`;

export const CREATE_EXISTS =
  "An unfinished goal already exists. Use update_goal to change it, or ask the user to clear it first.";
