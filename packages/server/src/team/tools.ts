// 团队的工具（team.md §2）：team_* 只有 lead 能用，post 是 lead 与成员共用的框架工具。
// 所有会话都注册它们（冻结声明要与 lead 逐字节相同才能共享缓存），谁能调用由运行时判断。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { JobError } from "../job/manager.js";
import type { SubagentHooks } from "../session/pool.js";
import { SUBAGENT_LIMITS } from "../subagent/limits.js";
import { SubagentError } from "../subagent/runtime.js";
import {
  type MemberInput,
  TEAM_LIMITS,
  TeamError,
  type TeamRuntime,
} from "./runtime.js";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

const memberSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        'Member name, unique in the team, used to address it with post. Letters, digits, "-" and "_", starting with a letter.',
    },
    agent: {
      type: "string",
      description:
        "Name or id of the Agent definition for this member (default: yours). Not allowed with context: fork.",
    },
    task: {
      type: "string",
      minLength: 1,
      maxLength: SUBAGENT_LIMITS.taskMax,
      description:
        "What this member is responsible for. Say which files or directories are theirs: the team shares one working directory.",
    },
    context: {
      type: "string",
      enum: ["fresh", "fork"],
      description:
        "fresh (default): an empty context, so write the task completely. fork: starts from your conversation so far, up to but not including the message that contains this call.",
    },
  },
  required: ["name", "task"],
} as const;

const CREATE_DESCRIPTION = `Create a team: several named members (subagents) that work in parallel, can message each other and share a bulletin board. Use it only when the members really need to coordinate on one piece of work; independent jobs are cheaper with plain subagents (spawn_subagent). Most coding work is less parallel than it looks: teams pay off for read-heavy collaboration, or when the split into files is clean.
The call returns at once; each member's delivery reaches you later as its own message, and you decide when the whole goal is met. The team shares your working directory with no isolation: write the split of files and directories into each task, and keep git to yourself (members never commit; review the combined changes with team_diff, then commit). Initial tasks are posted on the board for everyone; "note" is an optional first announcement for all. Only one team per session; members cannot create teams.`;

export function teamExtension(
  rt: TeamRuntime,
  sessionId: string,
): ExtensionFactory {
  // 失败抛 TeamError / SubagentError / JobError：信息直接给模型看；其余异常照常抛。
  const guard = async (
    run: () => Promise<{ text: string; isError?: boolean }>,
  ) => {
    try {
      const r = await run();
      return text(r.text, r.isError === true);
    } catch (e) {
      if (
        e instanceof TeamError ||
        e instanceof SubagentError ||
        e instanceof JobError
      )
        return text(e.message, true);
      throw e;
    }
  };

  return (pi) => {
    pi.registerTool({
      name: "team_create",
      label: "team_create",
      description: CREATE_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          members: {
            type: "array",
            minItems: 1,
            items: memberSchema,
            description: "The members to start",
          },
          note: {
            type: "string",
            maxLength: TEAM_LIMITS.postMax,
            description:
              "Optional first announcement for everyone (shared goal, conventions)",
          },
        },
        required: ["members"],
      } as never,
      async execute(toolCallId, params, signal, _update, ctx) {
        const p = params as { members: MemberInput[]; note?: string };
        return guard(() =>
          rt.create(
            sessionId,
            {
              members: p.members,
              ...(p.note !== undefined ? { note: p.note } : {}),
            },
            {
              toolCallId,
              signal,
              branch: ctx.sessionManager.getBranch() as never,
            },
          ),
        ) as never;
      },
    });

    pi.registerTool({
      name: "team_update",
      label: "team_update",
      description:
        "Add members to your team, and/or remove members that are not running (stop them first with team_stop). Existing members are told about new ones through the board.",
      parameters: {
        type: "object",
        properties: {
          add: { type: "array", items: memberSchema },
          remove: {
            type: "array",
            items: { type: "string" },
            description: "Names of members to remove from the roster",
          },
        },
      } as never,
      async execute(toolCallId, params, signal, _update, ctx) {
        const p = params as { add?: MemberInput[]; remove?: string[] };
        return guard(() =>
          rt.update(
            sessionId,
            {
              ...(p.add !== undefined ? { add: p.add } : {}),
              ...(p.remove !== undefined ? { remove: p.remove } : {}),
            },
            {
              toolCallId,
              signal,
              branch: ctx.sessionManager.getBranch() as never,
            },
          ),
        ) as never;
      },
    });

    pi.registerTool({
      name: "team_stop",
      label: "team_stop",
      description:
        "Stop the whole team, or one member by name. Whatever a stopped member started (background jobs, subagents) is stopped too. A stopped member stays on the roster; a post addressed to it wakes it up again. You are not notified about a stop you requested.",
      parameters: {
        type: "object",
        properties: {
          member: {
            type: "string",
            description: "Member name; omit to stop everyone",
          },
        },
      } as never,
      async execute(_id, params) {
        const p = params as { member?: string };
        return guard(() => rt.stop(sessionId, p.member)) as never;
      },
    });

    pi.registerTool({
      name: "team_status",
      label: "team_status",
      description:
        "Check on your team: each member's state and latest delivery, plus a short summary of the board. Use it when you want to verify progress; nothing is pushed to you automatically except deliveries and private messages.",
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        return guard(() => rt.status(sessionId)) as never;
      },
    });

    pi.registerTool({
      name: "team_diff",
      label: "team_diff",
      description:
        "See what the team changed since it was created, so you can review before you commit. Without path: the list of changed files with line counts. With path (relative to the working directory): that file's diff. In a git repository this includes changes made by shell commands; elsewhere only changes made with the write and edit tools are visible.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File to show the diff of; omit to list changed files",
          },
        },
      } as never,
      async execute(_id, params) {
        const p = params as { path?: string };
        return guard(() => rt.diff(sessionId, p.path)) as never;
      },
    });

    pi.registerTool({
      name: "team_disband",
      label: "team_disband",
      description:
        "Disband the team: stop all members (and what they started) and clear the roster. The board and the members' folders stay readable.",
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        return guard(() => rt.disband(sessionId)) as never;
      },
    });

    pi.registerTool({
      name: "post",
      label: "post",
      description:
        'Write to your team. Without "to": an announcement, appended to the board and pushed to all other members (not to the lead). With "to" set to a member name or "lead": a private message, not on the board. Never add your own name or a heading to the text: the framework adds them. Keep it short; long material goes into a file.',
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: TEAM_LIMITS.postMax,
            description: "The message",
          },
          to: {
            type: "string",
            description:
              'Member name or "lead" for a private message; omit for an announcement',
          },
        },
        required: ["text"],
      } as never,
      async execute(_id, params) {
        const p = params as { text: string; to?: string };
        return guard(() =>
          rt.post(sessionId, {
            text: p.text,
            ...(p.to !== undefined ? { to: p.to } : {}),
          }),
        ) as never;
      },
    });
  };
}
