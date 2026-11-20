// 子代理给模型看的文字（框架口吻，英文）：开场说明、催交付、联系消息、交付 / 失败 / 停止的结果。
// 子代理自己写的话（summary、最后一条回复）总是放在框架的标题行之下，两者分开。
import { duration } from "../job/messages.js";
import type { Report } from "./collab.js";

/** 子会话的第一条 user 消息（两种上下文模式同一条路，不进系统提示词） */
export function openingBrief(o: {
  task: string;
  fork: boolean;
  depth: number;
  maxDepth: number;
  mode: string | null;
  /** 它在哪个目录里工作：引用写法与路径（与父会话看到的主机名一致） */
  where: { ref: string; path: string };
  /** 协作区：自己的子目录在虚拟主机 collab 里的路径（如 `/019a…`）；两种上下文模式都给 */
  collab?: { ownPath: string };
}): string {
  const head = [
    "You are a subagent dispatched by another agent session (your caller). Work independently on the task below.",
    o.fork
      ? "Everything before this message is inherited context, kept as read-only reference. It is not a conversation to continue: your task is the one below."
      : null,
  ];
  const rules = [
    "- Your caller cannot see your work in progress. When you are done, hand your result over with the deliver tool: { summary, report? }. summary is a short conclusion (at most 2000 characters); report is optional, for a long write-up: it is stored as a file and your caller receives its path. You can call deliver more than once; the last call wins, and it is sent when you end your turn. You cannot deliver while background jobs of yours are still running: wait for them or stop them with job_stop.",
    '- deliver may be missing from your tool list; if so, call it through call_tool { "name": "deliver", "arguments": { ... } } as described in the system state update.',
    "- You have no human approval channel: operations that need approval are refused. If an operation is refused, do not retry it. Choose another way, or say in your delivery what you could not do.",
    o.depth >= o.maxDepth
      ? `- You are at the maximum subagent depth (${o.maxDepth}): you cannot dispatch further subagents. Do the work yourself.`
      : `- You are at subagent depth ${o.depth} of ${o.maxDepth}. You may dispatch further subagents, but keep it to what the task needs.`,
    o.mode
      ? `- You work in the mode "${o.mode}", inherited from your caller; you cannot switch modes.`
      : null,
    `- You work in the directory ${o.where.ref} (${o.where.path}). Relative paths and commands start there. You cannot switch directories, and you can reach only that directory's host and the read-only attachment host; the host parameter of the file tools may be omitted.`,
    o.collab
      ? `- Shared folder: the virtual host collab. You can write files under ${o.collab.ownPath}/ (write and edit with host="collab", no approval needed); every session in this tree can read all of it (read, ls, find and grep with host="collab"). Use it for material that is too long for your delivery summary.`
      : null,
  ];
  return [
    ...head.filter(Boolean),
    ...rules.filter(Boolean),
    "",
    "Task:",
    o.task,
  ].join("\n");
}

/** 子代理停下却没交付、名下也没有在等的任务：催它交付 */
export const NUDGE_TEXT =
  "[System notice] You ended your turn without calling deliver, and none of your background jobs are still running. If your work is done, you must call deliver now with your conclusion (summary, and optionally report). If it is not done, continue working.";

/** 唤醒时对子代理说的话：调用方的原话放在标题行之下 */
export const callerMessage = (text: string): string =>
  `[Message from the session that dispatched you]\n${text}\nIf this changes your delivery, call deliver again; otherwise reply with exactly "work done".`;

/** 子代理运行中收到的追加消息（不要求重新交付） */
export const callerNote = (text: string): string =>
  `[Message from the session that dispatched you]\n${text}`;

export const isWorkDone = (text: string): boolean =>
  /^\s*work done\.?\s*$/i.test(text);

// 团队成员（team.md）与普通子代理共用这些结果文案：给了 member 就称「团队成员 名字」，联系方式换成 post。
const who = (id: string, member?: string) =>
  member === undefined ? `Subagent ${id}` : `Team member ${member}`;

const follow = (id: string, member?: string) =>
  member === undefined
    ? `Send it a follow-up with message_subagent { "id": "${id}", "text": ... } if you need more.`
    : `Send it a message with post { "to": "${member}", "text": ... } if you need more.`;

// 报告地址：调用方已经把 Server 的真实路径换算成虚拟主机 collab 里的路径（messages 不依赖 CollabArea）。
const reportLine = (r: Report | undefined, reportPath?: string) =>
  r
    ? `\nFull report: host="collab", path="${reportPath ?? r.path}" (${r.bytes} bytes). Read it only if you need the detail.`
    : "";

export const deliveredText = (
  id: string,
  summary: string,
  report?: Report,
  member?: string,
  reportPath?: string,
): string =>
  `[${who(id, member)} delivered]\n${summary}${reportLine(report, reportPath)}\n${follow(id, member)}`;

export const unchangedText = (id: string, member?: string): string =>
  `[${who(id, member)} handled your message; its earlier delivery is unchanged]\n${follow(id, member)}`;

export const undeliveredText = (
  id: string,
  last: string,
  member?: string,
): string =>
  `[${who(id, member)} finished without an explicit delivery; this is its last reply]\n${last || "(no text)"}\n${follow(id, member)}`;

export const failedText = (
  id: string,
  error: string,
  member?: string,
): string => `[${who(id, member)} failed]\n${error}`;

export const stoppedText = (id: string, member?: string): string =>
  `[${who(id, member)} was stopped]\nIt has no result. ${follow(id, member)}`;

/** 阻塞的 spawn 到了提醒时间：这次调用先返回，子代理继续跑 */
export const stillRunningText = (
  id: string,
  ranMs: number,
  remindMs: number,
): string =>
  `Subagent ${id} is still running after ${duration(ranMs)}. It was NOT stopped: it continues in the background as job ${id}. You will be notified when it delivers, and every ${duration(remindMs)} while it runs. Don't poll: do other work that does not overlap with it, or end your turn. Options: job_list { "id": "${id}" } to see its recent actions, message_subagent to tell it something, job_stop to stop it.`;

export const abortedWhileWaitingText = (id: string): string =>
  `Your call was interrupted while waiting. Subagent ${id} was NOT stopped: it continues in the background as job ${id}, and you will be notified when it delivers.`;
